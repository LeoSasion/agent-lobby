/**
 * 冒烟测试：飞花令（feihualing · r38 第十四款）
 * 与成语接龙共用「封闭词库 + 顺序轮转 + 淘汰」骨架，区别在匹配维度（含某字 vs 首尾串接）。
 *   1. 诗库自检：去重、令字池每字至少 8 句（否则一轮都撑不满）
 *   2. 令字校验：不含令字的句子一律拒
 *   3. 重复句子被拒
 *   4. 淘汰与终局
 *   5. 「还剩几条」提示与实际一致
 *   6. bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-feihualing.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createFeihualing } from "./games/feihualing.ts";
import { POEMS, RHYME_CHARS, linesWith } from "./games/feihualing-data.ts";
import { createFeihualingBot } from "./bots/feihualing-bot.ts";
import { mulberry32 } from "./rng.ts";
import type { SeatDriver } from "./arena/match.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const CTX = { submittedSeats: [] as number[] };
type V = { public: Record<string, unknown>; private: Record<string, unknown> };

console.log("=== Agent 游戏大厅 · 飞花令冒烟测试 ===\n");

// —— 场景 1：诗库自检 ——
console.log("[1] 诗库自检");
check("诗库非空且 >= 80 句", POEMS.length >= 80, String(POEMS.length));
check("无重复诗句", new Set(POEMS).size === POEMS.length, `${new Set(POEMS).size}/${POEMS.length}`);
check("令字池非空", RHYME_CHARS.length > 0, RHYME_CHARS.join(" "));
check("每个令字至少 8 句可用", RHYME_CHARS.every((ch) => linesWith(ch).length >= 8),
  RHYME_CHARS.map((ch) => `${ch}${linesWith(ch).length}`).join(" "));

// —— 场景 2：规则 ——
console.log("\n[2] 令字校验与重复校验");
const g = createFeihualing();
const s1 = g.init([1, 2, 3], mulberry32(6));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const rhyme = v1.public.rhyme as string;
const turn = v1.public.turn as number;
check("开局选定了令字", typeof rhyme === "string" && rhyme.length === 1, rhyme);
check("令字在池内", RHYME_CHARS.includes(rhyme), "");

const okLine = linesWith(rhyme)[0]!;
check(`含令字的句子合法（${okLine}）`, g.validate(s1, turn, { type: "say", line: okLine }).ok === true);
const noRhyme = POEMS.find((l) => !l.includes(rhyme))!;
check("不含令字的句子被拒", (() => {
  const r = g.validate(s1, turn, { type: "say", line: noRhyme });
  return r.ok === false && String(r.error).includes("没有令字");
})(), noRhyme);
check("不在诗库被拒", g.validate(s1, turn, { type: "say", line: "我自创的一句诗啊" }).ok === false);
check("非当前回合被拒", (() => {
  const other = [1, 2, 3].find((x) => x !== turn)!;
  return g.validate(s1, other, { type: "say", line: okLine }).ok === false;
})(), "");

// 念一句后，同一句不能重复
const s2 = g.apply(s1, turn, { type: "say", line: okLine }, mulberry32(1)).state;
const v2 = g.viewOf(s2, 1, CTX) as unknown as V;
check("念过的句子被拒", g.validate(s2, v2.public.turn as number, { type: "say", line: okLine }).ok === false, "已念过");
check("remaining 随使用递减", (v2.public.remaining as number) === linesWith(rhyme).length - 1,
  `remaining=${v2.public.remaining} / 总 ${linesWith(rhyme).length}`);

// —— 场景 3：淘汰与终局 ——
console.log("\n[3] 淘汰：pass 即出局");
const s3 = g.init([1, 2], mulberry32(6));
const turn3 = (g.viewOf(s3, 1, CTX) as unknown as V).public.turn as number;
const r3 = g.apply(s3, turn3, { type: "pass" }, mulberry32(1));
check("pass 产生 dropped 事件", r3.events.some((e) => e.type === "dropped"), "");
check("两人局 pass 一次即终局", r3.events.some((e) => e.type === "game_won"), "");
check("存活者获胜", (g.scores(r3.state)[turn3 === 1 ? 2 : 1] ?? 0) === 1, JSON.stringify(g.scores(r3.state)));

// —— 场景 4：bot ——
console.log("\n[4] House bot 零拒绝 + 确定性");
let rejects = 0;
const guarded = (tag: string): SeatDriver => {
  const bot = createFeihualingBot(tag);
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
const mkRun = () => createMatch({ game: createFeihualing(), drivers: [guarded("甲"), guarded("乙"), guarded("丙")], seed: 17, timeoutMs: 3000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("对局能走到终局", runA.events.some((e) => e.type === "game_won"), "");
const recited = runA.events.filter((e) => e.type === "recited").length;
check("至少念了几句", recited >= 1, `${recited} 句`);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
