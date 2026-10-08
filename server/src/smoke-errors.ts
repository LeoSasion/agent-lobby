/**
 * 冒烟测试：错误码矩阵（网关层全谱——r6 实测零错误码覆盖，r7 造错轮固化）
 * 覆盖：401 SEAT_TOKEN_INVALID / 404 MATCH_NOT_FOUND / 403 SEAT_INVALID /
 *       422 ILLEGAL_ACTION（空 body + 乱类型）/ DUPLICATE_ACTION /
 *       nonce 同回合幂等 / 跨回合 replayed / MATCH_FINISHED / applied+slim 响应
 * 时序敏感项（DUPLICATE/replayed/MATCH_FINISHED）用双人黑白棋房：双方均由本测试驱动，窗口稳定
 * 运行：node --experimental-strip-types src/smoke-errors.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway/http.ts";

const PORT = 18802;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const g = new Gateway(join(tmpdir(), `arena-errors-smoke-${process.pid}.json`));
g.registerGame((await import("./games/othello.ts")).createOthello());
g.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
g.registerGame((await import("./games/werewolf-lite.ts")).createWerewolfLite());
g.listen(PORT);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const post = (p: string, body: unknown, token?: string): Promise<Resp> =>
  api(p, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-seat-token": token } : {}),
    },
    body: JSON.stringify(body),
  });

interface OthView {
  phase?: string;
  you?: { active?: boolean };
  legal_actions?: { type: string; schema?: { values?: number[] } }[];
}

async function main(): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fetch(BASE + "/games");
      break;
    } catch {
      if (i > 50) throw new Error("网关未就绪");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // —— 阶段 A：骰子 quickstart（鉴权与非法动作，不依赖时序）——
  const qs = await post("/lobby/quickstart", { game: "liars_dice", seats: 3, name: "err-probe" });
  const diceMatch = String(qs.body.match_id);
  const diceToken = String(qs.body.seat_token);
  const DM = `/matches/${diceMatch}`;

  console.log("\n[矩阵 1] 鉴权与寻址");
  const bad = await api(`${DM}/view`, { headers: { "x-seat-token": "st_invalid" } });
  check(
    "无效 seat_token → 401 SEAT_TOKEN_INVALID",
    bad.status === 401 && String(bad.body.error).startsWith("SEAT_TOKEN_INVALID"),
    String(bad.body.error ?? "").slice(0, 24),
  );
  const nf = await api(`/matches/m_nope/view`, { headers: { "x-seat-token": diceToken } });
  check("不存在对局 → 404 MATCH_NOT_FOUND", nf.status === 404 && String(nf.body.error) === "MATCH_NOT_FOUND", "");
  const spec = await post(`${DM}/actions`, { action: { type: "challenge" } });
  check("观战者（无 token）提交 → 403 SEAT_INVALID", spec.status === 403 && String(spec.body.error) === "SEAT_INVALID", "");

  console.log("\n[矩阵 2] 动作合法性");
  const empty = await post(`${DM}/actions`, {}, diceToken);
  check(
    "空 body → 422 ILLEGAL_ACTION（可自纠）",
    empty.status === 422 && String(empty.body.code) === "ILLEGAL_ACTION" && Array.isArray(empty.body.legal_actions),
    String(empty.body.error ?? "").slice(0, 36),
  );
  const bogus = await post(`${DM}/actions`, { action: { type: "hack" } }, diceToken);
  check("未知动作类型 → 422 ILLEGAL_ACTION + code", bogus.status === 422 && String(bogus.body.code) === "ILLEGAL_ACTION", "");

  // —— 阶段 B：狼人杀 6 真人房（全测试驱动）——night 同时相位的 DUPLICATE 窗口稳定可控 ——
  console.log("\n[矩阵 3] DUPLICATE_ACTION（同时相位：先交者等其余行动者期间 submitted=true）");
  const wc = await post("/lobby/rooms", { game: "werewolf_lite", seats: 6, name: "err-ww-host" });
  const wRoom = String(wc.body.room_id);
  const wJoins = [String(wc.body.join_token)];
  for (let i = 2; i <= 6; i++) {
    const j = await post(`/lobby/rooms/${wRoom}/join`, { name: "err-ww-g" + i });
    wJoins.push(String(j.body.join_token));
  }
  const wSeats: string[] = [];
  for (const jt of wJoins) {
    const s = (await api(`/lobby/rooms/${wRoom}?token=${jt}`)).body;
    wSeats.push(String(s.seat_token));
  }
  const wMatch = String((await api(`/lobby/rooms/${wRoom}?token=${wJoins[0]}`)).body.match_id);
  const WM = `/matches/${wMatch}`;
  // night：找第一个 active 席（狼/预言家），提交 pass（其余夜间行动者不动 → 相位停在夜，窗口稳定）
  let actor = -1;
  for (let i = 0; i < 40 && actor < 0; i++) {
    await new Promise((r) => setTimeout(r, 200));
    for (let s = 0; s < 6; s++) {
      const v = (await api(`${WM}/view`, { headers: { "x-seat-token": wSeats[s]! } })).body as unknown as OthView;
      if (v.you?.active === true) {
        actor = s;
        break;
      }
    }
  }
  if (actor < 0) {
    check("找到夜间行动者（前置）", false, "40 次轮询无 active 席");
  } else {
    await post(`${WM}/actions`, { action: { type: "pass" }, nonce: "ww-dup-n1" }, wSeats[actor]!);
    const wdup = await post(`${WM}/actions`, { action: { type: "pass" }, nonce: "ww-dup-n2" }, wSeats[actor]!);
    check(
      "同时相位先交者重发（新 nonce）→ 422 DUPLICATE_ACTION",
      wdup.status === 422 && String(wdup.body.code) === "DUPLICATE_ACTION",
      `seat=${actor + 1} · ${String(wdup.body.error ?? "").slice(0, 30)}`,
    );
  }

  // —— 阶段 C：双人黑白棋房（applied/slim、nonce 幂等、跨回合 replayed、终局）——
  const cr = await post("/lobby/rooms", { game: "othello", name: "err-host" });
  const room = String(cr.body.room_id);
  const hostJoin = String(cr.body.join_token);
  const jr = await post(`/lobby/rooms/${room}/join`, { name: "err-guest" });
  const guestJoin = String(jr.body.join_token);
  const hs = (await api(`/lobby/rooms/${room}?token=${hostJoin}`)).body;
  const gs = (await api(`/lobby/rooms/${room}?token=${guestJoin}`)).body;
  const hostSeat = String(hs.seat_token);
  const guestSeat = String(gs.seat_token);
  const OM = `/matches/${String(hs.match_id)}`;

  console.log("\n[矩阵 3b] 幂等与轻量响应（双人房，窗口稳定）");
  // host（黑）开局即 active：提交第一步
  const hv0 = (await api(`${OM}/view`, { headers: { "x-seat-token": hostSeat } })).body as unknown as OthView;
  const firstCell = hv0.legal_actions?.[0]?.schema?.values?.[0];
  const ok1 = await post(`${OM}/actions`, { action: { type: "place", cell: firstCell }, nonce: "err-n1" }, hostSeat);
  const v1 = ok1.body.view as { history?: unknown[]; history_truncated?: boolean } | undefined;
  check(
    "合法提交 → 200 applied + slim view",
    ok1.status === 200 && ok1.body.applied === true && v1 !== undefined && v1.history?.length === 0 && v1.history_truncated === true,
    `cell=${String(firstCell)}`,
  );
  const dup = await post(`${OM}/actions`, { action: { type: "place", cell: firstCell }, nonce: "err-n2" }, hostSeat);
  check(
    "单席位相位重发 → 422（NOT_YOUR_TURN：相位已推进，快照语义正确）",
    dup.status === 422 && (String(dup.body.code) === "NOT_YOUR_TURN" || String(dup.body.code) === "DUPLICATE_ACTION"),
    `code=${String(dup.body.code)}`,
  );
  const idem = await post(`${OM}/actions`, { action: { type: "place", cell: firstCell }, nonce: "err-n1" }, hostSeat);
  check(
    "同回合同 nonce → 200 幂等（不消耗）",
    idem.status === 200 && idem.body.ok === true,
    `replayed=${String(idem.body.replayed ?? "?")}`,
  );

  // guest（白）行动一回合 → host 的 err-n1 成为跨回合旧 nonce
  const gv = (await api(`${OM}/view`, { headers: { "x-seat-token": guestSeat } })).body as unknown as OthView;
  const gCell = gv.legal_actions?.[0]?.schema?.values?.[0];
  await post(`${OM}/actions`, { action: { type: "place", cell: gCell }, nonce: "err-g1" }, guestSeat);
  const replayed = await post(`${OM}/actions`, { action: { type: "place", cell: firstCell }, nonce: "err-n1" }, hostSeat);
  check(
    "旧 nonce 跨回合重发 → 200 replayed:true（重放缓存）",
    replayed.status === 200 && replayed.body.replayed === true,
    `replayed=${String(replayed.body.replayed)}`,
  );

  console.log("\n[矩阵 4] 终局语义（打完双人房）");
  const tokens: Record<number, string> = { 1: hostSeat, 2: guestSeat };
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    let allDone = true;
    for (const seat of [1, 2]) {
      const v = (await api(`${OM}/view`, { headers: { "x-seat-token": tokens[seat]! } })).body as unknown as OthView;
      if (v.phase === "finished") continue;
      allDone = false;
      if (v.you?.active !== true) continue;
      const la = v.legal_actions?.[0];
      const action = la?.type === "place" ? { type: "place", cell: la.schema?.values?.[0] } : { type: "pass" };
      await post(`${OM}/actions`, { action }, tokens[seat]!);
    }
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  const fin = await post(`${OM}/actions`, { action: { type: "pass" } }, hostSeat);
  check("完赛后提交 → 422 MATCH_FINISHED", fin.status === 422 && String(fin.body.code) === "MATCH_FINISHED", "");
  const rep = await api(`${OM}/replay`, { headers: { "x-seat-token": hostSeat } });
  const repBody = rep.body as { finished?: boolean; scores?: unknown; seat_names?: Record<string, string>; events?: { ts?: number }[] };
  const tsOk = (repBody.events ?? []).every((e) => typeof e.ts === "number");
  check(
    "终局 replay：finished + scores + seat_names + 事件含 ts",
    repBody.finished === true && repBody.scores !== null && Object.keys(repBody.seat_names ?? {}).length >= 2 && tsOk,
    `${Object.keys(repBody.seat_names ?? {}).join(",")} · ts=${tsOk ? "OK" : "缺失"}`,
  );

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[smoke-errors] 异常：", e);
  process.exit(1);
});
