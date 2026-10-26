/**
 * 冒烟测试：turn 决策令牌 · HTTP 通道端到端（r33 固化）
 * verify-turn.mjs（tmp 目录、不进仓）的 8 项断言移植为正式冒烟——自起网关，不依赖外部进程：
 *   A. 视图带 turn；用 turn-1 提交 → 422 STALE_VIEW（且不入账）
 *   B. 用正确 turn 提交 → 200 且 applied；响应视图带新 turn
 *   C. 不带 turn → 不被令牌机制拦（向后兼容，同回合被 DUPLICATE_ACTION 拦属正常）
 *   D. 间隙期（相位已推进但 step 未开）用旧 turn → STALE_VIEW；用当前 turn → 缓冲入账
 * 运行：node --experimental-strip-types src/smoke-turn-http.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway/http.ts";

const PORT = 18814;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const g = new Gateway(join(tmpdir(), `arena-turn-smoke-${process.pid}.json`));
g.registerGame((await import("./games/dilemma.ts")).createDilemma());
g.listen(PORT);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(BASE + path, init);
  let j: Record<string, unknown> = {};
  try { j = (await r.json()) as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
const get = (p: string, tok: string): Promise<Resp> => api(p, { headers: { "x-seat-token": tok } });
const post = (p: string, body: unknown, tok?: string): Promise<Resp> =>
  api(p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { "x-seat-token": tok } : {}) },
    body: JSON.stringify(body),
  });

async function main(): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fetch(BASE + "/games");
      break;
    } catch {
      if (i > 50) throw new Error("网关未就绪");
      await sleep(50);
    }
  }

  console.log("=== Agent 游戏大厅 · turn 决策令牌（HTTP 通道）冒烟测试 ===\n");
  // dilemma 2 席：同时相位、每轮都是我的回合，最适合手控节奏
  const q = await post("/lobby/quickstart", { game: "dilemma", seats: 2, name: "turn-http-smoke" });
  const matchId = q.body.match_id as string;
  const tok = q.body.seat_token as string;
  check("quickstart 开局", typeof matchId === "string", matchId);

  const v1 = await get(`/matches/${matchId}/view`, tok);
  check("视图带 turn（number）", typeof v1.body.turn === "number", `turn=${v1.body.turn}`);
  const turn1 = v1.body.turn as number;

  // A. 陈旧令牌 → 422 STALE_VIEW 且不入账
  const stale = await post(`/matches/${matchId}/actions`, { action: { type: "move", choice: "cooperate" }, turn: turn1 - 1 }, tok);
  check("旧 turn 提交被拒 422 + STALE_VIEW", stale.status === 422 && String(stale.body.code) === "STALE_VIEW",
    `status=${stale.status} code=${stale.body.code}`);

  const fresh = await post(`/matches/${matchId}/actions`, { action: { type: "move", choice: "cooperate" }, turn: turn1 }, tok);
  check("被拒后同一步的正确 turn 仍可提交（拒收不入账）", fresh.status === 200 && fresh.body.applied === true,
    `status=${fresh.status} applied=${fresh.body.applied}`);
  check("响应视图带新 turn", typeof (fresh.body.view as { turn?: number } | undefined)?.turn === "number",
    `turn=${(fresh.body.view as { turn?: number } | undefined)?.turn}`);

  // C. 不带 turn 的旧客户端：令牌机制完全不介入
  const noTurn = await post(`/matches/${matchId}/actions`, { action: { type: "move", choice: "cooperate" } }, tok);
  check("不带 turn 不被令牌机制拦", noTurn.status === 200 || (noTurn.status === 422 && String(noTurn.body.code) === "DUPLICATE_ACTION"),
    `status=${noTurn.status} code=${noTurn.body.code}`);

  // D. 间隙期：等下一回合开启（视图 turn 已推进且本人 active），用「上一回合」的 turn 提交
  const turnAfter = (fresh.body.view as { turn?: number }).turn;
  let gapView: Record<string, unknown> | null = null;
  for (let i = 0; i < 80; i++) {
    const v = await get(`/matches/${matchId}/view`, tok);
    const you = v.body.you as { active?: boolean } | undefined;
    if (typeof v.body.turn === "number" && v.body.turn !== turnAfter && you?.active) { gapView = v.body; break; }
    await sleep(100);
  }
  if (!gapView) {
    check("间隙期取样（等待下一回合开启）", false, "超时未取到新回合视图");
  } else {
    const gapStale = await post(`/matches/${matchId}/actions`, { action: { type: "move", choice: "cooperate" }, turn: turnAfter }, tok);
    check("间隙期用旧 turn 提交被拒", gapStale.status === 422 && String(gapStale.body.code) === "STALE_VIEW",
      `status=${gapStale.status} code=${gapStale.body.code} 视图turn=${gapView.turn} 旧turn=${turnAfter}`);
    const gapFresh = await post(`/matches/${matchId}/actions`, { action: { type: "move", choice: "cooperate" }, turn: gapView.turn }, tok);
    check("间隙期用当前 turn 提交成功（由下一步缓冲入账）", gapFresh.status === 200 && gapFresh.body.applied === true,
      `status=${gapFresh.status} applied=${gapFresh.body.applied}`);
  }

  // 等对局自然终局（house bot 另一席自动打完），避免残留进行中对局
  for (let i = 0; i < 100; i++) {
    const v = await get(`/matches/${matchId}/view`, tok);
    if (v.body.phase === "finished" || v.body.result) break;
    await sleep(100);
  }

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[smoke-turn-http] 异常：", e);
  process.exit(1);
});
