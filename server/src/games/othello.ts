/**
 * 黑白棋（Othello）—— MVP 协议试金石
 * 完全信息博弈：验证"有限动作集枚举 + 纯确定性（无随机）"路径
 * 座位 1 = 黑（先手），座位 2 = 白；动作 {type:"place", cell: 0-63}，无子可下时 {type:"pass"}
 * 终局：双方连续 pass 或棋盘下满，子多者胜（平局各 0.5）
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

interface State {
  board: number[]; // 64 格：0 空 / 1 黑 / 2 白
  blackSeat: SeatId;
  whiteSeat: SeatId;
  turn: SeatId;
  passes: number; // 连续 pass 计数，≥2 终局
  finished: boolean;
  lastMove: number | null;
}

const DIRS: [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function inBoard(r: number, c: number): boolean {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

/** 落子能翻转的对方棋子（空数组 = 非法落点） */
function flipsFor(board: number[], cell: number, player: number): number[] {
  if (board[cell] !== 0) return [];
  const opp = 3 - player;
  const r = Math.floor(cell / 8);
  const c = cell % 8;
  const all: number[] = [];
  for (const [dr, dc] of DIRS) {
    const line: number[] = [];
    let closed = false;
    let rr = r + dr;
    let cc = c + dc;
    while (inBoard(rr, cc)) {
      const v = board[rr * 8 + cc];
      if (v === opp) {
        line.push(rr * 8 + cc);
      } else if (v === player) {
        closed = line.length > 0;
        break;
      } else {
        break;
      }
      rr += dr;
      cc += dc;
    }
    if (closed) all.push(...line);
  }
  return all;
}

function legalCells(board: number[], player: number): number[] {
  const cells: number[] = [];
  for (let cell = 0; cell < 64; cell++) {
    if (board[cell] === 0 && flipsFor(board, cell, player).length > 0) cells.push(cell);
  }
  return cells;
}

function counts(board: number[]): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  for (const v of board) {
    if (v === 1) black++;
    else if (v === 2) white++;
  }
  return { black, white, empty: 64 - black - white };
}

/**
 * 座位 → 棋子颜色（1 黑 / 2 白）。
 * r30：棋盘此前直接写 `board[cell] = seat`，隐式假设"座位号恰好等于颜色"——
 * 当前座位恒为 1..N 所以不出错，但一旦席位非从 1 起编号（或将来扩到 >2 席），
 * 写入 3 号座位就会把棋盘写成非法值、flipsFor 的 `3 - player` 也随之失效。
 */
function colorOf(blackSeat: SeatId, seat: SeatId): number {
  return seat === blackSeat ? 1 : 2;
}

export function createOthello(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "othello", name: "黑白棋", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 60_000 },

    init(seats: SeatId[]): State {
      const board = new Array<number>(64).fill(0);
      board[27] = 2;
      board[28] = 1;
      board[35] = 1;
      board[36] = 2;
      return {
        board,
        blackSeat: seats[0],
        whiteSeat: seats[1] ?? 3 - seats[0],
        turn: seats[0],
        passes: 0,
        finished: false,
        lastMove: null,
      };
    },

    phase(s) {
      return s.finished ? "finished" : "move";
    },

    round(s) {
      return Math.floor((64 - counts(s.board).empty - 4) / 2) + 1;
    },

    activeSeats(s) {
      return s.finished ? [] : [s.turn];
    },

    legalActions(s, seat) {
      if (s.finished || s.turn !== seat) return [];
      const cells = legalCells(s.board, colorOf(s.blackSeat, seat));
      if (cells.length === 0) return [{ type: "pass", hint: "无合法落子，只能虚着" }];
      return [
        {
          type: "place",
          schema: { cell: "enum 0-63", values: cells },
          hint: "values 枚举当前全部合法落点",
        },
      ];
    },

    validate(s, seat, action) {
      if (s.finished) return { ok: false, error: "MATCH_FINISHED" };
      if (s.turn !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      if (action.type === "pass") {
        if (legalCells(s.board, colorOf(s.blackSeat, seat)).length > 0) {
          return { ok: false, error: "ILLEGAL_ACTION：有合法落子时不可虚着" };
        }
        return { ok: true };
      }
      if (action.type === "place") {
        const cell = action.cell;
        if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 63) {
          return { ok: false, error: "ILLEGAL_ACTION：cell 须为 0-63 的整数" };
        }
        if (flipsFor(s.board, cell as number, colorOf(s.blackSeat, seat)).length === 0) {
          return { ok: false, error: "ILLEGAL_ACTION：该落点无法翻转任何棋子" };
        }
        return { ok: true };
      }
      // r9 w9-d1：缺 action 字段/type 拼错时报「未知动作类型 undefined」不友好——指引排查方向
      return { ok: false, error: `ILLEGAL_ACTION：未知动作类型「${String(action.type)}」——须为 legal_actions 列出的 type 之一（缺 action 字段或 type 拼写错误都会走到这里）` };
    },

    apply(s, seat, action) {
      const events: { type: string; data?: Record<string, unknown> }[] = [];
      const other = seat === s.blackSeat ? s.whiteSeat : s.blackSeat;

      if (action.type === "pass") {
        s.passes += 1;
        s.lastMove = null;
        events.push({ type: "passed", data: { seat } });
        if (s.passes >= 2) {
          s.finished = true;
        } else {
          s.turn = other;
        }
        return { state: s, events };
      }

      const cell = action.cell as number;
      const color = colorOf(s.blackSeat, seat);
      const flips = flipsFor(s.board, cell, color);
      s.board[cell] = color;
      for (const f of flips) s.board[f] = color;
      s.passes = 0;
      s.lastMove = cell;
      s.turn = other;
      events.push({ type: "placed", data: { seat, cell, flipped: flips } });

      const c = counts(s.board);
      if (c.empty === 0) {
        s.finished = true;
        events.push({ type: "board_full", data: { black: c.black, white: c.white } });
      }
      return { state: s, events };
    },

    viewOf(s, viewer) {
      const c = counts(s.board);
      return {
        public: {
          board: [...s.board],
          turn: s.finished ? null : s.turn,
          colors: { black: s.blackSeat, white: s.whiteSeat },
          counts: { black: c.black, white: c.white },
          last_move: s.lastMove,
        },
        private: {}, // 完全信息博弈：无私有字段
      };
    },

    timeoutAction(s, seat) {
      const cells = legalCells(s.board, colorOf(s.blackSeat, seat));
      if (cells.length === 0) return { type: "pass" };
      return { type: "place", cell: cells[0] };
    },

    isTerminal(s) {
      return s.finished;
    },

    scores(s) {
      const c = counts(s.board);
      const out: Record<SeatId, number> = {};
      const blackScore = c.black > c.white ? 1 : c.black === c.white ? 0.5 : 0;
      out[s.blackSeat] = blackScore;
      out[s.whiteSeat] = 1 - blackScore;
      return out;
    },
  };

  return game;
}
