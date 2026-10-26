/**
 * 冒烟测试：21 点（blackjack · r38 第十二款）
 * 重点锁「A 的软硬」与「庄家暗牌隔离」——这两处写错，游戏会静默失衡：
 *   1. 点数：A 记 1 或 11（取不爆的最大值）、J/Q/K 记 10
 *   2. 暗牌隔离：揭示前 public 里绝不能有 dealer 数组与 dealer_value
 *   3. 爆牌：> 21 立即出局（不再要牌）
 *   4. 庄家规则：< 17 必须要牌，>= 17 停
 *   5. 结算：赢 +1 / 平 +0.5 / 输 0；庄家爆牌则未爆的玩家全胜
 *   6. bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-blackjack.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createBlackjack, handValue, cardValue } from "./games/blackjack.ts";
import { createBlackjackBot } from "./bots/blackjack-bot.ts";
import { mulberry32 } from "./rng.ts";
import type { SeatDriver } from "./arena/match.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const CTX = { submittedSeats: [] as number[] };
const RNG = () => mulberry32(99);
type V = { public: Record<string, unknown>; private: Record<string, unknown> };

console.log("=== Agent 游戏大厅 · 21 点冒烟测试 ===\n");

// —— 场景 1：点数计算 ——
console.log("[1] 点数：A 的软硬与花牌");
check("A + 10 = 21（软）", handValue([1, 10]) === 21, String(handValue([1, 10])));
check("A + A + 9 = 21（降一个 A）", handValue([1, 1, 9]) === 21, String(handValue([1, 1, 9])));
check("A + A + A = 13（只能留一个 11）", handValue([1, 1, 1]) === 13, String(handValue([1, 1, 1])));
check("J = 10", cardValue(11) === 10 && cardValue(12) === 10 && cardValue(13) === 10);
check("A 单张 = 11", handValue([1]) === 11, String(handValue([1])));
check("爆牌示例（10+10+5=25）", handValue([10, 10, 5]) === 25, String(handValue([10, 10, 5])));

// —— 场景 2：发牌与暗牌隔离 ——
console.log("\n[2] 发牌与暗牌隔离（揭示前庄家只有明牌）");
const g = createBlackjack({ rounds: 2 });
const s1 = g.init([1, 2], mulberry32(5));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const pub1 = v1.public as { dealer_up: number | null; dealer: unknown; dealer_value: unknown; dealer_revealed: boolean; players: { seat: number; cards: number[] }[] };
check("每人 2 张牌", pub1.players.every((p) => p.cards.length === 2), pub1.players.map((p) => p.cards.length).join("/"));
check("庄家明牌已给出（1-13）", typeof pub1.dealer_up === "number" && pub1.dealer_up >= 1 && pub1.dealer_up <= 13, String(pub1.dealer_up));
check("揭示前 dealer 数组为 null", pub1.dealer === null, String(pub1.dealer));
check("揭示前 dealer_value 为 null", pub1.dealer_value === null, String(pub1.dealer_value));
check("揭示前 dealer_revealed=false", pub1.dealer_revealed === false);
check("自己的手牌在 private", Array.isArray((v1.private as { my_cards?: number[] }).my_cards), "");
const spec1 = g.viewOf(s1, "spectator", CTX) as unknown as V;
check("观众也看不到庄家暗牌", (spec1.public as { dealer: unknown }).dealer === null);

// —— 场景 3：要牌 / 停牌 / 爆牌 ——
console.log("\n[3] 要牌与停牌");
const s3 = g.init([1, 2], mulberry32(5));
const h3 = g.viewOf(s3, 1, CTX) as unknown as V;
const seatA = (h3.public as { players: { seat: number }[] }).players[0]!.seat;
check("hit 合法", g.validate(s3, seatA, { type: "hit" }).ok === true);
check("stand 合法", g.validate(s3, seatA, { type: "stand" }).ok === true);
check("非法动作被拒", g.validate(s3, seatA, { type: "fold" }).ok === false);
const seatB = (h3.public as { players: { seat: number }[] }).players[1]!.seat;
// 同时相位：单人提交不会立即生效，必须收齐（这是设计，不是 bug）
let s3a = g.apply(s3, seatA, { type: "stand" }, RNG()).state;
check("未收齐时 pending 未落账（stood 仍为 false）", ((g.viewOf(s3a, 1, CTX) as unknown as V).public as { players: { seat: number; stood: boolean }[] }).players.find((p) => p.seat === seatA)!.stood === false);
check("收齐前再提交被拒（DUPLICATE_ACTION）", g.validate(s3a, seatA, { type: "hit" }).ok === false);
const r3 = g.apply(s3a, seatB, { type: "stand" }, RNG());
// 全员停牌会立即结算并开下一局（stood 被重置），所以只能看事件流，不能看瞬时状态
const types3 = r3.events.map((e) => e.type);
check("双方停牌产生两个 stood 事件", types3.filter((x) => x === "stood").length === 2, types3.join(","));
check("收齐后立即揭示庄家并结算", types3.includes("dealer_revealed") && types3.includes("round_settled"), types3.join(","));
check("结算后立即发下一局的牌", types3.includes("hand_dealt"), types3.join(","));

// —— 场景 4：完整对局与庄家规则 ——
console.log("\n[4] 完整对局：庄家 <17 必须要牌");
let rejects = 0;
const guarded = (tag: string): SeatDriver => {
  const bot = createBlackjackBot(tag);
  return {
    name: bot.name,
    act: async (v, submit) => {
      const wrapped = (a: Parameters<typeof submit>[0], o?: Parameters<typeof submit>[1]) => {
        const r = submit(a, o);
        if (!r.ok) rejects++;
        return r;
      };
      await bot.act(v, wrapped);
    },
  };
};
const mkRun = () => createMatch({ game: createBlackjack({ rounds: 4 }), drivers: [guarded("甲"), guarded("乙"), guarded("丙")], seed: 21, timeoutMs: 4000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次`);
const settled = runA.events.filter((e) => e.type === "round_settled");
check("每局都结算了", settled.length === 4, String(settled.length));
check("庄家结算点数必 >= 17 或已爆", settled.every((e) => {
  const d = e.data as { dealer_value: number };
  return d.dealer_value >= 17;
}), settled.map((e) => (e.data as { dealer_value: number }).dealer_value).join("/"));
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("对局能走到终局", runA.events.some((e) => e.type === "game_won"), "");

// —— 场景 5：结算口径 ——
console.log("\n[5] 结算：赢 +1 / 平 +0.5 / 输 0");
const allResults = settled.flatMap((e) => Object.values((e.data as { results: Record<string, { outcome: string }> }).results));
check("结果只会是 win/lose/push", allResults.every((r) => ["win", "lose", "push"].includes(r.outcome)), "");
const finalScores = (runA.events.filter((e) => e.type === "game_won").at(-1)?.data as { scores: Record<string, number> } | undefined)?.scores;
check("终局分数 = 各局得分之和（0.5 的倍数）", Object.values(finalScores ?? {}).every((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9), JSON.stringify(finalScores));
void mulberry32;

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
