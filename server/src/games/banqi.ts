/**
 * 军棋·翻棋（banqi）—— 暗棋 · 翻子 + 象棋走法 · 第十五款（r38）
 *
 * 8×4 = 32 格，32 枚棋子**背面朝下随机分布**。每步二选一：翻一张暗棋，或走自己的明棋。
 * 翻开的归属由棋子本身的阵营决定（开局时已随机打乱，所以双方棋子是混在一起的）。
 *
 * 棋子与等级（每方 16 枚）：
 *   帅 7 ×1 · 仕 6 ×2 · 相 5 ×2 · 车 4 ×2 · 马 3 ×2 · 炮 2 ×2 · 兵 1 ×5
 * 吃子：等级高吃低，同级不能吃；**兵能吃帅**（唯一越级），帅吃不了兵。
 *
 * 走法（在暗棋基础上做简化，保证可玩且规则自洽）：
 *   - 车：直线任意格（路径无障碍）
 *   - 马：日字（**不绊马腿**——简化，否则 8×4 小盘上马几乎动不了）
 *   - 炮：不吃子时直线走；吃子必须**隔一个棋子**（隔的那个是谁都行）
 *   - 兵：向前一格或横向一格（不能后退）
 *   - 帅/仕/相：走一格（上下左右）
 *
 * 胜负：吃光对方棋子即胜。另设 200 步上限判和（与斗兽棋同理：没有天然终点就必须有闸门）。
 *
 * 与斗兽棋的区别（同为「8 格宽的棋盘 + 等级吃子」，容易混）：
 * 斗兽棋是**完全信息 + 地形**（河流/陷阱/兽穴）；翻棋是**不完全信息 + 象棋走法**（车马炮兵各异），
 * 而且棋子归属在翻开前无人知道——这层「未知」是物理性的，不需要谁扮演。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";
import { winnerScores } from "./shared.ts";

export const BQ_W = 8;
export const BQ_H = 4;
export const BQ_MAX_PLY = 200;

export type Side = "solid" | "hollow";
export type Rank = "king" | "advisor" | "elephant" | "chariot" | "horse" | "cannon" | "soldier";

export const RANK_VALUE: Record<Rank, number> = {
  king: 7, advisor: 6, elephant: 5, chariot: 4, horse: 3, cannon: 2, soldier: 1,
};
export const RANK_LABEL: Record<Rank, string> = {
  king: "帅", advisor: "仕", elephant: "相", chariot: "车", horse: "马", cannon: "炮", soldier: "兵",
};
/** 每方棋子构成（合计 16） */
const ROSTER: [Rank, number][] = [["king", 1], ["advisor", 2], ["elephant", 2], ["chariot", 2], ["horse", 2], ["cannon", 2], ["soldier", 5]];

export interface Piece {
  kind: Rank;
  side: Side;
  faceUp: boolean;
}

interface State {
  seats: SeatId[];
  sideOf: Map<SeatId, Side>;
  board: (Piece | null)[];
  turn: SeatId;
  ply: number;
  moves: { seat: SeatId; kind: "flip" | "move"; from: number; to: number | null; captured?: Rank }[];
  phase: "playing" | "finished";
  winner: SeatId | "draw" | null;
  initEvents: GameEvent[];
}

const inBoard = (x: number, y: number): boolean => x >= 0 && x < BQ_W && y >= 0 && y < BQ_H;
const idx = (x: number, y: number): number => y * BQ_W + x;
const xOf = (i: number): number => i % BQ_W;
const yOf = (i: number): number => Math.floor(i / BQ_W);

/** 能否吃：等级压制 + 兵吃帅特例 */
export function canCapture(attacker: Piece, defender: Piece): boolean {
  if (attacker.side === defender.side) return false;
  if (attacker.kind === "soldier" && defender.kind === "king") return true;
  if (attacker.kind === "king" && defender.kind === "soldier") return false;
  return RANK_VALUE[attacker.kind] > RANK_VALUE[defender.kind];
}

/** 该席位是否还有任何动作（翻暗棋 或 走自己的明棋）。导出仅供冒烟直接验证。 */
export function hasAnyAction(s: State, seat: SeatId): boolean {
  if (s.board.some((p) => p && !p.faceUp)) return true; // 还有暗棋可翻
  const side = s.sideOf.get(seat);
  for (let i = 0; i < s.board.length; i++) {
    const p = s.board[i];
    if (!p || !p.faceUp || p.side !== side) continue;
    if (destinations(s, i).length > 0) return true;
  }
  return false;
}

/** 走法生成：不含翻子 */
export function destinations(s: State, from: number): number[] {
  const p = s.board[from];
  if (!p || !p.faceUp) return [];
  const x = xOf(from);
  const y = yOf(from);
  const out: number[] = [];
  const tryCell = (tx: number, ty: number, cannonShot = false): boolean => {
    if (!inBoard(tx, ty)) return false;
    const ti = idx(tx, ty);
    const q = s.board[ti];
    if (!q) {
      if (!cannonShot) out.push(ti);
      return true; // 空位：可继续（直线）/ 可落（非炮）
    }
    // 有子
    if (cannonShot) {
      // 炮吃子：中间恰隔一子由调用方保证，这里只判吃不吃
      if (q.faceUp && canCapture(p, q)) out.push(ti);
      return false;
    }
    if (q.faceUp && canCapture(p, q)) out.push(ti);
    return false; // 挡路
  };

  if (p.kind === "chariot") {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      for (let k = 1; k < Math.max(BQ_W, BQ_H); k++) {
        const tx = x + dx * k, ty = y + dy * k;
        if (!inBoard(tx, ty)) break;
        const ti = idx(tx, ty);
        const q = s.board[ti];
        if (!q) { out.push(ti); continue; }
        if (q.faceUp && canCapture(p, q)) out.push(ti);
        break;
      }
    }
  } else if (p.kind === "cannon") {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      let screen = false;
      for (let k = 1; k < Math.max(BQ_W, BQ_H); k++) {
        const tx = x + dx * k, ty = y + dy * k;
        if (!inBoard(tx, ty)) break;
        const ti = idx(tx, ty);
        const q = s.board[ti];
        if (!screen) {
          if (!q) { out.push(ti); continue; }
          screen = true; // 遇到第一个子，后面是炮架
          continue;
        }
        // 已越过炮架：只有第一个子可被吃，且**炮不受等级限制**（炮打隔山）
        if (q && q.faceUp && q.side !== p.side) out.push(ti);
        break;
      }
    }
  } else if (p.kind === "horse") {
    for (const [dx, dy] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]] as const) {
      tryCell(x + dx, y + dy);
    }
  } else if (p.kind === "soldier") {
    const forward = p.side === "solid" ? -1 : 1; // solid 在下方（y 大），向 y 减小方向前进
    tryCell(x, y + forward);
    tryCell(x - 1, y);
    tryCell(x + 1, y);
  } else {
    // 帅 / 仕 / 相：一格
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) tryCell(x + dx, y + dy);
  }
  return [...new Set(out)];
}

function shuffledRoster(rng: Rng): Piece[] {
  const list: Piece[] = [];
  for (const side of ["solid", "hollow"] as const) {
    for (const [kind, n] of ROSTER) for (let i = 0; i < n; i++) list.push({ kind, side, faceUp: false });
  }
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = list[i]!;
    list[i] = list[j]!;
    list[j] = t;
  }
  return list;
}

export function createBanqi(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "banqi", name: "军棋·翻棋", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 50_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 2) throw new Error("banqi 需要 2 席");
      const solidFirst = rng() < 0.5;
      const sideOf = new Map<SeatId, Side>([
        [seats[0]!, solidFirst ? "solid" : "hollow"],
        [seats[1]!, solidFirst ? "hollow" : "solid"],
      ]);
      const ring = shuffledRoster(rng);
      const board: (Piece | null)[] = new Array(BQ_W * BQ_H).fill(null);
      for (let i = 0; i < board.length; i++) board[i] = ring[i] ?? null;
      const solidSeat = seats.find((t) => sideOf.get(t) === "solid")!;
      const s: State = {
        seats: [...seats],
        sideOf,
        board,
        turn: solidSeat,
        ply: 0,
        moves: [],
        phase: "playing",
        winner: null,
        initEvents: [
          { type: "board_dealt", data: { width: BQ_W, height: BQ_H, solid: solidSeat, hollow: seats.find((t) => sideOf.get(t) === "hollow")! } },
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
      return s.ply + 1;
    },

    activeSeats(s) {
      return s.phase === "playing" ? [s.turn] : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || s.turn !== seat) return [];
      const flips: number[] = [];
      const moves: number[] = [];
      for (let i = 0; i < s.board.length; i++) {
        const p = s.board[i];
        if (!p) continue;
        if (!p.faceUp) flips.push(i);
        else if (p.side === s.sideOf.get(seat)) {
          for (const to of destinations(s, i)) moves.push(i * 100 + to);
        }
      }
      const acts: LegalAction[] = [];
      if (flips.length) acts.push({ type: "flip", schema: { cell: "int 0-31", values: flips }, hint: "翻一张暗棋" });
      if (moves.length) acts.push({ type: "move", schema: { from: "int 0-31", to: "int 0-31", values: moves }, hint: "移动自己的明棋（编码 from*100+to）" });
      return acts;
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (s.turn !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      if (action.type === "flip") {
        const cell = action.cell;
        if (typeof cell !== "number" || cell < 0 || cell >= s.board.length) return { ok: false, error: "ILLEGAL_ACTION：格子越界" };
        const p = s.board[cell];
        if (!p) return { ok: false, error: "ILLEGAL_ACTION：该格是空的" };
        if (p.faceUp) return { ok: false, error: "ILLEGAL_ACTION：该格已经翻开" };
        return { ok: true };
      }
      if (action.type === "move") {
        const from = action.from;
        const to = action.to;
        if (typeof from !== "number" || typeof to !== "number") return { ok: false, error: "ILLEGAL_ACTION：from / to 须为数字" };
        if (from < 0 || from >= s.board.length || to < 0 || to >= s.board.length) return { ok: false, error: "ILLEGAL_ACTION：坐标越界" };
        const p = s.board[from];
        if (!p || !p.faceUp) return { ok: false, error: "ILLEGAL_ACTION：起点不是已翻开的棋子" };
        if (p.side !== s.sideOf.get(seat)) return { ok: false, error: "ILLEGAL_ACTION：那不是你的棋子" };
        if (!destinations(s, from).includes(to)) return { ok: false, error: "ILLEGAL_ACTION：该走法不合法" };
        return { ok: true };
      }
      return { ok: false, error: "ILLEGAL_ACTION：仅可 flip 或 move" };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };
      s.ply += 1;

      if (action.type === "flip") {
        const cell = action.cell as number;
        const p = s.board[cell]!;
        p.faceUp = true;
        s.moves.push({ seat, kind: "flip", from: cell, to: null });
        events.push({ type: "flipped", data: { seat, cell, kind: p.kind, side: p.side } });
      } else {
        const from = action.from as number;
        const to = action.to as number;
        const p = s.board[from]!;
        const target = s.board[to];
        s.board[from] = null;
        s.board[to] = p;
        s.moves.push({ seat, kind: "move", from, to, captured: target?.kind });
        events.push({
          type: "moved",
          data: {
            seat, from, to,
            from_xy: [xOf(from), yOf(from)],
            to_xy: [xOf(to), yOf(to)],
            kind: p.kind,
            captured: target?.kind ?? null,
          },
        });
        // 吃光对方 → 胜
        const enemySide: Side = p.side === "solid" ? "hollow" : "solid";
        if (!s.board.some((q) => q && q.side === enemySide)) {
          s.phase = "finished";
          s.winner = seat;
          events.push({ type: "game_won", data: { winner: seat, ply: s.ply, reason: "吃光了对方全部棋子" } });
          return { state: s, events };
        }
      }

      if (s.ply >= BQ_MAX_PLY) {
        s.phase = "finished";
        s.winner = "draw";
        events.push({ type: "game_won", data: { winner: "draw", ply: s.ply, reason: `达到 ${BQ_MAX_PLY} 步上限` } });
        return { state: s, events };
      }

      const nextSeat = s.seats.find((t) => t !== seat)!;
      // 无子可动判负：没有暗棋可翻、自己的明棋也全被堵死时，对方一动作也没有。
      // 不补这条的话，超时兜底会因找不到合法动作而非法，对局被当成「游戏模块缺陷」判失败。
      if (!hasAnyAction(s, nextSeat)) {
        s.phase = "finished";
        s.winner = seat;
        events.push({ type: "game_won", data: { winner: seat, ply: s.ply, reason: "对方无子可动" } });
        return { state: s, events };
      }
      s.turn = nextSeat;
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const pub: Record<string, unknown> = {
        width: BQ_W,
        height: BQ_H,
        phase: s.phase,
        turn: s.phase === "playing" ? s.turn : null,
        solid: s.seats.find((t) => s.sideOf.get(t) === "solid") ?? null,
        hollow: s.seats.find((t) => s.sideOf.get(t) === "hollow") ?? null,
        // 暗棋只给 {faceUp:false}——**不能带 side/kind**，否则翻子机制直接失效
        board: s.board.map((p) => (p ? (p.faceUp ? { faceUp: true, side: p.side, kind: p.kind } : { faceUp: false }) : null)),
        last_move: s.moves.length ? s.moves[s.moves.length - 1] : null,
        ply: s.ply,
        max_ply: BQ_MAX_PLY,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((a, b) => a - b) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return { public: pub, private: { my_side: s.sideOf.get(viewer) ?? null } };
    },

    timeoutAction(s, seat) {
      // 优先翻一张暗棋（比随便走子更少自毁）
      for (let i = 0; i < s.board.length; i++) {
        const p = s.board[i];
        if (p && !p.faceUp) return { type: "flip", cell: i };
      }
      // 没有暗棋：遍历**全部**自己的棋子找走法——只看第一个会在它被堵死时返回非法动作
      for (let i = 0; i < s.board.length; i++) {
        const p = s.board[i];
        if (!p || !p.faceUp || p.side !== s.sideOf.get(seat)) continue;
        const dest = destinations(s, i);
        if (dest.length) return { type: "move", from: i, to: dest[0]! };
      }
      return { type: "flip", cell: 0 };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      return winnerScores(s.seats, s.winner);
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

  return game;
}
