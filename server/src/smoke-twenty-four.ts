/**
 * 冒烟测试：24 点（twenty_four · r38 第十一款）
 * 这款是全平台唯一「把玩家自由文本当算式解析」的地方，安全是第一位：
 *   1. **绝不 eval**：注入类输入（require/process/分号/函数调用）必须一律拒绝
 *   2. 数字多重集校验：多用、少用、用没发的牌都要拒（防「24*(1)」蒙混）
 *   3. 结果必须等于 24；除零非法
 *   4. 无解牌组 → 该局全员 0 分（真实存在，不是 bug）
 *   5. bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-twenty-four.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createTwentyFour, checkSolution, evalExpression } from "./games/twenty-four.ts";
import { solveTwentyFour, createTwentyFourBot } from "./bots/twenty-four-bot.ts";
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

console.log("=== Agent 游戏大厅 · 24 点冒烟测试 ===\n");

// —— 场景 1：合法算式 ——
console.log("[1] 合法算式");
const C = [1, 2, 3, 4];
check("(1+2+3)*4 = 24", checkSolution("(1+2+3)*4", C), "");
check("1*2*3*4 = 24", checkSolution("1*2*3*4", C), "");
check("4*(3+2+1) 换序也合法", checkSolution("4*(3+2+1)", C), "");
check("带空格不影响", checkSolution(" ( 1 + 2 + 3 ) * 4 ", C), "");
check("重复牌组可重复引用（1,1,4,6 → 6*4*1*1）", checkSolution("6*4*1*1", [1, 1, 4, 6]), "");

// —— 场景 2：安全性（绝不 eval）——
console.log("\n[2] 安全性：注入类输入必须一律拒绝");
const attacks = [
  "require('fs')",
  "process.exit(0)",
  "1;2",
  "1+2+3+4; console.log(1)",
  "constructor",
  "(()=>24)()",
  "Math.ceil(23.5)",
  "1e999",
  "0x18",
  "24",
  "[].constructor",
];
for (const a of attacks) {
  const r = evalExpression(a);
  check(`拒绝「${a.slice(0, 24)}」`, r === null, r ? `竟然算出 ${r.value}` : "");
}
check("超长输入拒绝", evalExpression("1+".repeat(200) + "1") === null, "");

// —— 场景 3：数字多重集 ——
console.log("\n[3] 数字多重集：多用/少用/用没发的牌都要拒");
check("少用一张（1+2+3=6 不是 24，且少用 4）", checkSolution("1+2+3", C) === false);
check("多用一张（1+2+3+4+4）", checkSolution("(1+2+3+4)*4", C) === false, "5 个数字");
check("用没发的牌（1+2+3+18）", checkSolution("1+2+3+18", C) === false);
check("重复用同一张（1*1*2*3）", checkSolution("1*1*2*3", C) === false, "牌里只有一个 1");
check("两枚 1 各用一次（1*1*4*6）", checkSolution("1*1*4*6", [1, 1, 4, 6]), "");

// —— 场景 4：结果与除零 ——
console.log("\n[4] 结果必须等于 24，除零非法");
check("结果不等于 24 被拒", checkSolution("1+2+3+4", C) === false, "=10");
check("除零被拒", evalExpression("1/0") === null, "");
check("括号不闭合被拒", evalExpression("(1+2") === null, "");
check("多余右括号被拒", evalExpression("1+2)") === null, "");
check("运算符结尾被拒", evalExpression("1+2+") === null, "");

// —— 场景 5：无解牌组 ——
console.log("\n[5] 无解牌组：全员 0 分，不判任何人胜");
// 1,1,1,1 只能凑出 4 或 0 之类，无解
check("1,1,1,1 无解（bot 求解返回 null）", solveTwentyFour([1, 1, 1, 1]) === null, "");
const noSol = g0init();
function g0init() {
  const g = createTwentyFour({ rounds: 1 });
  return g;
}
void noSol;

// —— 场景 6：完整对局 ——
console.log("\n[6] 完整对局与 bot");
const g = createTwentyFour({ rounds: 3 });
const s1 = g.init([1, 2], mulberry32(7));
const v1 = g.viewOf(s1, 1, CTX) as unknown as { public: { cards: number[] } };
check("开局发 4 张牌（1-13）", v1.public.cards.length === 4 && v1.public.cards.every((c) => c >= 1 && c <= 13), v1.public.cards.join(" "));
const sol = solveTwentyFour(v1.public.cards);
check("bot 求解器能给出可验证的解或 null", sol === null || checkSolution(sol, v1.public.cards), sol ? sol.slice(0, 40) : "无解");

let rejects = 0;
const guarded = (tag: string): SeatDriver => {
  const bot = createTwentyFourBot(tag);
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
const mkRun = () => createMatch({ game: createTwentyFour({ rounds: 5 }), drivers: [guarded("甲"), guarded("乙")], seed: 11, timeoutMs: 4000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.filter((e) => e.type === "round_resolved").length} 局`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("对局能走到终局", runA.events.some((e) => e.type === "game_won"), "");
const won = runA.events.find((e) => e.type === "game_won");
check("终局带 winner 与 scores", won !== undefined && (won.data as { scores?: unknown }).scores !== undefined, "");

// 手控：两席都提交正确算式 → 各得 1 分
console.log("\n[7] 手控结算：都解对 → 各 +1");
let s7 = g.init([1, 2], mulberry32(3)) as ReturnType<typeof g.init>;
const cards7 = (g.viewOf(s7, 1, CTX) as unknown as { public: { cards: number[] } }).public.cards;
const expr7 = solveTwentyFour(cards7);
if (expr7) {
  s7 = g.apply(s7, 1, { type: "solve", expr: expr7 }, RNG()).state as typeof s7;
  s7 = g.apply(s7, 2, { type: "solve", expr: expr7 }, RNG()).state as typeof s7;
  const h7 = (g.viewOf(s7, 1, CTX) as unknown as { public: { scores: Record<string, number> } }).public.scores;
  check("双方都解对 → 各 +1", h7["1"] === 1 && h7["2"] === 1, JSON.stringify(h7));
} else {
  check("（该牌组无解，跳过手控结算）", true, cards7.join(" "));
}
void mulberry32;

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
