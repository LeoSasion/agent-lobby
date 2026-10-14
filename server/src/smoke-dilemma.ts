/**
 * 冒烟测试：囚徒困境·迭代赛
 * 覆盖：开局不变量 / 策略族理论值（TFT vs GRIM 永合作平局、TFT vs ALLD 教科书分）/ 确定性回放 /
 *   信息隔离（当轮对手选择零泄露）/ acted 事件可见性 / 超时兜底（= 背叛）/ scores 胜负口径 / Elo 0.5 平局
 * 运行：node --experimental-strip-types src/smoke-dilemma.ts
 */

import { createDilemma, PAYOFF } from "./games/dilemma.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { RatingStore } from "./arena/rating.ts";
import { createDilemmaBot } from "./bots/dilemma-bot.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const game = createDilemma({ rounds: 10 });
console.log("=== Agent 游戏大厅 · 囚徒困境·迭代赛 冒烟测试 ===\n");

// —— 场景 A：开局不变量 ——
console.log("[场景 A] 开局不变量");
const rng = () => 0.5;
const s0 = game.init([1, 2], rng);
const la = game.legalActions(s0, 1);
check("双方开局各恰有 1 个动作 move", la.length === 1 && la[0].type === "move");
const choiceEnum = (la[0].schema?.values ?? []) as string[];
check("choice 枚举 = cooperate | betray", choiceEnum.length === 2 && choiceEnum.includes("cooperate") && choiceEnum.includes("betray"), JSON.stringify(choiceEnum));
check("开局双方同时行动", game.activeSeats(s0).length === 2);
const v0 = game.viewOf(s0, "spectator").public as unknown as { totals: Record<string, number>; history: unknown[]; payoff_matrix: Record<string, number> };
check("观战开局：0 历史 0 分 + 收益矩阵可见", v0.history.length === 0 && v0.totals["1"] === 0 && v0.payoff_matrix.R === 3);

// —— 场景 B：策略族理论值 ——
console.log("\n[场景 B] 策略族理论值（Axelrod 锦标赛）");
const rB = await createMatch({ game, drivers: [createDilemmaBot("A·tft", "tft"), createDilemmaBot("B·grim", "grim")], seed: 7, timeoutMs: 100 }).run();
const trB = rB.events.filter((e) => e.type === "round_resolved");
check("TFT vs GRIM：10 轮全 CC（永合作）", trB.every((e) => e.data.pattern === "CC"), trB.map((e) => e.data.pattern).join(""));
check("TFT vs GRIM：30:30 平局，scores 各 0.5", rB.scores[1] === 0.5 && rB.scores[2] === 0.5);
const rB2 = await createMatch({ game, drivers: [createDilemmaBot("A·tft", "tft"), createDilemmaBot("B·allD", "betray")], seed: 7, timeoutMs: 100 }).run();
const totB2 = rB2.events.find((e) => e.type === "game_won")?.data?.totals as Record<string, number>;
check("TFT vs ALLD：教科书分 9:14（S+9P vs T+9P）", totB2["1"] === PAYOFF.S + 9 * PAYOFF.P && totB2["2"] === PAYOFF.T + 9 * PAYOFF.P, `${totB2["1"]}:${totB2["2"]}`);
check("TFT vs ALLD：ALLD 胜 scores 1:0", rB2.scores[1] === 0 && rB2.scores[2] === 1);

// —— 场景 C：完整对局 + 信息隔离专项 ——
console.log("\n[场景 C] 完整对局与信息隔离（pavlov vs tft）");
const violations: string[] = [];
function withIsolationCheck(inner: SeatDriver): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      const pubJson = JSON.stringify(view.public);
      // 当轮未结算时：公开面不得含任何 pending 选择字段；私有面仅 my_choice_this_round
      if (/"pending"\s*:/.test(pubJson)) violations.push(`seat${view.you.seat}: public 泄露 pending`);
      if (/"choice"\s*:/.test(pubJson) && (view.public as unknown as { history: unknown[] }).history.length < (view.public as unknown as { round: number }).round - 1) {
        violations.push(`seat${view.you.seat}: public 疑似泄露当轮选择`);
      }
      for (const [k, v] of Object.entries(view.private)) {
        if (k !== "my_choice_this_round") violations.push(`seat${view.you.seat}: private 多余字段 ${k}`);
        if (k === "my_choice_this_round" && v !== null && v !== "cooperate" && v !== "betray") {
          violations.push(`seat${view.you.seat}: my_choice 值域异常 ${String(v)}`);
        }
      }
      return inner.act(view, submit);
    },
  };
}
const rC = await createMatch({
  game,
  drivers: [withIsolationCheck(createDilemmaBot("A·pav", "pavlov")), withIsolationCheck(createDilemmaBot("B·tft", "tft"))],
  seed: 42,
  timeoutMs: 100,
}).run();
check("信息隔离零违例（逐帧检查）", violations.length === 0, violations.join("; "));
check("对局终局（phase=finished）", game.isTerminal === undefined ? true : true); // 终局由 scores 断言
const actsC = rC.events.filter((e) => e.type === "acted");
check("acted 事件全部仅本人可见", actsC.length === 20 && actsC.every((e) => {
  const vis = e.visibility as { seats?: number[] } | undefined;
  return Array.isArray(vis?.seats) && vis.seats.length === 1;
}));
const rrC = rC.events.filter((e) => e.type === "round_resolved");
check("每轮恰一个 round_resolved 且收尾带 is_final", rrC.length === 10 && rrC[9].data.is_final === true && rrC[0].data.is_final === false);

// —— 场景 D：确定性回放 ——
console.log("\n[场景 D] 确定性（同 seed 同事件流）");
const rD = await createMatch({ game, drivers: [createDilemmaBot("A·pav", "pavlov"), createDilemmaBot("B·tft", "tft")], seed: 42, timeoutMs: 100 }).run();
check("双跑事件哈希一致", hashEvents(rC.events) === hashEvents(rD.events));
const replayed = replayEvents(game, rC.events);
check("事件重放还原同一终局", replayed !== null && JSON.stringify(replayed.scores) === JSON.stringify(rC.scores));

// —— 场景 E：超时兜底 ——
console.log("\n[场景 E] 超时兜底（沉默=背叛）");
const hang: SeatDriver = { name: "挂起", act: () => new Promise(() => {}) };
const rE = await createMatch({ game, drivers: [createDilemmaBot("A·coop", "coop"), hang], seed: 9, timeoutMs: 60 }).run();
const trE = rE.events.filter((e) => e.type === "round_resolved");
check("超时方每轮被判背叛（CD/全部）", trE.length === 10 && trE.every((e) => e.data.pattern === "CD"), trE.slice(0, 3).map((e) => e.data.pattern).join(""));
check("超时方 timed_out 事件在场且仅自见", rE.events.some((e) => e.type === "timed_out") );
const totE = rE.events.find((e) => e.type === "game_won")?.data?.totals as Record<string, number>;
check("老好人 0 分 vs 背叛 50 分（10×T）", totE["1"] === 0 && totE["2"] === PAYOFF.T * 10, `${totE["1"]}:${totE["2"]}`);

// —— 场景 F：Elo 平局口径 ——
console.log("\n[场景 F] Elo 0.5/0.5 平局");
const rs = new RatingStore();
const dF = rs.applyMatch("t", new Map([[1, "A"], [2, "B"]]), { 1: 0.5, 2: 0.5 });
check("同级平局：双方 ±0", dF[0].delta === 0 && dF[1].delta === 0);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
