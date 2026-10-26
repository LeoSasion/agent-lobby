/**
 * 五子棋（gomoku）—— 完全信息 · 纯规则对弈 · 第九款游戏（r36 新增）
 *
 * 为什么放在棋类里第一款：它**不依赖任何外部数据**（不像成语接龙要词库、飞花令要诗库），
 * 判定 100% 客观（五连就是五连），是验证「2 席棋盘类能被框架复用」的最干净样本。
 *
 * 规则：15×15，双方轮流落子，先连成 5 子（横/竖/斜）者胜；棋盘下满无五连则平局。
 * 先手（执黑）由 seed 随机分配——这不是小事：五子棋黑棋有先手优势，
 * 若固定座位 1 执黑，长期 Elo 会混入「抽到座位 1」这个与实力无关的变量。
 *
 * 与黑白棋的两处关键差异（接第二款棋盘游戏时最容易照抄错的地方）：
 * 1. **法表不能枚举**：黑白棋用 `enum` 列出全部合法点（8×8 里通常只有几个到十几个），
 *    五子棋开局有 224 个空点，枚举会把视图撑爆——所以用 `r`/`c` 双坐标 + 规则说明。
 * 2. **没有 pass**：黑白棋无子可下时允许虚着；五子棋只有「棋盘满」才结束，不存在无点可下。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export const BOARD_SIZE = 15;
export const WIN_LEN = 5;

type Cell = SeatId | null;

interface Move {
  seat: SeatId;
  r: number;
  c: number;
  n: number;
}

interface State {
  seats: SeatId[];
  black: SeatId;
  white: SeatId;
  /** 长度 SIZE*SIZE，index = r*SIZE + c */
  board: Cell[];
  turn: SeatId;
  moves: Move[];
  phase: "playing" | "finished";
  winner: SeatId | "draw" | null;
  /** 获胜的五个（或更多）连子坐标，供前端高亮 */
  winLine: number[] | null;
  initEvents: GameEvent[];
}

const inBoard = (r: number, c: number): boolean => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;

/** 从落点向四个方向数同色连子；返回成五的那条线（含落点），否则 null */
function findWinLine(board: Cell[], idx: number, seat: SeatId): number[] | null {
  const r0 = Math.floor(idx / BOARD_SIZE);
  const c0 = idx % BOARD_SIZE;
  const dirs: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const line = [idx];
    for (const sign of [1, -1] as const) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (inBoard(r, c) && board[r * BOARD_SIZE + c] === seat) {
        line.push(r * BOARD_SIZE + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= WIN_LEN) return line.sort((a, b) => a - b);
  }
  return null;
}

export function createGomoku(config: { size?: number } = {}): GameModule<State> {
  const size = Math.max(WIN_LEN, Math.min(19, config.size ?? BOARD_SIZE));
  void size; // 尺寸固定为 BOARD_SIZE：渲染层与索引计算都基于常量，暂不支持自定义

  const game: GameModule<State> = {
    meta: { id: "gomoku", name: "五子棋", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 60_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 2) throw new Error("gomoku 需要 2 席");
      const black = rng() < 0.5 ? seats[0]! : seats[1]!;
      const white = seats[0] === black ? seats[1]! : seats[0]!;
      const s: State = {
        seats: [...seats],
        black,
        white,
        board: new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(null),
        turn: black,
        moves: [],
        phase: "playing",
        winner: null,
        winLine: null,
        initEvents: [{ type: "color_assigned", data: { black, white, size: BOARD_SIZE, win_len: WIN_LEN } }],
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
      // 不枚举空位：开局就有 224 个空点，枚举会让视图与法表同时爆炸。
      // 规则说明已足够——落点为空即可。
      return [
        {
          type: "place",
          schema: { r: `int 0-${BOARD_SIZE - 1}`, c: `int 0-${BOARD_SIZE - 1}`, rule: "落点必须为空" },
          hint: "横坐标为 r、纵坐标为 c（均从 0 起），落在空点上",
        },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (s.turn !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      if (action.type !== "place") return { ok: false, error: "ILLEGAL_ACTION：仅可 place" };
      const r = action.r;
      const c = action.c;
      if (typeof r !== "number" || typeof c !== "number" || !Number.isInteger(r) || !Number.isInteger(c)) {
        return { ok: false, error: "ILLEGAL_ACTION：r / c 须为整数" };
      }
      if (!inBoard(r, c)) return { ok: false, error: `ILLEGAL_ACTION：坐标越界（0-${BOARD_SIZE - 1}）` };
      if (s.board[r * BOARD_SIZE + c] !== null) return { ok: false, error: "ILLEGAL_ACTION：该点已有子" };
      return { ok: true };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };
      const r = action.r as number;
      const c = action.c as number;
      const idx = r * BOARD_SIZE + c;
      s.board[idx] = seat;
      const n = s.moves.length + 1;
      s.moves.push({ seat, r, c, n });
      events.push({
        type: "placed",
        data: { seat, r, c, n, color: seat === s.black ? "black" : "white" },
      });

      const line = findWinLine(s.board, idx, seat);
      if (line) {
        s.phase = "finished";
        s.winner = seat;
        s.winLine = line;
        events.push({
          type: "game_won",
          data: {
            winner: seat,
            color: seat === s.black ? "black" : "white",
            win_line: line,
            moves: s.moves.length,
            reason: `${seat} 号连成 ${WIN_LEN} 子`,
          },
        });
        return { state: s, events };
      }

      if (s.moves.length >= BOARD_SIZE * BOARD_SIZE) {
        s.phase = "finished";
        s.winner = "draw";
        events.push({
          type: "game_won",
          data: { winner: "draw", moves: s.moves.length, reason: "棋盘下满，无人成五" },
        });
        return { state: s, events };
      }

      s.turn = s.turn === s.black ? s.white : s.black;
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const pub: Record<string, unknown> = {
        size: BOARD_SIZE,
        win_len: WIN_LEN,
        phase: s.phase,
        black: s.black,
        white: s.white,
        turn: s.phase === "playing" ? s.turn : null,
        board: s.board,
        moves: s.moves,
        last_move: s.moves.length ? s.moves[s.moves.length - 1] : null,
        win_line: s.winLine,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return {
        public: pub,
        private: { my_color: viewer === s.black ? "black" : "white" },
      };
    },

    timeoutAction(s) {
      // 超时没有「安全默认落子」这回事（任何一手都可能自毁），但协议要求确定性兜底。
      // 取棋盘上第一个空点——**绝不能硬编码 (0,0)**：那个点很可能已被占用，
      // 落在已占点会 validate 失败，超时动作被拒 → 对局直接卡死。
      const idx = s.board.findIndex((x) => x === null);
      const at = idx < 0 ? 0 : idx;
      return { type: "place", r: Math.floor(at / BOARD_SIZE), c: at % BOARD_SIZE };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) {
        out[t] = s.winner === null ? 0 : s.winner === "draw" ? 0.5 : t === s.winner ? 1 : 0;
      }
      return out;
    },

    seatAlive() {
      return true;
    },

    placements(s) {
      if (s.winner === null || s.winner === "draw") return s.seats.map((seat) => ({ seat, rank: 1 }));
      return [
        { seat: s.winner, rank: 1, note: s.winner === s.black ? "执黑" : "执白" },
        { seat: s.winner === s.black ? s.white : s.black, rank: 2 },
      ];
    },
  };

  return game;
}
