/**
 * 冒烟测试：五子棋（gomoku · r36 第九款游戏）
 * 锁五处最容易写错的地方：
 *   1. 四个方向的连五判定（横/竖/正斜/反斜——斜向漏一个方向是这类游戏最常见的 bug）
 *   2. 落子合法性（越界 / 已占点 / 非你回合 / 非 place 动作）
 *   3. 先手由 seed 随机（固定座位执黑会让 Elo 混入与实力无关的变量）
 *   4. **超时兜底必须落在空点上**——硬编码 (0,0) 在该点已占时会让超时动作被拒，
 *      对局直接卡死（这是本轮写完第一版就踩到的坑）
 *   5. House bot 全流程零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-gomoku.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createGomoku, BOARD_SIZE, WIN_LEN } from "./games/gomoku.ts";
import { createGomokuBot } from "./bots/gomoku-bot.ts";
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
const S = BOARD_SIZE;

console.log("=== Agent 游戏大厅 · 五子棋冒烟测试 ===\n");

const g = createGomoku();

// —— 场景 1：初始状态与先手随机 ——
console.log("[1] 初始状态：空棋盘 · 先手由 seed 决定");
const s1 = g.init([1, 2], mulberry32(1));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const board1 = v1.public.board as (number | null)[];
check("棋盘为 15×15 空盘", board1.length === S * S && board1.every((x) => x === null), `长度 ${board1.length}`);
check("黑方是 1 或 2 号", v1.public.black === 1 || v1.public.black === 2, `black=${v1.public.black}`);
check("黑白互为对手", v1.public.black !== v1.public.white, `${v1.public.black} vs ${v1.public.white}`);
check("黑方先手", v1.public.turn === v1.public.black, `turn=${v1.public.turn}`);
// 不同 seed 应能掷出不同先手（否则随机形同虚设）
const blacks = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((sd) => (g.viewOf(g.init([1, 2], mulberry32(sd)), 1, CTX) as unknown as V).public.black));
check("不同 seed 会掷出不同先手（不是恒等于座位 1）", blacks.size === 2, [...blacks].join("/"));

// —— 场景 2：落子合法性 ——
console.log("\n[2] 落子合法性");
const s2 = g.init([1, 2], mulberry32(3));
const black2 = (g.viewOf(s2, 1, CTX) as unknown as V).public.black as number;
const white2 = black2 === 1 ? 2 : 1;
check("越界被拒", g.validate(s2, black2, { type: "place", r: -1, c: 0 }).ok === false && g.validate(s2, black2, { type: "place", r: 0, c: S }).ok === false);
check("非整数坐标被拒", g.validate(s2, black2, { type: "place", r: 1.5, c: 0 }).ok === false);
check("非你回合被拒", (() => { const r = g.validate(s2, white2, { type: "place", r: 0, c: 0 }); return r.ok === false && String(r.error).includes("NOT_YOUR_TURN"); })(), "");
check("非 place 动作被拒", g.validate(s2, black2, { type: "move" }).ok === false);
let s2b = g.apply(s2, black2, { type: "place", r: 7, c: 7 }, RNG()).state;
check("已占点被拒", g.validate(s2b, white2, { type: "place", r: 7, c: 7 }).ok === false, "");
check("落子后轮到对手", (g.viewOf(s2b, 1, CTX) as unknown as V).public.turn === white2);

// —— 场景 3：四个方向的连五 ——
console.log("\n[3] 四个方向的连五判定");
/** 用一对 driver 精确控制落子：黑先手按 coords 依次落，白在远处垫子 */
function runLine(coords: [number, number][], pad: [number, number][], label: string): void {
  let s = g.init([1, 2], mulberry32(7));
  const black = (g.viewOf(s, 1, CTX) as unknown as V).public.black as number;
  const white = black === 1 ? 2 : 1;
  let won: { winner?: unknown; win_line?: unknown } | undefined;
  for (let i = 0; i < coords.length; i++) {
    s = g.apply(s, black, { type: "place", r: coords[i]![0], c: coords[i]![1] }, RNG()).state;
    const ev = g.isTerminal(s);
    if (ev) {
      won = { winner: black };
      break;
    }
    s = g.apply(s, white, { type: "place", r: pad[i]![0], c: pad[i]![1] }, RNG()).state;
  }
  const wl = ((g.viewOf(s, 1, CTX) as unknown as V).public.win_line ?? null) as number[] | null;
  check(`${label}方向连 ${WIN_LEN} 子判胜`, won !== undefined && g.scores(s)[black] === 1, `win_line=${JSON.stringify(wl)}`);
  check(`${label}方向 win_line 长度 ≥ ${WIN_LEN}`, Array.isArray(wl) && wl.length >= WIN_LEN, String(wl?.length));
}
runLine([[7, 0], [7, 1], [7, 2], [7, 3], [7, 4]], [[0, 0], [0, 1], [0, 2], [0, 3]], "横向");
runLine([[0, 7], [1, 7], [2, 7], [3, 7], [4, 7]], [[14, 0], [14, 1], [14, 2], [14, 3]], "纵向");
runLine([[2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], [[0, 14], [0, 13], [0, 12], [0, 11]], "正斜");
runLine([[2, 12], [3, 11], [4, 10], [5, 9], [6, 8]], [[14, 14], [14, 13], [14, 12], [14, 11]], "反斜");

// —— 场景 4：超时兜底必须落在空点 ——
console.log("\n[4] 超时兜底：落在空点上（不能硬编码 (0,0)）");
let s4 = g.init([1, 2], mulberry32(5));
const black4 = (g.viewOf(s4, 1, CTX) as unknown as V).public.black as number;
const white4 = black4 === 1 ? 2 : 1;
s4 = g.apply(s4, black4, { type: "place", r: 0, c: 0 }, RNG()).state; // 占掉 (0,0)
const to = g.timeoutAction(s4, white4) as { type: string; r: number; c: number };
check("超时动作不是 (0,0)", !(to.r === 0 && to.c === 0), `落在 (${to.r},${to.c})`);
const toValidate = g.validate(s4, white4, to);
check("超时动作本身合法（会被内核接受）", toValidate.ok === true, toValidate.ok ? "" : String(toValidate.error));

// —— 场景 5：House bot 全流程 + 确定性 ——
console.log("\n[5] House bot 全流程零拒绝 + 同 seed 确定性");
let rejects = 0;
const guarded = (aggr: number, tag: string): SeatDriver => {
  const bot = createGomokuBot(tag, aggr);
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
const mk = () => createMatch({ game: createGomoku(), drivers: [guarded(0.7, "沉稳"), guarded(1.0, "进攻")], seed: 5, timeoutMs: 4000 });
const runA = await mk().run();
const runB = await mk().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.filter((e) => e.type === "placed").length} 手`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("bot 局能走到终局", runA.events.some((e) => e.type === "game_won"), "");

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
