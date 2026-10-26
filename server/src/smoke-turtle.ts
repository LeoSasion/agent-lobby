/**
 * 冒烟测试：海龟汤（turtle_soup · r35 第八款游戏）
 * 锁的是这款游戏最容易写错的五处：
 *   1. 信息隔离：真相只在主持人 private——**猜题者看不到，观众也看不到**（否则观战即剧透）
 *   2. 角色分配：host 与 guesser 互补且都由 seed 决定（固定座位当主持人 = 胜负与实力无关）
 *   3. 相位交替：ask → 等 host answer；answer 后回到 guesser；不许抢答/越位
 *   4. 两条终局：提问次数用尽 → 主持人胜；主持人判定猜中 → 猜题者胜
 *   5. House bot 全流程零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-turtle.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createTurtleSoup, PUZZLES } from "./games/turtle-soup.ts";
import { createTurtleBot } from "./bots/turtle-bot.ts";
import { mulberry32 } from "./rng.ts";
import type { SeatDriver } from "./arena/match.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const CTX = { submittedSeats: [] as number[] };
/** 本游戏无随机决策，rng 传什么都一样；但 GameModule.apply 的签名要求它 */
const RNG = () => mulberry32(99);
type V = { public: Record<string, unknown>; private: Record<string, unknown> };

console.log("=== Agent 游戏大厅 · 海龟汤冒烟测试 ===\n");

const g = createTurtleSoup();

// —— 场景 1：信息隔离（本游戏最重要的一条）——
console.log("[1] 信息隔离：真相只在主持人 private");
const s1 = g.init([1, 2], mulberry32(3));
const host1 = (g.viewOf(s1, 1, CTX) as unknown as V).private.role === "host" ? 1 : 2;
const guesser1 = host1 === 1 ? 2 : 1;
const vHost = g.viewOf(s1, host1, CTX) as unknown as V;
const vGuesser = g.viewOf(s1, guesser1, CTX) as unknown as V;
const vSpec = g.viewOf(s1, "spectator", CTX) as unknown as V;
const truth1 = String(vHost.private.truth ?? "");
check("主持人 private 带 truth", truth1.length > 0, truth1.slice(0, 24));
check("角色互补（host + guesser 各一席）", host1 !== guesser1 && (vGuesser.private.role === "guesser"), `host=${host1} guesser=${guesser1}`);
check("猜题者 private 不含 truth", !("truth" in vGuesser.private), Object.keys(vGuesser.private).join(","));
check("观众 private 为空", Object.keys(vSpec.private).length === 0, JSON.stringify(vSpec.private));
check("观众 public 不含 truth 键", !("truth" in vSpec.public), Object.keys(vSpec.public).join(","));
// 真相的独特片段不得出现在公开视图里（谜面与真相可能有共享词，取真相独有的那句）
const probe = truth1.slice(0, 8);
check("公开视图序列化后不含真相片段", !JSON.stringify(vSpec.public).includes(probe), `探针「${probe}」`);
check("谜面对所有人公开", typeof vSpec.public.surface === "string" && String(vSpec.public.surface).length > 10, "");

// —— 场景 2：相位交替与越位拦截 ——
console.log("\n[2] 相位交替：只等当前应出手的那一席");
const s2 = g.init([1, 2], mulberry32(3));
const h2 = (g.viewOf(s2, 1, CTX) as unknown as V).private.role === "host" ? 1 : 2;
const gu2 = h2 === 1 ? 2 : 1;
const byGuesser = g.validate(s2, gu2, { type: "answer", verdict: "yes" });
check("猜题者不能代替主持人回答", byGuesser.ok === false, byGuesser.ok ? "" : String(byGuesser.error));
const byHost = g.validate(s2, h2, { type: "ask", text: "我先问一句" });
check("主持人不能抢猜题者的提问权", byHost.ok === false, byHost.ok ? "" : String(byHost.error));
const emptyText = g.validate(s2, gu2, { type: "ask", text: "" });
check("空提问被拒", emptyText.ok === false, emptyText.ok ? "" : String(emptyText.error));
const longText = g.validate(s2, gu2, { type: "ask", text: "啊".repeat(201) });
check("超长提问被拒", longText.ok === false, longText.ok ? "" : String(longText.error));

let s3 = g.apply(s2, gu2, { type: "ask", text: "跟他职业有关吗？" }, RNG()).state;
const vAfterAsk = g.viewOf(s3, h2, CTX) as unknown as V;
check("提问后轮到主持人", vAfterAsk.public.expecting === "answer" && vAfterAsk.public.awaiting === h2, `expecting=${vAfterAsk.public.expecting}`);
s3 = g.apply(s3, h2, { type: "answer", verdict: "no" }, RNG()).state;
const vAfterAns = g.viewOf(s3, gu2, CTX) as unknown as V;
check("回答后回到猜题者", vAfterAns.public.expecting === "ask" && vAfterAns.public.awaiting === gu2, `expecting=${vAfterAns.public.expecting}`);

// —— 场景 3：两条终局 ——
console.log("\n[3] 两条终局：次数用尽 / 判定猜中");
let s4 = g.init([1, 2], mulberry32(11));
let h4 = (g.viewOf(s4, 1, CTX) as unknown as V).private.role === "host" ? 1 : 2;
let gu4 = h4 === 1 ? 2 : 1;
const maxA = Number((g.viewOf(s4, 1, CTX) as unknown as V).public.max_asks);
for (let i = 0; i < maxA; i++) {
  s4 = g.apply(s4, gu4, { type: "ask", text: `第 ${i + 1} 问` }, RNG()).state;
  const v = g.viewOf(s4, h4, CTX) as unknown as V;
  s4 = g.apply(s4, h4, { type: "answer", verdict: "irrelevant" }, RNG()).state;
  if (v.public.phase === "finished") break;
}
const vEnd4 = g.viewOf(s4, 1, CTX) as unknown as V;
check(`提问 ${maxA} 次耗尽 → 终局`, vEnd4.public.phase === "finished", String(vEnd4.public.phase));
check("耗尽时主持人胜", g.scores(s4)[h4] === 1 && g.scores(s4)[gu4] === 0, JSON.stringify(g.scores(s4)));

let s5 = g.init([1, 2], mulberry32(17));
const h5 = (g.viewOf(s5, 1, CTX) as unknown as V).private.role === "host" ? 1 : 2;
const gu5 = h5 === 1 ? 2 : 1;
s5 = g.apply(s5, gu5, { type: "guess", text: "他说中了吗" }, RNG()).state;
const vGuess = g.viewOf(s5, h5, CTX) as unknown as V;
check("提交解答后轮到主持人判定", vGuess.public.expecting === "judge", String(vGuess.public.expecting));
s5 = g.apply(s5, h5, { type: "judge", correct: true }, RNG()).state;
check("判定猜中 → 猜题者胜", g.scores(s5)[gu5] === 1 && g.scores(s5)[h5] === 0, JSON.stringify(g.scores(s5)));
const won5 = (g.viewOf(s5, 1, CTX) as unknown as V).public;
void won5;
check("终局后 isTerminal 为 true", g.isTerminal(s5) === true);
check("终局后不再有合法动作", g.legalActions(s5, gu5).length === 0 && g.activeSeats(s5).length === 0);

// 终局事件必须公开真相（否则观众永远不知道谜底）
let s6 = g.init([1, 2], mulberry32(23));
const h6 = (g.viewOf(s6, 1, CTX) as unknown as V).private.role === "host" ? 1 : 2;
const gu6 = h6 === 1 ? 2 : 1;
s6 = g.apply(s6, gu6, { type: "guess", text: "试试" }, RNG()).state;
const endEvents = g.apply(s6, h6, { type: "judge", correct: true }, RNG()).events;
const wonEv = endEvents.find((e) => e.type === "game_won");
check("终局事件公开真相（复盘必需）", typeof (wonEv?.data as { truth?: string })?.truth === "string", String((wonEv?.data as { truth?: string })?.truth).slice(0, 20));
// 终局后 public 也要带真相：观众看的是视图不是事件流，只公开在事件里等于没公开
const vEnd6 = g.viewOf(s5, "spectator", CTX) as unknown as V;
check("终局后观众视图带真相", typeof vEnd6.public.truth === "string", String(vEnd6.public.truth ?? "").slice(0, 20));

// 谜题库自检：id 唯一、surface/truth 非空（防止加入空题让整局无意义）
check("谜题库 id 唯一", new Set(PUZZLES.map((p) => p.id)).size === PUZZLES.length, `${PUZZLES.length} 题`);
check("每题都有谜面与真相", PUZZLES.every((p) => p.surface.length > 10 && p.truth.length > 10), "");

// —— 场景 4：House bot 全流程 + 确定性 ——
console.log("\n[4] House bot 全流程零拒绝 + 同 seed 确定性");
let rejects = 0;
const guarded = (idx: number): SeatDriver => {
  const bot = createTurtleBot(`bot${idx}`, idx);
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
const mk = () => createMatch({ game: createTurtleSoup(), drivers: [guarded(0), guarded(1)], seed: 31, timeoutMs: 3000 });
const runA = await mk().run();
const runB = await mk().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.length} 事件`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
const endA = runA.events.find((e) => e.type === "game_won");
check("bot 局能走到终局", endA !== undefined, String((endA?.data as { reason?: string })?.reason));

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
