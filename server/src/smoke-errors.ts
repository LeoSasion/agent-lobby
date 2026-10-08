/**
 * 冒烟测试：错误码矩阵（网关层全谱——r6 实测零错误码覆盖，r7 造错轮固化）
 * 覆盖：401 SEAT_TOKEN_INVALID / 404 MATCH_NOT_FOUND / 403 SEAT_INVALID /
 *       422 ILLEGAL_ACTION（空 body + 乱类型）/ DUPLICATE_ACTION /
 *       nonce 同回合幂等 / 跨回合 replayed / MATCH_FINISHED / applied+slim 响应 /
 *       votes_cast 相位进度实时性（r7 P0 修复回归，矩阵 3c）
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
  check(
    "不存在对局 → 404 MATCH_NOT_FOUND（附 match_id+path+hint，r8 F1）",
    nf.status === 404 &&
      String(nf.body.error) === "MATCH_NOT_FOUND" &&
      String(nf.body.match_id) === "m_nope" &&
      String(nf.body.path).includes("m_nope") &&
      String(nf.body.hint ?? "").length > 0,
    `path=${String(nf.body.path ?? "")}`,
  );
  const nr = await api(`/lobby/rooms/r_nope`);
  check(
    "不存在房间 → 404 ROOM_NOT_FOUND（附 room_id+path+hint，r8 F2）",
    nr.status === 404 && String(nr.body.code) === "ROOM_NOT_FOUND" && String(nr.body.room_id) === "r_nope" && String(nr.body.hint ?? "").length > 0,
    `path=${String(nr.body.path ?? "")}`,
  );
  const spec = await post(`${DM}/actions`, { action: { type: "challenge" } });
  check("观战者（无 token）提交 → 403 SEAT_INVALID", spec.status === 403 && String(spec.body.error) === "SEAT_INVALID", "");
  const rsOther = await api(`${DM}/replay/step?seat=2`);
  check(
    "replay/step 视角鉴权：无 token 看他人席位 → 403（r8 P0：曾泄露任意席位 private）",
    rsOther.status === 403 && String(rsOther.body.code) === "SEAT_INVALID" && String(rsOther.body.error) === "SEAT_INVALID",
    "",
  );
  const rsMine = await api(`${DM}/replay/step?seat=1`, { headers: { "x-seat-token": diceToken } });
  const mineView = rsMine.body as { view?: { you?: { seat?: number }; private?: Record<string, unknown> } };
  check(
    "replay/step 本人 token 看自身视角 → 200 + private",
    rsMine.status === 200 && mineView.view?.you?.seat === 1 && mineView.view?.private !== undefined,
    "",
  );
  const rsSpec = await api(`${DM}/replay/step`);
  const specView = rsSpec.body as { view?: { you?: { seat?: number }; private?: Record<string, unknown> } };
  check(
    "replay/step 省略 seat → 观战视角（private 恒空）",
    rsSpec.status === 200 && specView.view?.you?.seat === -1 && (specView.view?.private ? Object.keys(specView.view.private).length === 0 : true),
    "",
  );

  console.log("\n[矩阵 2] 动作合法性");
  const empty = await post(`${DM}/actions`, {}, diceToken);
  check(
    "空 body → 422 ILLEGAL_ACTION（可自纠）",
    empty.status === 422 && String(empty.body.code) === "ILLEGAL_ACTION" && Array.isArray(empty.body.legal_actions),
    String(empty.body.error ?? "").slice(0, 36),
  );
  const bogus = await post(`${DM}/actions`, { action: { type: "hack" } }, diceToken);
  check("未知动作类型 → 422 ILLEGAL_ACTION + code", bogus.status === 422 && String(bogus.body.code) === "ILLEGAL_ACTION", "");
  // r9 dc9-h1 遗留吸收：face 单独越界（qty 合法、face=7）——曾被 qty 越界用例短路吞掉
  const face7 = await post(`${DM}/actions`, { action: { type: "bid", qty: 2, face: 7 } }, diceToken);
  check(
    "face=7 单独越界 → 422 ILLEGAL_ACTION（face 合法区间提示）",
    face7.status === 422 && String(face7.body.code) === "ILLEGAL_ACTION" && String(face7.body.message).includes("face"),
    String(face7.body.message ?? "").slice(0, 40),
  );

  // r9：GET /agents/me + /agents/:id/matches（文档承诺曾 404——dc9-d1/dc9-d2/dc9-h1/w9-s2/w9-d1 五方报告）
  const qsApiKey = String(qs.body.api_key ?? "");
  const meBad = await api("/agents/me");
  check(
    "/agents/me 无 Bearer → 401 AUTH_INVALID",
    meBad.status === 401 && String(meBad.body.code) === "AUTH_INVALID",
    `status=${meBad.status}`,
  );
  const meOk = await api("/agents/me", { headers: { authorization: "Bearer " + qsApiKey } });
  check(
    "/agents/me 带 Bearer → 200 档案 + ratings",
    meOk.status === 200 && typeof meOk.body.agent_id === "string" && typeof meOk.body.name === "string" && typeof meOk.body.ratings === "object",
    `agent_id=${String(meOk.body.agent_id ?? "").slice(0, 10)}`,
  );
  const myMatches = await api(`/agents/${String(meOk.body.agent_id)}/matches`);
  check(
    "/agents/:id/matches → 200 战绩列表",
    myMatches.status === 200 && Array.isArray(myMatches.body.matches) && typeof myMatches.body.has_more === "boolean",
    `total=${String(myMatches.body.total)}`,
  );

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
  const wSeatIds: number[] = [];
  for (const jt of wJoins) {
    const s = (await api(`/lobby/rooms/${wRoom}?token=${jt}`)).body;
    wSeats.push(String(s.seat_token));
    wSeatIds.push(Number(s.seat_id));
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

  // —— 矩阵 3c：votes_cast 相位进度实时性（r7 P0 修复回归：内核提交缓冲注入 viewOf ctx）——
  // 修复前症状：投票窗口期 votes_cast 恒为 []（数据源 s.votes 要等批量 apply 才写入）。
  // 驱动该 6 人房：夜 → 白天发言 → 投票窗口只投一票，断言三重视角（自/他/观战）实时可见。
  console.log("\n[矩阵 3c] votes_cast 实时性（r7 P0 修复回归）");
  if (actor < 0) {
    check("前置：夜间行动者已找到", false, "跳过");
  } else {
    interface WWView {
      phase?: string;
      you?: { active?: boolean; submitted?: boolean };
      legal_actions?: { type: string; schema?: { values?: number[] } }[];
      public?: { votes_cast?: number[]; pending_voters?: number[] };
    }
    const viewOfSeat = async (i: number): Promise<WWView> =>
      (await api(`${WM}/view`, { headers: { "x-seat-token": wSeats[i]! } })).body as unknown as WWView;
    let votedOnce = false;
    let sawDayVote = false;
    const t0vc = Date.now();
    while (Date.now() - t0vc < 60000) {
      let finished = false;
      for (let s = 0; s < 6; s++) {
        const v = await viewOfSeat(s);
        if (v.phase === "finished") {
          finished = true;
          break;
        }
        if (v.you?.active !== true || v.you.submitted === true) continue;
        if (v.phase === "night") {
          await post(`${WM}/actions`, { action: { type: "pass" } }, wSeats[s]!);
        } else if (v.phase === "day_discuss") {
          await post(`${WM}/actions`, { action: { type: "say", text: "3c 冒烟发言" } }, wSeats[s]!);
        } else if (v.phase === "day_vote" && !votedOnce) {
          sawDayVote = true;
          votedOnce = true;
          const mySeat = wSeatIds[s]!;
          const la = v.legal_actions?.[0];
          const target = la?.type === "vote" ? (la.schema?.values?.[0] ?? mySeat) : mySeat;
          const resp = await post(`${WM}/actions`, { action: { type: "vote", target } }, wSeats[s]!);
          // (a) 提交响应回带的 slim view 即含 votes_cast（修复前恒为 []）
          const own = resp.body.view as WWView | undefined;
          check(
            "votes_cast：提交响应 view 即含本席位",
            Array.isArray(own?.public?.votes_cast) && (own!.public!.votes_cast as number[]).includes(mySeat),
            `cast=[${(own?.public?.votes_cast ?? []).join(",")}]`,
          );
          // (b) 另一未投票席位视角：cast 含本席位；pending 排除本席位且含观察者
          let otherOk = false;
          let pendOk = false;
          let detail = "";
          for (let t = 0; t < 6; t++) {
            if (t === s) continue;
            const ov = await viewOfSeat(t);
            if (ov.phase !== "day_vote" || ov.you?.submitted === true) continue;
            const cast = ov.public?.votes_cast ?? [];
            const pend = ov.public?.pending_voters ?? [];
            otherOk = cast.includes(mySeat);
            pendOk = !pend.includes(mySeat) && pend.includes(wSeatIds[t]!);
            detail = `cast=[${cast.join(",")}] pend=[${pend.join(",")}]`;
            break;
          }
          check("votes_cast：他人视角实时可见", otherOk, detail);
          check("pending_voters：排除已投者、含观察者自身", pendOk, detail);
          // (c) 观战视角（无 token）同样可见——公开字段不得按席位过滤
          const sv = (await api(`${WM}/view`)).body as unknown as WWView;
          check(
            "votes_cast：观战视角可见（公开字段）",
            (sv.public?.votes_cast ?? []).includes(mySeat),
            `cast=[${(sv.public?.votes_cast ?? []).join(",")}]`,
          );
        }
        // 投票断言完成后不再驱动其余投票者——本矩阵无需打完整局
      }
      if (finished || votedOnce) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    check("到达 day_vote 并完成单票三重断言", sawDayVote && votedOnce, sawDayVote ? "" : "60s 内未到投票相位");
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
  // r9 dc9-d1/dc9-h1 三方共识修复回归：replayed 响应 applied 必须 false——
  // 本次请求未发生任何新入账（原动作在旧回合已结算），applied:true 会让客户端
  // 误判"本回合已提交"从而跳过当前回合（实测真发生过）
  check(
    "r9 回归：replayed 响应 applied:false（未发生新入账）",
    replayed.body.applied === false,
    `applied=${String(replayed.body.applied)}`,
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
  const repBody = rep.body as { finished?: boolean; scores?: unknown; seat_names?: Record<string, string>; events?: { ts?: number; type?: string; submitted_at?: number }[] };
  const tsOk = (repBody.events ?? []).every((e) => typeof e.ts === "number");
  // r7：acted/timed_out 顶层 submitted_at（实际入账时刻）——批量结算 ts 全同，靠它区分提交先后
  const actedEvents = (repBody.events ?? []).filter((e) => e.type === "acted" || e.type === "timed_out");
  const submittedAtOk = actedEvents.length > 0 && actedEvents.every((e) => typeof e.submitted_at === "number");
  check(
    "终局 replay：finished + scores + seat_names + 事件含 ts",
    repBody.finished === true && repBody.scores !== null && Object.keys(repBody.seat_names ?? {}).length >= 2 && tsOk,
    `${Object.keys(repBody.seat_names ?? {}).join(",")} · ts=${tsOk ? "OK" : "缺失"}`,
  );
  check(
    "acted/timed_out 含 submitted_at（r7 观测元数据）",
    submittedAtOk,
    `${actedEvents.length} 条 acted/timed_out`,
  );

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[smoke-errors] 异常：", e);
  process.exit(1);
});
