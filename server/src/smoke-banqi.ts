/**
 * 冒烟测试：军棋翻棋（banqi · r38 第十五款）
 * 锁五处最容易写错的地方：
 *   1. **暗棋不泄露**：视图里未翻开的格子只能有 {faceUp:false}，不能带 side/kind（否则翻子机制失效）
 *   2. 翻子：只能翻暗棋，翻已翻开的、空格都要拒
 *   3. 吃子：等级压制、同级不吃、**兵吃帅**、帅吃不了兵
 *   4. 炮：直线走不吃子，吃子必须隔一子
 *   5. 200 步上限判和（没有天然终点）
 *   6. bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-banqi.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createBanqi, hasAnyAction, BQ_W, BQ_H, BQ_MAX_PLY, RANK_VALUE, type Piece } from "./games/banqi.ts";
import { createBanqiBot } from "./bots/banqi-bot.ts";
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
const idx = (x: number, y: number): number => y * BQ_W + x;
type V = { public: Record<string, unknown>; private: Record<string, unknown> };

console.log("=== Agent 游戏大厅 · 军棋翻棋冒烟测试 ===\n");

// —— 场景 1：布局与暗棋隔离 ——
console.log("[1] 布局与暗棋隔离");
const g = createBanqi();
const s1 = g.init([1, 2], mulberry32(8));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const board1 = v1.public.board as unknown[];
check("棋盘 32 格且全部有子", board1.length === BQ_W * BQ_H && board1.every((p) => p !== null), `${board1.length} 格`);
check("开局全部背面朝上", board1.every((p) => (p as { faceUp: boolean }).faceUp === false), "");
check("**暗棋不泄露 side/kind**", board1.every((p) => {
  const q = p as Record<string, unknown>;
  return q.faceUp === false && !("side" in q) && !("kind" in q);
}), "视图里暗棋只有 faceUp:false");
const vSpec = g.viewOf(s1, "spectator", CTX) as unknown as V;
check("观众视图同样不泄露暗棋", (vSpec.public.board as unknown[]).every((p) => {
  const q = p as Record<string, unknown>;
  return q.faceUp === false && !("kind" in q);
}), "");
check("阵营为 solid/hollow（不叫红蓝）", typeof v1.public.solid === "number" && typeof v1.public.hollow === "number",
  `solid=${v1.public.solid} hollow=${v1.public.hollow}`);

// —— 场景 2：翻子规则 ——
console.log("\n[2] 翻子");
const solidSeat = (g.viewOf(s1, 1, CTX) as unknown as V).public.solid as number;
check("翻暗棋合法", g.validate(s1, solidSeat, { type: "flip", cell: 0 }).ok === true);
check("越界格子被拒", g.validate(s1, solidSeat, { type: "flip", cell: 99 }).ok === false);
const flipped = g.apply(s1, solidSeat, { type: "flip", cell: 0 }, RNG()).state as ReturnType<typeof g.init>;
const v2 = g.viewOf(flipped, solidSeat, CTX) as unknown as V;
const cell0 = (v2.public.board as { faceUp: boolean; side?: string; kind?: string }[])[0]!;
check("翻开后暴露 side 与 kind", cell0.faceUp === true && typeof cell0.side === "string" && typeof cell0.kind === "string",
  `${cell0.side}/${cell0.kind}`);
check("翻已翻开的格子被拒", g.validate(flipped, (v2.public.turn as number), { type: "flip", cell: 0 }).ok === false);

// —— 场景 3：吃子规则（直接构造局面）——
console.log("\n[3] 吃子：等级 / 兵吃帅 / 同级");
function mkState(pieces: Record<number, Piece>, side: "solid" | "hollow" = "solid") {
  const s = g.init([1, 2], mulberry32(8));
  const raw = s as unknown as { board: (Piece | null)[]; turn: number; sideOf: Map<number, string> };
  raw.board = new Array(BQ_W * BQ_H).fill(null);
  for (const [k, v] of Object.entries(pieces)) raw.board[Number(k)] = v;
  const mySeat = [...raw.sideOf.entries()].find(([, sd]) => sd === side)![0];
  raw.turn = mySeat;
  return s;
}
// 车(4) 吃 马(3)：相邻
const sCar = mkState({
  [idx(0, 0)]: { kind: "chariot", side: "solid", faceUp: true },
  [idx(1, 0)]: { kind: "horse", side: "hollow", faceUp: true },
});
check("车能吃马（4>3）", g.validate(sCar, g.viewOf(sCar, 1, CTX) && (g.viewOf(sCar, 1, CTX) as unknown as V).public.turn as number, { type: "move", from: idx(0, 0), to: idx(1, 0) }).ok === true);
// 兵吃帅
// solid 兵向上（y 减小），所以兵放在 (0,1)、帅放在 (0,0) 才够得着
const sSoldier = mkState({
  [idx(0, 1)]: { kind: "soldier", side: "solid", faceUp: true },
  [idx(0, 0)]: { kind: "king", side: "hollow", faceUp: true },
});
check("兵能吃帅（唯一越级）", g.validate(sSoldier, (g.viewOf(sSoldier, 1, CTX) as unknown as V).public.turn as number, { type: "move", from: idx(0, 1), to: idx(0, 0) }).ok === true);
// 帅吃不了兵
const sKing = mkState({
  [idx(0, 0)]: { kind: "king", side: "solid", faceUp: true },
  [idx(0, 1)]: { kind: "soldier", side: "hollow", faceUp: true },
});
check("帅吃不了兵", g.validate(sKing, (g.viewOf(sKing, 1, CTX) as unknown as V).public.turn as number, { type: "move", from: idx(0, 0), to: idx(0, 1) }).ok === false);
// 同级不能吃
const sSame = mkState({
  [idx(0, 0)]: { kind: "horse", side: "solid", faceUp: true },
  [idx(1, 0)]: { kind: "horse", side: "hollow", faceUp: true },
});
check("同级不能互吃", g.validate(sSame, (g.viewOf(sSame, 1, CTX) as unknown as V).public.turn as number, { type: "move", from: idx(0, 0), to: idx(1, 0) }).ok === false);

// —— 场景 4：炮隔子吃 ——
console.log("\n[4] 炮：直走不吃子、吃子须隔一子");
const sCannon = mkState({
  [idx(0, 0)]: { kind: "cannon", side: "solid", faceUp: true },
  [idx(1, 0)]: { kind: "soldier", side: "hollow", faceUp: true }, // 炮架
  [idx(2, 0)]: { kind: "horse", side: "hollow", faceUp: true },   // 目标
});
const turnC = (g.viewOf(sCannon, 1, CTX) as unknown as V).public.turn as number;
check("炮隔一子能吃（0→2）", g.validate(sCannon, turnC, { type: "move", from: idx(0, 0), to: idx(2, 0) }).ok === true);
check("炮不能吃紧邻的炮架（0→1）", g.validate(sCannon, turnC, { type: "move", from: idx(0, 0), to: idx(1, 0) }).ok === false);
const sCannon2 = mkState({
  [idx(0, 0)]: { kind: "cannon", side: "solid", faceUp: true },
  [idx(3, 0)]: null as unknown as Piece,
});
check("炮可直走到空格（无遮挡）", g.validate(sCannon2, (g.viewOf(sCannon2, 1, CTX) as unknown as V).public.turn as number, { type: "move", from: idx(0, 0), to: idx(3, 0) }).ok === true);

// —— 场景 5：闸门与无子可动 ——
console.log("\n[5] 200 步上限与无子可动");
check("上限已定义", BQ_MAX_PLY === 200, String(BQ_MAX_PLY));
check("视图暴露 max_ply", (v1.public.max_ply as number) === BQ_MAX_PLY, "");

const sB = g.init([1, 2], mulberry32(8));
const solidB = g.viewOf(sB, 1, CTX) && (g.viewOf(sB, 1, CTX) as unknown as V).public.solid as number;
const rawB = sB as unknown as { board: (Piece | null)[]; turn: number };
rawB.board = new Array(BQ_W * BQ_H).fill(null);
// 全部明棋（无暗棋可翻）+ 实心兵卡在角上、唯一出口被炮堵死 → 一个动作都没有
rawB.board[idx(0, 0)] = { kind: "soldier", side: "solid", faceUp: true };
rawB.board[idx(1, 0)] = { kind: "cannon", side: "hollow", faceUp: true };
check("无暗棋且唯一棋子被堵 → 该席位无动作", hasAnyAction(sB as never, solidB) === false);
check("有暗棋时一定还有动作（翻子即动作）", (() => {
  const s2 = g.init([1, 2], mulberry32(8));
  const sd = (g.viewOf(s2, 1, CTX) as unknown as V).public.solid as number;
  return hasAnyAction(s2 as never, sd) === true;
})(), "开局 32 张暗棋");

// —— 场景 6：bot ——
console.log("\n[6] House bot 零拒绝 + 确定性");
let rejects = 0;
const guarded = (tag: string): SeatDriver => {
  const bot = createBanqiBot(tag);
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
const mkRun = () => createMatch({ game: createBanqi(), drivers: [guarded("甲"), guarded("乙")], seed: 31, timeoutMs: 3000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.filter((e) => e.type === "flipped" || e.type === "moved").length} 步`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("对局能在闸门内收口", runA.events.some((e) => e.type === "game_won"), "");
void RANK_VALUE;

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
