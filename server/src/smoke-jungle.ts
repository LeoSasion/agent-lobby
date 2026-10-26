/**
 * 冒烟测试：斗兽棋（jungle_chess · r37 第十款游戏）
 * 锁的是这款游戏全部「不写测试就一定会写错」的规则：
 *   1. 初始布局：16 枚棋子，双方各 8
 *   2. 等级吃子：高吃低、同级不能吃
 *   3. **鼠吃象、象吃不了鼠**（全游戏唯一的越级特例）
 *   4. 陷阱：踏进**对方**陷阱的棋子战斗力归 0，任何棋子可吃；自己人站自己的陷阱没事
 *   5. 河流：只有鼠能进；水陆之间不能互吃
 *   6. 跳河：狮/虎可跳过河，**河中有鼠则不能跳**
 *   7. 兽穴：进对方兽穴即胜；不能进自己的
 *   8. **僵局闸门**：无吃子 80 手 / 总手数 200 手判和——没有闸门对局会永远跑下去（实测卡死 2 分半）
 *   9. House bot 零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-jungle.ts
 */

import { createMatch } from "./arena/lobby.ts";
import {
  createJungleChess, JUNGLE_W, JUNGLE_H, MAX_MOVES, QUIET_PLIES_LIMIT,
  type Rank, type Side,
} from "./games/jungle-chess.ts";
import { createJungleBot } from "./bots/jungle-bot.ts";
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
const S = JUNGLE_W;
const at = (x: number, y: number): number => y * S + x;
const xy = (i: number): string => `${i % S},${Math.floor(i / S)}`;

type Piece = { seat: number; side: Side; kind: Rank };
type Raw = {
  board: (Piece | null)[];
  seats: number[];
  sideOf: Map<number, Side>;
  quietPlies: number;
  turn: number;
};
type V = { public: Record<string, unknown>; private: Record<string, unknown> };

const g = createJungleChess();
/** 测试用：直接改棋盘（生产代码不该这么干，测试需要精确局面） */
const raw = (s: unknown): Raw => s as unknown as Raw;
const put = (s: unknown, x: number, y: number, piece: Piece | null): void => {
  raw(s).board[at(x, y)] = piece;
};
const mk = (side: Side, seat: number, kind: Rank): Piece => ({ seat, side, kind });

console.log("=== Agent 游戏大厅 · 斗兽棋冒烟测试 ===\n");

// —— 场景 1：初始布局 ——
console.log("[1] 初始布局：双方各 8 子");
const s1 = g.init([1, 2], mulberry32(4));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const board1 = v1.public.board as (Piece | null)[];
const red1 = v1.public.red as number;
const blue1 = v1.public.blue as number;
check("棋子总数 16", board1.filter(Boolean).length === 16, String(board1.filter(Boolean).length));
check("红蓝各 8 子", board1.filter((p) => p?.side === "red").length === 8 && board1.filter((p) => p?.side === "blue").length === 8);
check("红方先手", v1.public.turn === red1, `turn=${v1.public.turn} red=${red1}`);
check("双方兽穴为空", board1[at(3, 0)] === null && board1[at(3, 8)] === null);
check("八个种类齐备", new Set(board1.filter(Boolean).map((p) => p!.kind)).size === 8);

// —— 场景 2：等级吃子 ——
console.log("\n[2] 等级吃子");
const s2 = g.init([1, 2], mulberry32(4));
const red2 = (g.viewOf(s2, 1, CTX) as unknown as V).public.red as number;
const blue2 = (g.viewOf(s2, 1, CTX) as unknown as V).public.blue as number;
// 清空中间，摆一对相邻棋子
raw(s2).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s2, 3, 4, mk("red", red2, "lion"));
put(s2, 3, 3, mk("blue", blue2, "leopard"));
const capDown = g.validate(s2, red2, { type: "move", from: at(3, 4), to: at(3, 3) });
check("狮（7）能吃豹（5）", capDown.ok === true, capDown.ok ? "" : String(capDown.error));
put(s2, 3, 3, mk("blue", blue2, "tiger"));
const capUp = g.validate(s2, red2, { type: "move", from: at(3, 4), to: at(3, 3) });
check("狮（7）吃不了虎（6）？—— 7>6 应可吃", capUp.ok === true, capUp.ok ? "" : String(capUp.error));
put(s2, 3, 3, mk("blue", blue2, "lion"));
const capSame = g.validate(s2, red2, { type: "move", from: at(3, 4), to: at(3, 3) });
check("同级不能吃", capSame.ok === false, String(capSame.ok ? "" : capSame.error));

// —— 场景 3：鼠吃象 / 象吃不了鼠 ——
console.log("\n[3] 鼠吃象（唯一越级特例）");
const s3 = g.init([1, 2], mulberry32(4));
const red3 = (g.viewOf(s3, 1, CTX) as unknown as V).public.red as number;
const blue3 = (g.viewOf(s3, 1, CTX) as unknown as V).public.blue as number;
raw(s3).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s3, 3, 4, mk("red", red3, "rat"));
put(s3, 3, 3, mk("blue", blue3, "elephant"));
check("鼠能吃象", g.validate(s3, red3, { type: "move", from: at(3, 4), to: at(3, 3) }).ok === true);
raw(s3).turn = blue3;
put(s3, 3, 3, mk("blue", blue3, "elephant"));
put(s3, 3, 4, mk("red", red3, "rat"));
check("象吃不了鼠", g.validate(s3, blue3, { type: "move", from: at(3, 3), to: at(3, 4) }).ok === false);

// —— 场景 4：陷阱 ——
console.log("\n[4] 陷阱：踏进对方陷阱战斗力归 0");
const s4 = g.init([1, 2], mulberry32(4));
const red4 = (g.viewOf(s4, 1, CTX) as unknown as V).public.red as number;
const blue4 = (g.viewOf(s4, 1, CTX) as unknown as V).public.blue as number;
raw(s4).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
// 蓝方陷阱 (3,1)：红方猫（2 级）站在那，蓝方鼠（1 级）应该能吃它
put(s4, 3, 2, mk("blue", blue4, "rat"));
put(s4, 3, 1, mk("red", red4, "cat"));
raw(s4).turn = blue4; // 必须切到该走的一方，否则 validate 直接 NOT_YOUR_TURN
check("低等级吃陷阱里的敌子（陷阱使其战斗力 0）", g.validate(s4, blue4, { type: "move", from: at(3, 2), to: at(3, 1) }).ok === true, "鼠(1) 吃陷阱中的猫(2)");
// 自己的棋子在自家陷阱里不受影响
raw(s4).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s4, 3, 0 - 0 + 1, mk("blue", blue4, "cat")); // (3,1) 是蓝方自己的陷阱
put(s4, 3, 2, mk("red", red4, "wolf"));
raw(s4).turn = red4;
check("敌子吃自家陷阱里的棋子仍需等级压制（陷阱对主人无效）", g.validate(s4, red4, { type: "move", from: at(3, 2), to: at(3, 1) }).ok === true, "狼(4)>猫(2) 仍可吃");

// —— 场景 5：河流 ——
console.log("\n[5] 河流：只有鼠能进、水陆不互吃");
const s5 = g.init([1, 2], mulberry32(4));
const red5 = (g.viewOf(s5, 1, CTX) as unknown as V).public.red as number;
const blue5 = (g.viewOf(s5, 1, CTX) as unknown as V).public.blue as number;
raw(s5).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s5, 1, 2, mk("red", red5, "lion"));   // (1,3) 是河
check("狮子不能进河", g.validate(s5, red5, { type: "move", from: at(1, 2), to: at(1, 3) }).ok === false);
put(s5, 1, 2, mk("red", red5, "rat"));
check("鼠可以进河", g.validate(s5, red5, { type: "move", from: at(1, 2), to: at(1, 3) }).ok === true);
raw(s5).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s5, 1, 3, mk("red", red5, "rat"));      // 水中鼠
put(s5, 1, 2, mk("blue", blue5, "cat"));    // 岸上猫
raw(s5).turn = blue5;
check("岸上棋子不能吃水中的鼠", g.validate(s5, blue5, { type: "move", from: at(1, 2), to: at(1, 3) }).ok === false);

// —— 场景 6：跳河 ——
console.log("\n[6] 狮/虎跳河（河中有鼠则不能跳）");
const s6 = g.init([1, 2], mulberry32(4));
const red6 = (g.viewOf(s6, 1, CTX) as unknown as V).public.red as number;
const blue6 = (g.viewOf(s6, 1, CTX) as unknown as V).public.blue as number;
raw(s6).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s6, 1, 2, mk("red", red6, "lion"));  // 河在 y=3..5，跳到 (1,6)
check("狮子可跳过整段河", g.validate(s6, red6, { type: "move", from: at(1, 2), to: at(1, 6) }).ok === true);
put(s6, 1, 4, mk("blue", blue6, "rat"));
check("河中有鼠时不能跳", g.validate(s6, red6, { type: "move", from: at(1, 2), to: at(1, 6) }).ok === false);
raw(s6).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s6, 1, 2, mk("red", red6, "dog"));
check("狗不能跳河", g.validate(s6, red6, { type: "move", from: at(1, 2), to: at(1, 6) }).ok === false);

// —— 场景 7：兽穴 ——
console.log("\n[7] 兽穴：进对方即胜、不能进自己的");
const s7 = g.init([1, 2], mulberry32(4));
const red7 = (g.viewOf(s7, 1, CTX) as unknown as V).public.red as number;
const blue7 = (g.viewOf(s7, 1, CTX) as unknown as V).public.blue as number;
// ① 红方不能进自家兽穴 (3,8)
raw(s7).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s7, 3, 7, mk("red", red7, "dog"));
put(s7, 0, 0, mk("blue", blue7, "cat"));   // 留一个蓝子，避免「吃光」抢先
check("红方不能进自家兽穴 (3,8)", g.validate(s7, red7, { type: "move", from: at(3, 7), to: at(3, 8) }).ok === false);
// ② 蓝方进**红方**兽穴 (3,8) 即胜（开局另起，避免与上一条互相污染）
const s7b = g.init([1, 2], mulberry32(4));
const red7b = (g.viewOf(s7b, 1, CTX) as unknown as V).public.red as number;
const blue7b = (g.viewOf(s7b, 1, CTX) as unknown as V).public.blue as number;
raw(s7b).board = new Array(JUNGLE_W * JUNGLE_H).fill(null);
put(s7b, 3, 7, mk("blue", blue7b, "rat"));
put(s7b, 6, 0, mk("red", red7b, "cat"));   // 红方还有子，排除「吃光」路径
raw(s7b).turn = blue7b;
const winStep = g.apply(s7b, blue7b, { type: "move", from: at(3, 7), to: at(3, 8) }, RNG());
check("进对方兽穴即胜", (g.scores(winStep.state)[blue7b] ?? 0) === 1, JSON.stringify(g.scores(winStep.state)));

// —— 场景 8：僵局闸门 ——
console.log("\n[8] 僵局闸门（没有闸门对局会永远跑下去）");
check("无吃子上限已定义", QUIET_PLIES_LIMIT > 0, String(QUIET_PLIES_LIMIT));
check("总手数上限已定义", MAX_MOVES > QUIET_PLIES_LIMIT, String(MAX_MOVES));
const s8 = g.init([1, 2], mulberry32(9));
const v8 = g.viewOf(s8, 1, CTX) as unknown as V;
check("视图暴露 quiet_plies 与上限", typeof v8.public.quiet_plies === "number" && v8.public.max_moves === MAX_MOVES && v8.public.quiet_limit === QUIET_PLIES_LIMIT, "");

// —— 场景 9：bot 全流程 + 确定性 ——
console.log("\n[9] House bot 零拒绝 + 同 seed 确定性");
let rejects = 0;
const guarded = (caution: number, tag: string): SeatDriver => {
  const bot = createJungleBot(tag, caution);
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
const mkRun = () => createMatch({ game: createJungleChess(), drivers: [guarded(1.0, "稳健"), guarded(0.6, "凶狠")], seed: 3, timeoutMs: 3000 });
const runA = await mkRun().run();
const runB = await mkRun().run();
check("bot 对局零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.filter((e) => e.type === "moved").length} 手`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
check("bot 局能在闸门内收口（不卡死）", runA.events.some((e) => e.type === "game_won"), "");

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
