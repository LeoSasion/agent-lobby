/**
 * 斗兽棋（jungle_chess）—— 中文国民棋类 · 第十款游戏（r37 新增）
 *
 * 棋盘 7 列 × 9 行（x: 0-6, y: 0-8）。空心方在上（y=0-1），实心方在下（y=7-8）。
 *
 * 八种棋子与等级：象 8 > 狮 7 > 虎 6 > 豹 5 > 狼 4 > 狗 3 > 猫 2 > 鼠 1
 *   - 等级严格大于才能吃；同级不能互吃
 *   - **鼠可以吃象**（唯一的越级特例），象吃不了鼠
 *
 * 地形三件套（这款游戏的全部策略深度都在这里）：
 *   1. **河流** x∈{1,2,4,5} × y∈{3,4,5}：只有鼠能进；水中的棋子不能吃岸上的、也不能被岸上的吃
 *      （鼠鼠除外）。鼠不能从水里吃象。
 *   2. **陷阱** 空心方 (2,0)/(4,0)/(3,1)，实心方 (2,8)/(4,8)/(3,7)：进入**对方**陷阱的棋子
 *      战斗力归 0，任何棋子都能吃它。自己领地的陷阱对自己人无效。
 *   3. **兽穴** 空心方 (3,0)，实心方 (3,8)：进入**对方**兽穴即获胜；自己的棋子不能进自己的兽穴。
 *
 * 狮/虎额外能力：可以纵向跳过整段河流（落点必须是河对岸的陆地），**若河中有鼠阻挡则不能跳**。
 *
 * 胜负：进入对方兽穴，或吃光对方棋子。
 *
 * 与五子棋的关键差异（接第二款「带特殊地形的棋盘游戏」时要注意）：
 * 五子棋的法表可以用「r/c + 规则说明」打发（224 个空点），但斗兽棋必须**枚举合法走子**——
 * 因为「能不能吃」「能不能跳河」「是不是陷阱」这些都得由引擎判定，不能让客户端猜。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export const JUNGLE_W = 7;
export const JUNGLE_H = 9;
/** 总手数上限：超过判和（防死循环，必须有——不然两个 bot 能永远来回走） */
export const MAX_MOVES = 200;
/** 连续多少手无吃子判和：斗兽棋没有天然终止条件，僵局必须能收口 */
export const QUIET_PLIES_LIMIT = 80;

export type Rank = "rat" | "cat" | "dog" | "wolf" | "leopard" | "tiger" | "lion" | "elephant";
export const RANK_VALUE: Record<Rank, number> = {
  rat: 1, cat: 2, dog: 3, wolf: 4, leopard: 5, tiger: 6, lion: 7, elephant: 8,
};
export const RANK_LABEL: Record<Rank, string> = {
  rat: "鼠", cat: "猫", dog: "狗", wolf: "狼", leopard: "豹", tiger: "虎", lion: "狮", elephant: "象",
};

export type Side = "solid" | "hollow";
interface Piece {
  seat: SeatId;
  side: Side;
  kind: Rank;
}

interface State {
  seats: SeatId[];
  sideOf: Map<SeatId, Side>;
  /** 长度 W*H，index = y*W + x */
  board: (Piece | null)[];
  turn: SeatId;
  moves: { seat: SeatId; from: number; to: number; kind: Rank; captured: Rank | null }[];
  /** 连续多少手没有发生吃子（用于僵局判和） */
  quietPlies: number;
  phase: "playing" | "finished";
  winner: SeatId | "draw" | null;
  initEvents: GameEvent[];
}

const idx = (x: number, y: number): number => y * JUNGLE_W + x;
const xOf = (i: number): number => i % JUNGLE_W;
const yOf = (i: number): number => Math.floor(i / JUNGLE_W);
const inBoard = (x: number, y: number): boolean => x >= 0 && x < JUNGLE_W && y >= 0 && y < JUNGLE_H;

/** 河流：中间三行、两侧五列（x=3 是连通上下的陆地通道） */
export function isRiver(x: number, y: number): boolean {
  return y >= 3 && y <= 5 && x >= 1 && x <= 5 && x !== 3;
}

const HOLLOW_DEN = idx(3, 0);
const SOLID_DEN = idx(3, 8);
const HOLLOW_TRAPS = new Set([idx(2, 0), idx(4, 0), idx(3, 1)]);
const SOLID_TRAPS = new Set([idx(2, 8), idx(4, 8), idx(3, 7)]);

const denOf = (side: Side): number => (side === "hollow" ? HOLLOW_DEN : SOLID_DEN);
const trapsOf = (side: Side): Set<number> => (side === "hollow" ? HOLLOW_TRAPS : SOLID_TRAPS);

/** 初始布局：底线 6 子（兽穴居中不占位），次底线 2 子（象与鼠——最特殊的两个放二线） */
function initialBoard(seats: SeatId[], sideOf: Map<SeatId, Side>): (Piece | null)[] {
  const board = new Array<Piece | null>(JUNGLE_W * JUNGLE_H).fill(null);
  const place = (seat: SeatId, kind: Rank, x: number, y: number): void => {
    board[idx(x, y)] = { seat, side: sideOf.get(seat)!, kind };
  };
  const hollow = seats.find((s) => sideOf.get(s) === "hollow")!;
  const solid = seats.find((s) => sideOf.get(s) === "solid")!;
  const LINE: Rank[] = ["lion", "tiger", "leopard", "wolf", "dog", "cat"];
  // 空心方（上方）：兽穴 (3,0) 空着，两侧各三子
  LINE.forEach((k, i) => place(hollow, k, [0, 1, 2, 4, 5, 6][i]!, 0));
  place(hollow, "elephant", 2, 1);
  place(hollow, "rat", 4, 1);
  // 实心方（下方）镜像
  LINE.forEach((k, i) => place(solid, k, [0, 1, 2, 4, 5, 6][i]!, 8));
  place(solid, "elephant", 2, 7);
  place(solid, "rat", 4, 7);
  return board;
}

/** 能否吃：等级压制 + 鼠吃象特例；踏入**对手**陷阱的防守方战斗力归 0 */
function canCapture(attacker: Piece, defender: Piece, toIdx: number): boolean {
  if (attacker.seat === defender.seat) return false;
  // 防守方站在对手的陷阱里 → 战斗力 0，任何棋子可吃。
  // 注意别写成「defTraps.has(toIdx) && 对手陷阱.has(toIdx)」——两个集合互斥，那条件恒假。
  if (inOpponentTrap(defender.side, toIdx)) return true;
  if (attacker.kind === "rat" && defender.kind === "elephant") return true;
  if (attacker.kind === "elephant" && defender.kind === "rat") return false;
  return RANK_VALUE[attacker.kind] > RANK_VALUE[defender.kind];
}

/** 该格是否在「defSide 的对手」的陷阱里（即：defSide 的棋子站上去会失去战斗力） */
function inOpponentTrap(defSide: Side, i: number): boolean {
  return defSide === "hollow" ? SOLID_TRAPS.has(i) : HOLLOW_TRAPS.has(i);
}

export function createJungleChess(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "jungle_chess", name: "斗兽棋", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 60_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 2) throw new Error("jungle_chess 需要 2 席");
      // 先手（红/下方）由 seed 随机：固定座位执红会让 Elo 混入与实力无关的变量
      const solidFirst = rng() < 0.5;
      const sideOf = new Map<SeatId, Side>([
        [seats[0]!, solidFirst ? "solid" : "hollow"],
        [seats[1]!, solidFirst ? "hollow" : "solid"],
      ]);
      const solid = seats.find((s) => sideOf.get(s) === "solid")!;
      const s: State = {
        seats: [...seats],
        sideOf,
        board: initialBoard(seats, sideOf),
        turn: solid, // 红先
        moves: [],
        quietPlies: 0,
        phase: "playing",
        winner: null,
        initEvents: [
          {
            type: "sides_assigned",
            data: {
              solid: solid,
              hollow: seats.find((t) => sideOf.get(t) === "hollow")!,
              width: JUNGLE_W,
              height: JUNGLE_H,
            },
          },
        ],
      };
      return s;
    },

    initialEvents(state) {
      return state.initEvents.splice(0);
    },

    phase(s) {
      return s.phase;
    },

    round(s) {
      return s.moves.length + 1;
    },

    activeSeats(s) {
      return s.phase === "playing" ? [s.turn] : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || s.turn !== seat) return [];
      const targets: number[] = [];
      for (let i = 0; i < s.board.length; i++) {
        const p = s.board[i];
        if (!p || p.seat !== seat) continue;
        for (const to of destinations(s, i, p)) targets.push(i * 100 + to);
      }
      // 编码 from*100+to：枚举数量有限（每方最多 8 子 × 4 向 + 跳河），不会撑爆视图
      return [
        {
          type: "move",
          schema: { from: "int 0-62", to: "int 0-62", values: targets },
          hint: "values 枚举全部合法走子，编码为 from*100+to",
        },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (s.turn !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      if (action.type !== "move") return { ok: false, error: "ILLEGAL_ACTION：仅可 move" };
      const from = action.from;
      const to = action.to;
      if (typeof from !== "number" || typeof to !== "number") return { ok: false, error: "ILLEGAL_ACTION：from / to 须为数字" };
      if (from < 0 || from >= s.board.length || to < 0 || to >= s.board.length) {
        return { ok: false, error: "ILLEGAL_ACTION：坐标越界" };
      }
      const p = s.board[from];
      if (!p || p.seat !== seat) return { ok: false, error: "ILLEGAL_ACTION：起点不是你的棋子" };
      if (!destinations(s, from, p).includes(to)) return { ok: false, error: "ILLEGAL_ACTION：该走法不合法" };
      return { ok: true };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };
      const from = action.from as number;
      const to = action.to as number;
      const p = s.board[from]!;
      const target = s.board[to];
      s.board[from] = null;
      s.board[to] = p;
      s.moves.push({ seat, from, to, kind: p.kind, captured: target ? target.kind : null });
      events.push({
        type: "moved",
        data: {
          seat,
          from, to,
          from_xy: [xOf(from), yOf(from)],
          to_xy: [xOf(to), yOf(to)],
          kind: p.kind,
          captured: target ? target.kind : null,
        },
      });

      // 进入对方兽穴即胜
      const enemy = p.side === "hollow" ? "solid" : "hollow";
      if (to === denOf(enemy)) {
        return finish(s, events, seat, `${RANK_LABEL[p.kind]}闯入对方兽穴`);
      }
      // 吃光对方棋子
      const enemySeat = s.seats.find((t) => s.sideOf.get(t) === enemy)!;
      if (!s.board.some((q) => q && q.seat === enemySeat)) {
        return finish(s, events, seat, "吃光了对方全部棋子");
      }

      // 僵局收口：斗兽棋没有天然终止条件（不像五子棋有「棋盘下满」），
      // 双方可以无限来回走。必须有两个闸门，否则对局会永远跑下去（实测卡死 2 分半）。
      s.quietPlies = target ? 0 : s.quietPlies + 1;
      if (s.moves.length >= MAX_MOVES) {
        return endDraw(s, events, `达到 ${MAX_MOVES} 手上限`);
      }
      if (s.quietPlies >= QUIET_PLIES_LIMIT) {
        return endDraw(s, events, `连续 ${QUIET_PLIES_LIMIT} 手无吃子`);
      }

      s.turn = s.seats.find((t) => t !== seat)!;
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const pub: Record<string, unknown> = {
        width: JUNGLE_W,
        height: JUNGLE_H,
        phase: s.phase,
        turn: s.phase === "playing" ? s.turn : null,
        solid: s.seats.find((t) => s.sideOf.get(t) === "solid") ?? null,
        hollow: s.seats.find((t) => s.sideOf.get(t) === "hollow") ?? null,
        board: s.board.map((p) => (p ? { seat: p.seat, side: p.side, kind: p.kind } : null)),
        last_move: s.moves.length ? s.moves[s.moves.length - 1] : null,
        // 地形静态信息交给前端：河流 / 陷阱 / 兽穴（不会变，但每次给比让客户端自己算更稳）
        rivers: Array.from({ length: JUNGLE_W * JUNGLE_H }, (_, i) => isRiver(xOf(i), yOf(i))),
        dens: { hollow: HOLLOW_DEN, solid: SOLID_DEN },
        traps: { hollow: [...HOLLOW_TRAPS], solid: [...SOLID_TRAPS] },
        quiet_plies: s.quietPlies,
        max_moves: MAX_MOVES,
        quiet_limit: QUIET_PLIES_LIMIT,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((a, b) => a - b) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return { public: pub, private: { my_side: s.sideOf.get(viewer) ?? null } };
    },

    timeoutAction(s, seat) {
      // 兜底：走第一个合法走子（确定性，且保证合法——同五子棋的教训：兜底不能是常量）
      const mine = s.board.findIndex((p) => p && p.seat === seat);
      if (mine < 0) return { type: "move", from: 0, to: 0 };
      const dest = destinations(s, mine, s.board[mine]!);
      return { type: "move", from: mine, to: dest[0] ?? mine };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) out[t] = s.winner === null ? 0 : s.winner === "draw" ? 0.5 : t === s.winner ? 1 : 0;
      return out;
    },

    seatAlive() {
      return true;
    },

    placements(s) {
      if (s.winner === null || s.winner === "draw") return s.seats.map((seat) => ({ seat, rank: 1 }));
      return [
        { seat: s.winner, rank: 1, note: s.sideOf.get(s.winner) === "solid" ? "实心方" : "空心方" },
        { seat: s.seats.find((t) => t !== s.winner)!, rank: 2 },
      ];
    },
  };

  function finish(s: State, events: GameEvent[], winner: SeatId, reason: string): { state: State; events: GameEvent[] } {
    s.phase = "finished";
    s.winner = winner;
    events.push({ type: "game_won", data: { winner, side: s.sideOf.get(winner), moves: s.moves.length, reason } });
    return { state: s, events };
  }

  /** 僵局判和：不判任何人胜——「谁也没赢」比随便挑一个赢家诚实 */
  function endDraw(s: State, events: GameEvent[], reason: string): { state: State; events: GameEvent[] } {
    s.phase = "finished";
    s.winner = "draw";
    events.push({ type: "game_won", data: { winner: "draw", moves: s.moves.length, reason } });
    return { state: s, events };
  }

  return game;
}

/** 某棋子的全部合法落点（含吃子、跳河、陷阱判定） */
function destinations(s: State, from: number, p: Piece): number[] {
  const x = xOf(from);
  const y = yOf(from);
  const out: number[] = [];
  const canEnter = (tx: number, ty: number): boolean => {
    // 河：只有鼠能进；其他棋子一律不能
    if (isRiver(tx, ty) && p.kind !== "rat") return false;
    return true;
  };
  const tryStep = (tx: number, ty: number): void => {
    if (!inBoard(tx, ty)) return;
    if (!canEnter(tx, ty)) return;
    const ti = idx(tx, ty);
    if (ti === denOf(p.side)) return; // 不能进自己的兽穴
    const q = s.board[ti];
    if (!q) { out.push(ti); return; }
    if (q.seat === p.seat) return;
    // 水中与岸上不能互吃：鼠能上岸，但水中鼠吃不到岸上、岸上也吃不到水中鼠。
    // （标准规则里唯一的例外是「水中鼠不能吃岸上的象」，既然全都不能吃，就不需要特判了）
    if (isRiver(x, y) !== isRiver(tx, ty)) return;
    if (canCapture(p, q, ti)) out.push(ti);
  };

  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    tryStep(x + dx, y + dy);
  }

  // 狮/虎跳河：纵向跳过连续水域，落点须是对岸陆地，且河中无鼠
  if (p.kind === "lion" || p.kind === "tiger") {
    for (const dy of [-1, 1] as const) {
      let ty = y + dy;
      let crossed = 0;
      let blocked = false;
      while (inBoard(x, ty) && isRiver(x, ty)) {
        if (s.board[idx(x, ty)]) { blocked = true; break; }
        crossed++;
        ty += dy;
      }
      if (blocked || crossed === 0) continue;
      if (!inBoard(x, ty) || isRiver(x, ty)) continue;
      const ti = idx(x, ty);
      if (ti === denOf(p.side)) continue;
      const q = s.board[ti];
      if (!q) out.push(ti);
      else if (q.seat !== p.seat && canCapture(p, q, ti)) out.push(ti);
    }
  }

  return [...new Set(out)];
}
