/**
 * 冒烟测试：黑白棋 + Elo
 * 覆盖：开局合法着法数 / 完整对局 / 确定性 / 回放 / 信息隔离（完全信息游戏 private 恒空）/ Elo 数值
 * 运行：node --experimental-strip-types src/smoke-othello.ts
 */

import { createOthello } from "./games/othello.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { expectedScore, RatingStore } from "./arena/rating.ts";
import { createOthelloBot } from "./bots/othello-bot.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const game = createOthello();
console.log("=== Agent 游戏大厅 · 黑白棋 + Elo 冒烟测试 ===\n");

// —— 场景 A：开局不变量 ——
console.log("[场景 A] 开局不变量");
const s0 = game.init([1, 2], () => 0.5);
const opening = game.legalActions(s0, 1);
const openingCells = (opening[0]?.schema?.values ?? []) as number[];
check("黑方开局恰有 4 个合法落点", opening.length === 1 && openingCells.length === 4, JSON.stringify(openingCells));
const snap0 = game.viewOf(s0, "spectator").public as unknown as { counts: { black: number; white: number } };
check("开局棋盘 4 子且轮到黑", snap0.counts.black === 2 && snap0.counts.white === 2 && game.activeSeats(s0)[0] === 1);
check("有落点时 pass 非法", game.validate(s0, 1, { type: "pass" }).ok === false);

// —— 场景 B：两 bot 完整对局 ——
console.log("\n[场景 B] 完整对局：位置流 vs 吃子流");
const violations: string[] = [];
function withIsolationCheck(inner: SeatDriver): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      if (Object.keys(view.private).length !== 0) violations.push(`seat${view.you.seat}: private 应为空`);
      const b = view.public.board;
      if (!Array.isArray(b) || b.length !== 64) violations.push(`seat${view.you.seat}: board 非法`);
      await inner.act(view, submit);
    },
  };
}
const bots = [withIsolationCheck(createOthelloBot("bot-位置流", 0)), withIsolationCheck(createOthelloBot("bot-吃子流", 1))];
const r1 = await createMatch({ game, drivers: bots, seed: 1 }).run();
const moves = r1.events.filter((e) => e.type === "placed").length;
const passes = r1.events.filter((e) => e.type === "passed").length;
const sumScores = Object.values(r1.scores).reduce((a, b) => a + b, 0);
check("对局完整结束", sumScores === 1, `${moves} 手 · ${passes} 次虚着 · 分数 ${JSON.stringify(r1.scores)}`);
check("信息隔离：完全信息游戏 private 恒为空", violations.length === 0, violations.length ? violations[0] : "0 违规");

// —— 场景 C：确定性与回放 ——
console.log("\n[场景 C] 确定性与回放");
const r2 = await createMatch({
  game,
  drivers: [createOthelloBot("bot-位置流", 0), createOthelloBot("bot-吃子流", 1)],
  seed: 1,
}).run();
check("重跑事件序列完全一致", hashEvents(r1.events) === hashEvents(r2.events), `hash=${hashEvents(r1.events)}`);
const rp = replayEvents(game, r1.events);
check("回放终局分数一致", JSON.stringify(rp.scores) === JSON.stringify(r1.scores));
check("回放游戏事件一致", JSON.stringify(rp.gameEvents) === JSON.stringify(r1.gameEvents), `${rp.gameEvents.length} 个游戏事件`);

// —— 场景 D：Elo 数值 ——
console.log("\n[场景 D] Elo 数值");
check("期望得分公式", Math.abs(expectedScore(1200, 1400) - 0.2403) < 0.001, `exp(1200,1400)=${expectedScore(1200, 1400).toFixed(4)}`);
const rs = new RatingStore();
const d1 = rs.applyMatch("t", new Map([[1, "A"], [2, "B"]]), { 1: 1, 2: 0 });
check("同级 2 人局：胜 +20 / 负 -20（K=40）", d1[0].delta === 20 && d1[0].new === 1220 && d1[1].delta === -20 && d1[1].new === 1180);
const rs3 = new RatingStore();
const d3 = rs3.applyMatch("t3", new Map([[1, "A"], [2, "B"], [3, "C"]]), { 1: 1, 2: 0, 3: 0 });
check("同级 3 人局：胜 +20 / 负各 -20", d3[0].delta === 20 && d3[1].delta === -20 && d3[2].delta === -20);
const rsK = new RatingStore();
rsK.record("t4", "A").games = 10;
rsK.record("t4", "B").games = 10;
const d4 = rsK.applyMatch("t4", new Map([[1, "A"], [2, "B"]]), { 1: 1, 2: 0 });
check("定级期后 K=20：胜 +10", d4[0].delta === 10 && d4[0].new === 1210);
const rsD = new RatingStore();
const d5 = rsD.applyMatch("t5", new Map([[1, "A"], [2, "B"]]), { 1: 0.5, 2: 0.5 });
check("和棋双方 ±0（同级）", d5[0].delta === 0 && d5[1].delta === 0);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
