/**
 * 游戏平衡统计验证（平台裁判视角）
 * 批量运行 bot 对 bot 对局，统计各方胜率，评估游戏是否平衡
 * 运行：node --experimental-strip-types src/balance-report.ts
 *
 * 覆盖六款游戏。r30e 补上 dilemma 与 undercover —— 此前只有四款，
 * 而卧底是「多数人获胜制」（平民 5/6 胜），最易出零和偏差，却长期在监控盲区。
 */

import { createLiarsDice } from "./games/liars-dice.ts";
import { createOthello } from "./games/othello.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createHoldemLite } from "./games/holdem-lite.ts";
import { createDilemma } from "./games/dilemma.ts";
import { createUndercover } from "./games/undercover.ts";
import { createAuction } from "./games/auction.ts";
import { createTurtleSoup } from "./games/turtle-soup.ts";
import { createMatch } from "./arena/lobby.ts";
import { createRuleBot, createHangingBot } from "./bots/rule-bot.ts";
import { createOthelloBot } from "./bots/othello-bot.ts";
import { createWerewolfBot } from "./bots/werewolf-bot.ts";
import { createHoldemBot } from "./bots/holdem-bot.ts";
import { createDilemmaBot } from "./bots/dilemma-bot.ts";
import { createUndercoverBot } from "./bots/undercover-bot.ts";
import { createAuctionBot } from "./bots/auction-bot.ts";
import { createTurtleBot } from "./bots/turtle-bot.ts";
import type { GameModule } from "./games/types.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { MatchEvent } from "./protocol.ts";

const WW_GAMES = 50;
const DICE_GAMES = 30;
const OTHELLO_GAMES = 20;
const HOLDEM_GAMES = 40;
const DILEMMA_GAMES = 30;
const UC_GAMES = 30;

/** 百分比格式化：分母为 0 时给 "—" 而不是 NaN（排障工具最不该在异常时输出 NaN） */
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

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

// —— 德州扑克·简化：风格胜率 ——
console.log("\n[德州扑克·简化] 3 席 bot 对 bot（40 局）");
const HOLDEM_STYLES: [string, number][] = [
  ["紧凶", 0.3],
  ["松凶", 0.8],
  ["稳健", 0.5],
];
const holdemEvents = await runBatch("总计", createHoldemLite(), () =>
  HOLDEM_STYLES.map(([n, a]) => createHoldemBot(n, a)),
  HOLDEM_GAMES,
);
const holdemWins: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
let holdemHands = 0;
let holdemShowdowns = 0;
let holdemLastStanding = 0;
let holdemHandLimit = 0;
for (const { events: evs } of holdemEvents) {
  const ended = evs.find((e) => e.type === "match_ended");
  if (!ended) continue;
  const scores = (ended.data as { scores?: Record<string, number> }).scores ?? {};
  for (const [seat, sc] of Object.entries(scores)) {
    if (sc === 1) holdemWins[seat] = (holdemWins[seat] ?? 0) + 1;
  }
  holdemHands += evs.filter((e) => e.type === "hand_ended").length;
  holdemShowdowns += evs.filter((e) => e.type === "showdown").length;
  const ge = evs.find((e) => e.type === "game_ended");
  const reason = (ge?.data as { reason?: string } | undefined)?.reason;
  if (reason === "last_standing") holdemLastStanding++;
  else if (reason === "hand_limit") holdemHandLimit++;
}
console.log(`  胜场分布: 1号(紧凶)=${holdemWins["1"]} · 2号(松凶)=${holdemWins["2"]} · 3号(稳健)=${holdemWins["3"]}`);
// r30c：holdemHands 为 0 时（异常局全部无 hand_ended）除法得 NaN，报告会打出「摊牌率 NaN%」——
// 报告本身是排障工具，最不该在生产异常时输出 NaN，故统一走 pct()（分母为 0 给 "—"）
const showdownRate = pct(holdemShowdowns, holdemHands);
console.log(`  平均手数: ${(holdemHands / HOLDEM_GAMES).toFixed(1)} · 摊牌率 ${showdownRate} · 终局: 清台 ${holdemLastStanding} / 手数上限 ${holdemHandLimit}`);
const holdemMax = Math.max(holdemWins["1"], holdemWins["2"], holdemWins["3"]);
if (holdemMax > HOLDEM_GAMES * 0.55) console.log("  ⚠️ 某风格显著占优（>55%）");
else console.log("  ✓ 风格差异在合理范围");

// —— 囚徒困境：合作率与「背叛是否被惩罚」 ——
// 设计意图：TFT 一旦被背叛就永久报复，AllD 永不改口 ⇒ 单方背叛（CD）只可能出现在第 1 轮。
// 若 CD 分布在多轮，说明 TFT 的报复逻辑坏了 —— 这是本段唯一真能失败的不变量。
console.log("\n[囚徒困境·迭代] 2 席 bot 对 bot（30 局）");
const dilemmaEvents = await runBatch("总计", createDilemma(), () => [
  createDilemmaBot("一报还一报", "tft"),
  createDilemmaBot("永久背叛", "betray"),
], DILEMMA_GAMES);
let dCC = 0, dDD = 0, dCD = 0, dLateCD = 0;
let dSeat1 = 0, dSeat2 = 0, dDraw = 0;
for (const { events: evs } of dilemmaEvents) {
  for (const e of evs) {
    if (e.type !== "round_resolved") continue;
    const d = e.data as { pattern?: string; round?: number };
    if (d.pattern === "CC") dCC++;
    else if (d.pattern === "DD") dDD++;
    else if (d.pattern === "CD") { dCD++; if ((d.round ?? 0) > 1) dLateCD++; }
  }
  const w = (evs.find((e) => e.type === "game_won")?.data as { winner?: unknown } | undefined)?.winner;
  if (w === 1) dSeat1++;
  else if (w === 2) dSeat2++;
  else dDraw++;
}
const dRounds = dCC + dDD + dCD;
console.log(`  回合构成: 双合作 ${pct(dCC, dRounds)} · 双背叛 ${pct(dDD, dRounds)} · 单方背叛 ${pct(dCD, dRounds)}`);
console.log(`  胜负: 1号(一报还一报)=${dSeat1} · 2号(永久背叛)=${dSeat2} · 平=${dDraw}`);
if (dLateCD > 0) console.log(`  ⚠️ 第 2 轮后仍出现单方背叛 ${dLateCD} 次 —— TFT 报复逻辑失效`);
else console.log("  ✓ 单方背叛仅出现在首轮（背叛被有效惩罚）");
if (dSeat2 === 0) console.log("  ⚠️ 永久背叛未能占优 —— 收益结算可能反了");

// —— 谁是卧底：卧底 vs 平民胜率 ——
console.log("\n[谁是卧底] 6 席 bot 对 bot（30 局）");
const ucEvents = await runBatch("总计", createUndercover(), () =>
  [0, 1, 2, 3, 4, 5].map((i) => createUndercoverBot(`uc-bot-${i}`, i)),
  UC_GAMES,
);
let ucUndercover = 0;
let ucCivilian = 0;
let ucStall = 0;
let ucVoteRounds = 0;
for (const { events: evs } of ucEvents) {
  const w = (evs.find((e) => e.type === "game_won")?.data as { winner?: string } | undefined)?.winner;
  if (w === "undercover") ucUndercover++;
  else if (w === "civilians") ucCivilian++;
  else ucStall++;
  ucVoteRounds += evs.filter((e) => e.type === "vote_result").length;
}
const ucRate = ucUndercover / UC_GAMES;
console.log(`  卧底胜 ${ucUndercover} · 平民胜 ${ucCivilian} · 异常 ${ucStall}`);
console.log(`  卧底胜率: ${(ucRate * 100).toFixed(1)}%（1 打 5，理想 20-40%）`);
console.log(`  平均投票轮数: ${(ucVoteRounds / UC_GAMES).toFixed(1)}`);
// 报警线定 45% 而非 55%：1 打 5 的局，随机投票的基线本就只有 20%，
// 若卧底能赢到一半以上，说明平民 bot 完全没有利用「描述与词类别不符」这个唯一线索。
if (ucRate < 0.15) console.log("  ⚠️ 卧底胜率过低（<15%）——描述区分度不足或投票过准");
else if (ucRate > 0.45) console.log("  ⚠️ 卧底胜率偏高（>45%）——1 打 5 却胜负各半，平民未利用描述线索");
else console.log("  ✓ 胜率在合理区间");

// —— 拍卖行·密封竞价：风格胜率与市场热度 ——
// 判读要点：激进（ratio 高）应当「更容易得标但更不赚钱」，谨慎则相反。
// 若激进同时拿到最多标且最高净收益，说明出价下限太低、市场过热，需要调估值区间。
console.log("\n[拍卖行·密封竞价] 4 席 bot 对 bot（40 局）");
const AUCTION_STYLES: [string, number][] = [
  ["谨慎", 0.5],
  ["均衡", 0.75],
  ["激进", 0.92],
  ["极限", 1.0],
];
const AUCTION_GAMES = 40;
const auctionEvents = await runBatch("总计", createAuction(), () =>
  AUCTION_STYLES.map(([n, a]) => createAuctionBot(n, a)),
  AUCTION_GAMES,
);
const auctionWins: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
const auctionLots: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
let auctionLotsTotal = 0;
let auctionUnsold = 0;
let auctionPriceSum = 0;
for (const { events: evs } of auctionEvents) {
  const ended = evs.find((e) => e.type === "match_ended");
  if (ended) {
    const sc = (ended.data as { scores?: Record<string, number> }).scores ?? {};
    for (const [seat, s] of Object.entries(sc)) if (s === 1) auctionWins[seat] = (auctionWins[seat] ?? 0) + 1;
  }
  for (const e of evs) {
    if (e.type !== "round_resolved") continue;
    const d = e.data as { winner?: number | null; price?: number };
    auctionLotsTotal++;
    if (d.winner === null || d.winner === undefined) auctionUnsold++;
    else {
      auctionLots[String(d.winner)] = (auctionLots[String(d.winner)] ?? 0) + 1;
      auctionPriceSum += d.price ?? 0;
    }
  }
}
console.log(`  胜场分布: 1号(谨慎)=${auctionWins["1"]} · 2号(均衡)=${auctionWins["2"]} · 3号(激进)=${auctionWins["3"]} · 4号(极限)=${auctionWins["4"]}`);
console.log(`  得标件数: 谨慎=${auctionLots["1"]} · 均衡=${auctionLots["2"]} · 激进=${auctionLots["3"]} · 极限=${auctionLots["4"]}`);
console.log(`  共 ${auctionLotsTotal} 件 · 流拍 ${auctionUnsold}（${pct(auctionUnsold, auctionLotsTotal)}）· 平均成交价 ${auctionLotsTotal > auctionUnsold ? (auctionPriceSum / (auctionLotsTotal - auctionUnsold)).toFixed(1) : "—"}`);
const sold = auctionLotsTotal - auctionUnsold;
const aggressiveShare = sold > 0 ? (auctionLots["3"] + auctionLots["4"]) / sold : 0;
if (aggressiveShare < 0.3) console.log("  ⚠️ 激进派得标占比过低（<30%）——出价过度保守，市场没有竞争");
else if (aggressiveShare > 0.85) console.log("  ⚠️ 激进派几乎通吃（>85%）——估值区间可能太宽，谨慎派永远抢不到");
else console.log("  ✓ 得标分布合理（激进派更容易抢到，符合首价密封直觉）");
const auctionWr = Math.max(...Object.values(auctionWins)) / AUCTION_GAMES;
if (auctionWr > 0.6) console.log("  ⚠️ 单一风格胜率过高（>60%）");

// —— 海龟汤：主持人 vs 猜题者 ——
// 判读要点：**规则 bot 当主持人只能做关键词字面匹配，猜题者 bot 又不会语义推理**，
// 所以 bot 局里主持人胜率天然偏高——这是 bot 能力的上限，不是游戏失衡。
// 真正的对局质量依赖 LLM agent 或真人（双方都要能理解自然语言）。
// 本段的价值不在「调平衡」，而在**确认零和性与流程正确**：角色随机分配后，
// 两个角色各自的总胜场应当接近一半（否则说明角色分配有座位偏向）。
console.log("\n[海龟汤] 2 席 bot 对 bot（30 局）");
const TURTLE_GAMES = 30;
const turtleEvents = await runBatch("总计", createTurtleSoup(), () =>
  [createTurtleBot("甲", 0), createTurtleBot("乙", 1)],
  TURTLE_GAMES,
);
let soupHostWin = 0;
let soupGuesserWin = 0;
let soupAsks = 0;
let soupGuesses = 0;
for (const { events: evs } of turtleEvents) {
  const won = evs.find((e) => e.type === "game_won");
  if (!won) continue;
  const role = (won.data as { role?: string }).role;
  if (role === "host") soupHostWin++;
  else if (role === "guesser") soupGuesserWin++;
  soupAsks += evs.filter((e) => e.type === "asked").length;
  soupGuesses += evs.filter((e) => e.type === "guessed").length;
}
console.log(`  主持人胜 ${soupHostWin} · 猜题者胜 ${soupGuesserWin}`);
console.log(`  平均提问 ${(soupAsks / TURTLE_GAMES).toFixed(1)} 次 · 平均猜测 ${(soupGuesses / TURTLE_GAMES).toFixed(1)} 次`);
if (soupHostWin + soupGuesserWin < TURTLE_GAMES) console.log(`  ⚠️ ${TURTLE_GAMES - soupHostWin - soupGuesserWin} 局未走到终局`);
else if (soupHostWin === TURTLE_GAMES) console.log("  ⚠️ 主持人全胜——规则 bot 无法语义推理，属预期；真人对局会显著不同");
else console.log("  ✓ 流程正确（bot 局主持人偏强属能力上限，非失衡）");

// —— 框架不变量抽检 ——
console.log("\n[框架不变量抽检] 全超时 + 确定性");
const dice = createLiarsDice();
const r1 = await createMatch({ game: dice, drivers: [createHangingBot("a"), createHangingBot("b")], seed: 42, timeoutMs: 15 }).run();
const r2 = await createMatch({ game: dice, drivers: [createHangingBot("a"), createHangingBot("b")], seed: 42, timeoutMs: 15 }).run();
const detStr = JSON.stringify(r1.events.map((e) => [e.seq, e.type])) === JSON.stringify(r2.events.map((e) => [e.seq, e.type]));
console.log(`  全超时完赛: ${r1.events.some((e) => e.type === "match_ended") ? "✓" : "✗"}`);
console.log(`  同 seed 确定性: ${detStr ? "✓" : "✗"}`);

console.log("\n=== 报告完毕 ===");
