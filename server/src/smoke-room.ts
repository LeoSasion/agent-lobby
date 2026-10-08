/**
 * 冒烟测试：多人房间（创建/加入/满员自动开局/房主强制开局 bot 补位/Webhook 通道进房）
 * 运行：node --experimental-strip-types src/smoke-room.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Gateway } from "./gateway/http.ts";

const PORT = 18798;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const g = new Gateway(join(tmpdir(), `arena-room-smoke-${process.pid}.json`));
g.registerGame((await import("./games/othello.ts")).createOthello());
g.registerGame((await import("./games/werewolf-lite.ts")).createWerewolfLite());
g.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
g.listen(PORT);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const post = (p: string, body: unknown, bearer?: string): Promise<Resp> =>
  api(p, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
    },
    body: JSON.stringify(body),
  });

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

  // —— 场景 1：双真人黑白棋（满员自动开局 + 完整对局）——
  console.log("\n[场景 1] 双真人黑白棋 · 满员自动开局");
  const cr = await post("/lobby/rooms", { game: "othello", name: "room-host" });
  check("创建房间", cr.status === 201 && cr.body.status === "waiting", `players=${String(cr.body.players)}`);
  const roomId = String(cr.body.room_id);
  const hostToken = String(cr.body.join_token);

  const j2 = await post(`/lobby/rooms/${roomId}/join`, { name: "room-guest" });
  check("第 2 人加入即满员自动开局", j2.status === 200 && j2.body.status === "started", `players=${String(j2.body.players)}`);

  const s1 = await api(`/lobby/rooms/${roomId}?token=${hostToken}`);
  const s2 = await api(`/lobby/rooms/${roomId}?token=${String(j2.body.join_token)}`);
  check(
    "双方各取到座位分配",
    s1.body.seat_id === 1 && s2.body.seat_id === 2 &&
      typeof s1.body.seat_token === "string" && typeof s2.body.seat_token === "string" &&
      s1.body.match_id === s2.body.match_id,
    `seats=${String(s1.body.seat_id)}/${String(s2.body.seat_id)}`,
  );

  // 双方都由本测试驱动：谁 active 谁下第一个合法点，直至终局
  const seatTokens: Record<number, string> = { 1: String(s1.body.seat_token), 2: String(s2.body.seat_token) };
  const matchId = String(s1.body.match_id);
  let finished = false;
  let moves = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    let allDone = true;
    for (const seat of [1, 2]) {
      const v = await api(`/matches/${matchId}/view`, { headers: { "x-seat-token": seatTokens[seat]! } });
      const view = v.body as { phase?: string; you?: { active?: boolean }; legal_actions?: { type: string; schema?: { values?: number[] } }[] };
      if (view.phase === "finished") continue;
      allDone = false;
      if (view.you?.active !== true) continue;
      const la = view.legal_actions?.[0];
      const action = la?.type === "place" ? { type: "place", cell: la.schema?.values?.[0] } : { type: "pass" };
      const r = await api(`/matches/${matchId}/actions`, {
        method: "POST",
        headers: { "x-seat-token": seatTokens[seat]!, "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (r.status === 200) moves++;
    }
    if (allDone) {
      finished = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  const rep = await api(`/matches/${matchId}/replay`, { headers: { "x-seat-token": seatTokens[1]! } });
  check("双真人完整对局（终局双方可见）", finished, `${moves} 手 · ${Date.now() - t0}ms`);
  check("终局比分非空", rep.body.scores !== null && typeof rep.body.scores === "object", JSON.stringify(rep.body.scores));

  // —— 场景 2：满员后再加入被拒 ——
  console.log("\n[场景 2] 满员房间拒绝加入");
  const full = await post(`/lobby/rooms/${roomId}/join`, { name: "late-bird" });
  check("ROOM_FULL 409", full.status === 409 && String(full.body.error).startsWith("ROOM_FULL"), `code=${String(full.body.error ?? "").slice(0, 24)}`);

  // —— 场景 3：房主强制开局，余位 bot 补齐 ——
  console.log("\n[场景 3] 房主强制开局 · bot 补位");
  const w = await post("/lobby/rooms", { game: "werewolf_lite", name: "lone-wolf-host" });
  const wRoom = String(w.body.room_id);
  const wToken = String(w.body.join_token);
  const st = await post(`/lobby/rooms/${wRoom}/start`, { join_token: wToken });
  check(
    "1 真人 + 5 bot 强制开局",
    st.status === 200 && st.body.status === "started" && st.body.bots_filled === 5 && st.body.seat_id === 1,
    `bots=${String(st.body.bots_filled)}`,
  );
  const wv = await api(`/matches/${String(st.body.match_id)}/view`, { headers: { "x-seat-token": String(st.body.seat_token) } });
  check("对局视图可获取", wv.status === 200 && typeof wv.body.phase === "string", `phase=${String(wv.body.phase)}`);
  const wrong = await post(`/lobby/rooms/${String(w.body.room_id)}/start`, { join_token: "jt_fake" });
  check("非房主强制开局被拒", wrong.status === 403, `code=${String(wrong.body.error ?? "").slice(0, 20)}`);

  // —— 场景 4：房间列表 ——
  const list = await api("/lobby/rooms");
  const listed = (list.body.rooms as { room_id: string }[]) ?? [];
  check("房间列表含已开房间", listed.some((r) => r.room_id === roomId) && listed.some((r) => r.room_id === wRoom), `${listed.length} 间`);

  // —— 场景 5：Webhook 通道进房（错误路径 + 混合通道完整对局）——
  console.log("\n[场景 5] Webhook 通道进房 · 混合通道对局");
  // 5a. 错误路径：无 Bearer / 未注册 callback
  const noAuth = await post("/lobby/rooms", { game: "othello", name: "wh-noauth", channel: "webhook" });
  check(
    "webhook 无 Bearer 被拒 401",
    noAuth.status === 401 && String(noAuth.body.error).startsWith("WEBHOOK_AUTH_REQUIRED"),
    String(noAuth.body.error ?? "").slice(0, 24),
  );
  const plain = await post("/agents", { name: "no-callback-agent" });
  const noCb = await post("/lobby/rooms", { game: "othello", name: "wh-nocb", channel: "webhook" }, String(plain.body.api_key));
  check(
    "webhook 无 callback 被拒 400",
    noCb.status === 400 && String(noCb.body.error).startsWith("WEBHOOK_NOT_REGISTERED"),
    String(noCb.body.error ?? "").slice(0, 26),
  );

  // 5b. 本地回调服务器：验签 + 回第一个合法动作（黑白棋 place/pass）
  let whSecret = "";
  let deliveries = 0;
  let sigFailures = 0;
  const CB_PORT = PORT + 1;
  const cbServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      deliveries++;
      const got = String(req.headers["x-arena-signature"] ?? "");
      const expect = "sha256=" + createHmac("sha256", whSecret).update(raw).digest("hex");
      if (got !== expect) sigFailures++;
      let action: { type: string; cell?: number } = { type: "pass" };
      try {
        const body = JSON.parse(raw) as { view?: { legal_actions?: { type: string; schema?: { values?: number[] } }[] } };
        const la = body.view?.legal_actions?.[0];
        if (la?.type === "place" && Array.isArray(la.schema?.values) && la.schema.values.length > 0) {
          action = { type: "place", cell: la.schema.values[0] };
        }
      } catch { /* 保持 pass */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ action }));
    });
  });
  await new Promise<void>((r) => cbServer.listen(CB_PORT, "127.0.0.1", r));

  const reg = await post("/agents", { name: "wh-room-agent", callback_url: `http://127.0.0.1:${CB_PORT}/arena` });
  whSecret = String(reg.body.webhook_secret);
  const whKey = String(reg.body.api_key);
  const wr = await post("/lobby/rooms", { game: "othello", name: "wh-host", channel: "webhook" }, whKey);
  check(
    "webhook 房主建房（响应标明通道）",
    wr.status === 201 && wr.body.status === "waiting" && wr.body.channel === "webhook",
    `channel=${String(wr.body.channel)}`,
  );
  const wg = await post(`/lobby/rooms/${String(wr.body.room_id)}/join`, { name: "http-guest" });
  check("http 玩家加入即满员开局（混合通道）", wg.status === 200 && wg.body.status === "started", "");

  const gs = await api(`/lobby/rooms/${String(wr.body.room_id)}?token=${String(wg.body.join_token)}`);
  const guestToken = String(gs.body.seat_token);
  const gMatch = String(gs.body.match_id);
  // webhook 席位（seat 1）由平台推送驱动；http 席位（seat 2）轮询下棋
  let mixedFinished = false;
  let guestMoves = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    const v = await api(`/matches/${gMatch}/view`, { headers: { "x-seat-token": guestToken } });
    const view = v.body as { phase?: string; you?: { active?: boolean }; legal_actions?: { type: string; schema?: { values?: number[] } }[] };
    if (view.phase === "finished") {
      mixedFinished = true;
      break;
    }
    if (view.you?.active === true) {
      const la = view.legal_actions?.[0];
      const action = la?.type === "place" ? { type: "place", cell: la.schema?.values?.[0] } : { type: "pass" };
      const r = await api(`/matches/${gMatch}/actions`, {
        method: "POST",
        headers: { "x-seat-token": guestToken, "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (r.status === 200) guestMoves++;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  check("混合通道完整对局", mixedFinished, `${guestMoves} 手 http · ${deliveries} 次推送 · ${Date.now() - t1}ms`);
  check("webhook 推送送达且验签通过", deliveries > 0 && sigFailures === 0, `deliveries=${deliveries} · sigFail=${sigFailures}`);
  const evs = await api(`/matches/${gMatch}/events`);
  const hostTimeouts = ((evs.body.events as { type: string; data?: { seat?: number } }[]) ?? [])
    .filter((e) => e.type === "timed_out" && e.data?.seat === 1);
  check("webhook 座位无超时（回调自动应答）", hostTimeouts.length === 0, `${hostTimeouts.length} 次`);
  cbServer.close();

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[smoke-room] 异常：", e);
  process.exit(1);
});
