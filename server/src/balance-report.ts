/**
 * 游戏平衡统计验证（平台裁判视角）
 * 批量运行 bot 对 bot 对局，统计各方胜率，评估游戏是否平衡
 * 运行：node --experimental-strip-types src/balance-report.ts
 */

import { createLiarsDice } from "./games/liars-dice.ts";
import { createOthello } from "./games/othello.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createMatch } from "./arena/lobby.ts";
import { createRuleBot, createHangingBot } from "./bots/rule-bot.ts";
import { createOthelloBot } from "./bots/othello-bot.ts";
import { createWerewolfBot } from "./bots/werewolf-bot.ts";
import type { GameModule } from "./games/types.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { MatchEvent } from "./protocol.ts";

const WW_GAMES = 50;
const DICE_GAMES = 30;
const OTHELLO_GAMES = 20;

async function runBatch(
  label: string,
  game: GameModule<unknown>,
  makeBots: () => SeatDriver[],
  count: number,
): Promise<{ events: MatchEvent[] }[]> {
  const results: { events: MatchEvent[] }[] = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const r = await createMatch({
      game,
      drivers: makeBots(),
      seed: 1000 + i,
      timeoutMs: 20,
    }).run();
    results.push({ events: [...r.events] });
  }
  const dt = Date.now() - t0;
  console.log(`  ${label}: ${count} 局 · ${dt}ms · ${(dt / count).toFixed(0)}ms/局`);
  return results;
}

console.log("=== Agent 游戏大厅 · 游戏平衡统计报告 ===\n");

// —— 狼人杀：好人 vs 狼 胜率 ——
console.log("[狼人杀·简化] 6 席 bot 对 bot（50 局）");
const wwEvents = await runBatch("总计", createWerewolfLite(), () =>
  [0, 1, 2, 3, 4, 5].map((i) => createWerewolfBot(`ww-bot-${i}`, i)),
  WW_GAMES,
);
let wwWolfWin = 0;
let wwGoodWin = 0;
let wwStall = 0;
let wwRounds = 0;
const wwRoleWins: Record<string, number> = { werewolf: 0, seer: 0, villager: 0 };
for (const { events: evs } of wwEvents) {
  const won = evs.find((e) => e.type === "game_won");
  if (!won) { wwStall++; continue; }
  const winner = (won.data as { winner?: string }).winner;
  if (winner === "wolves") wwWolfWin++;
  else if (winner === "good") wwGoodWin++;
  const roles = (won.data as { roles?: Record<string, string> }).roles ?? {};
  for (const [seat, role] of Object.entries(roles)) {
    if ((winner === "wolves" && role === "werewolf") || (winner === "good" && role !== "werewolf")) {
      wwRoleWins[role] = (wwRoleWins[role] ?? 0) + 1;
    }
  }
  const nights = evs.filter((e) => e.type === "phase_started" && (e.data as { phase: string }).phase === "night").length;
  wwRounds += nights;
}
console.log(`  狼胜 ${wwWolfWin} · 好人胜 ${wwGoodWin} · 异常 ${wwStall}`);
console.log(`  狼胜率: ${((wwWolfWin / WW_GAMES) * 100).toFixed(1)}%（理想 40-55%）`);
console.log(`  平均天数: ${(wwRounds / WW_GAMES).toFixed(1)} 天`);
console.log(`  角色胜场: 狼=${wwRoleWins.werewolf} 预言家=${wwRoleWins.seer} 村民=${wwRoleWins.villager}`);
const wolfRate = wwWolfWin / WW_GAMES;
if (wolfRate > 0.65) console.log("  ⚠️ 狼胜率过高（>65%）——好人协作不足");
else if (wolfRate < 0.30) console.log("  ⚠️ 狼胜率过低（<30%）——狼伪装不足");
else console.log("  ✓ 平衡在合理区间");

// —— 吹牛骰：人格胜率 ——
console.log("\n[吹牛骰] 3 席 bot 对 bot（30 局）");
const diceEvents = await runBatch("总计", createLiarsDice(), () => [
  createRuleBot("谨慎", 0.3),
  createRuleBot("均衡", 0.5),
  createRuleBot("激进", 0.7),
], DICE_GAMES);
const diceWins: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
for (const { events: evs } of diceEvents) {
  const ended = evs.find((e) => e.type === "match_ended");
  if (!ended) continue;
  const scores = (ended.data as { scores?: Record<string, number> }).scores ?? {};
  for (const [seat, sc] of Object.entries(scores)) {
    if (sc === 1) diceWins[seat] = (diceWins[seat] ?? 0) + 1;
  }
}
console.log(`  胜场分布: 1号(谨慎)=${diceWins["1"]} · 2号(均衡)=${diceWins["2"]} · 3号(激进)=${diceWins["3"]}`);
const maxWins = Math.max(diceWins["1"], diceWins["2"], diceWins["3"]);
if (maxWins > DICE_GAMES * 0.55) console.log("  ⚠️ 某人格显著占优（>55%）");
else console.log("  ✓ 人格差异在合理范围");

// —— 黑白棋：风格胜率 ——
console.log("\n[黑白棋] 2 席 bot 对 bot（20 局）");
const othelloEvents = await runBatch("总计", createOthello(), () => [
  createOthelloBot("位置流", 0),
  createOthelloBot("吃子流", 1),
], OTHELLO_GAMES);
let othelloBlack = 0;
let othelloWhite = 0;
let othelloDraw = 0;
for (const { events: evs } of othelloEvents) {
  const ended = evs.find((e) => e.type === "match_ended");
  if (!ended) continue;
  const scores = (ended.data as { scores?: Record<string, number> }).scores ?? {};
  const s1 = scores["1"] ?? 0;
  const s2 = scores["2"] ?? 0;
  if (s1 > s2) othelloBlack++;
  else if (s2 > s1) othelloWhite++;
  else othelloDraw++;
}
console.log(`  黑(位置流)=${othelloBlack} · 白(吃子流)=${othelloWhite} · 平=${othelloDraw}`);
if (othelloBlack > OTHELLO_GAMES * 0.7) console.log("  ⚠️ 位置流显著占优");
else if (othelloWhite > OTHELLO_GAMES * 0.7) console.log("  ⚠️ 吃子流显著占优");
else console.log("  ✓ 风格差异在合理范围");

// —— 框架不变量抽检 ——
console.log("\n[框架不变量抽检] 全超时 + 确定性");
const dice = createLiarsDice();
const r1 = await createMatch({ game: dice, drivers: [createHangingBot("a"), createHangingBot("b")], seed: 42, timeoutMs: 15 }).run();
const r2 = await createMatch({ game: dice, drivers: [createHangingBot("a"), createHangingBot("b")], seed: 42, timeoutMs: 15 }).run();
const detStr = JSON.stringify(r1.events.map((e) => [e.seq, e.type])) === JSON.stringify(r2.events.map((e) => [e.seq, e.type]));
console.log(`  全超时完赛: ${r1.events.some((e) => e.type === "match_ended") ? "✓" : "✗"}`);
console.log(`  同 seed 确定性: ${detStr ? "✓" : "✗"}`);

console.log("\n=== 报告完毕 ===");
