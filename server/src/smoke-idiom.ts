/**
 * 冒烟测试：成语接龙（idiom_chain · r38 第十三款）
 * 锁的是「封闭词库」这套判定的正确性：
 *   1. 词库自检：无重复、长度合法、首字索引与内容一致
 *   2. 接龙规则：首字不符 / 不在词库 / 已用过 → 一律拒
 *   3. 淘汰：pass 即出局，最后存活者胜
 *   4. 「还剩 N 条」提示与实际可用数一致（给数量不给答案）
 *   5. bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-idiom.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createIdiomChain } from "./games/idiom-chain.ts";
import { IDIOMS, IDIOM_SET, BY_FIRST, headOf, tailOf } from "./games/idiom-data.ts";
import { createIdiomBot } from "./bots/idiom-bot.ts";
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

console.log("=== Agent 游戏大厅 · 成语接龙冒烟测试 ===\n");

// —— 场景 1：词库自检 ——
console.log("[1] 词库自检");
check("词库非空且规模合理（>=300）", IDIOMS.length >= 300, String(IDIOMS.length));
check("无重复条目", IDIOM_SET.size === IDIOMS.length, `${IDIOM_SET.size}/${IDIOMS.length}`);
check("每条长度 2-8", IDIOMS.every((w) => w.length >= 2 && w.length <= 8), "");
check("首字索引与内容一致", IDIOMS.every((w) => (BY_FIRST.get(headOf(w)) ?? []).includes(w)), "");
check("以某字开头的条数 > 0 的字超过 100 个", BY_FIRST.size > 100, String(BY_FIRST.size));

// —— 场景 2：接龙规则 ——
console.log("\n[2] 接龙规则");
const g = createIdiomChain();
const s1 = g.init([1, 2, 3], mulberry32(4));
const v1 = g.viewOf(s1, 2, CTX) as unknown as V;
const cur1 = v1.public.current as string;
const turn1 = v1.public.turn as number;
const cands = (BY_FIRST.get(cur1) ?? []).filter((w) => w !== (v1.public.chain as { idiom: string }[])[0]!.idiom);
check("开局给了起始成语与要接的字", typeof cur1 === "string" && cur1.length === 1, `要接「${cur1}」`);
check("起始成语尾字 = current", tailOf((v1.public.chain as { idiom: string }[])[0]!.idiom) === cur1);
check("轮到的席位是合法席位", [1, 2, 3].includes(turn1), String(turn1));

const good = cands[0];
if (good) {
  check(`接「${good}」合法（首字匹配且在词库）`, g.validate(s1, turn1, { type: "say", idiom: good }).ok === true);
} else {
  check("（该尾字无可用成语，跳过合法接龙断言）", true);
}
check("首字不符被拒", (() => {
  const wrong = IDIOMS.find((w) => headOf(w) !== cur1)!;
  const r = g.validate(s1, turn1, { type: "say", idiom: wrong });
  return r.ok === false && String(r.error).includes("必须以");
})(), "");
check("不在词库被拒", (() => {
  const r = g.validate(s1, turn1, { type: "say", idiom: "自造四字词语" });
  return r.ok === false && String(r.error).includes("不在词库");
})(), "");
check("已用过的成语被拒", (() => {
  const start = (v1.public.chain as { idiom: string }[])[0]!.idiom;
  const r = g.validate(s1, turn1, { type: "say", idiom: start });
  return r.ok === false;
})(), "");
check("非当前回合被拒", (() => {
  const other = [1, 2, 3].find((x) => x !== turn1)!;
  const r = g.validate(s1, other, { type: "say", idiom: good ?? IDIOMS[0]! });
  return r.ok === false && String(r.error).includes("还没轮到你");
})(), "");

// —— 场景 3：淘汰与终局 ——
console.log("\n[3] 淘汰：pass 即出局");
const s3 = g.init([1, 2], mulberry32(4));
const turn3 = (g.viewOf(s3, 1, CTX) as unknown as V).public.turn as number;
const r3 = g.apply(s3, turn3, { type: "pass" }, mulberry32(1));
check("pass 产生 dropped 事件", r3.events.some((e) => e.type === "dropped"), "");
check("两人局 pass 一次即终局", r3.events.some((e) => e.type === "game_won"), "");
check("存活者获胜", (g.scores(r3.state)[turn3 === 1 ? 2 : 1] ?? 0) === 1, JSON.stringify(g.scores(r3.state)));

// —— 场景 4：还剩几条的提示 ——
console.log("\n[4] 「还剩 N 条」提示与实际一致");
const s4 = g.init([1, 2], mulberry32(9));
const v4 = g.viewOf(s4, 1, CTX) as unknown as V;
const cur4 = v4.public.current as string;
const used4 = new Set((v4.public.chain as { idiom: string }[]).map((c) => c.idiom));
const actual = (BY_FIRST.get(cur4) ?? []).filter((w) => !used4.has(w)).length;
check("视图 remaining = 实际可用数", v4.public.remaining === actual, `视图 ${v4.public.remaining} / 实际 ${actual}`);
check("提示只给数量不给具体成语", !JSON.stringify(v4.public).includes("candidates"), "");

// —— 场景 5：bot ——
console.log("\n[5] House bot 零拒绝 + 确定性");
let rejects = 0;
const guarded = (tag: string): SeatDriver => {
  const bot = createIdiomBot(tag);
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
const mkRun = () => createMatch({ game: createIdiomChain(), drivers: [guarded("甲"), guarded("乙"), guarded("丙")], seed: 13, timeoutMs: 3000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("对局能走到终局", runA.events.some((e) => e.type === "game_won"), "");
const linked = runA.events.filter((e) => e.type === "linked").length;
check("接龙至少连了几环", linked >= 1, `${linked} 环`);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
