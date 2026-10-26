/**
 * House Bot（五子棋）—— 单点启发式评分，不做搜索
 *
 * 决策顺序（每一步都先看前两条，绝大多数局面在第 1-2 条就返回）：
 *   1. 我能立刻成五 → 下那里
 *   2. 对手能立刻成五 → 堵那里
 *   3. 否则对每个空点算「我方潜力 + 对手潜力」，取最高
 *
 * 为什么不做极小化极大搜索：五子棋分支因子 ~200，2 层搜索就是 4 万次评估，
 * 而 house bot 的价值只是给 quickstart 补位——搜得再深也打不过真实 LLM。
 * 规则 bot 的定位是「不犯低级错误」，不是「强」。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { BOARD_SIZE, WIN_LEN } from "../games/gomoku.ts";

const SIZE = BOARD_SIZE;
const inBoard = (r: number, c: number): boolean => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const DIRS: readonly [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

interface LineInfo {
  count: number;
  open: number;
}

/** 假设 seat 落在 (r,c) 后，某方向的连子长度与两端开放数 */
function lineInfo(board: (number | null)[], r: number, c: number, dr: number, dc: number, seat: number): LineInfo {
  let count = 1;
  let open = 0;
  for (const sign of [1, -1] as const) {
    let rr = r + dr * sign;
    let cc = c + dc * sign;
    while (inBoard(rr, cc) && board[rr * SIZE + cc] === seat) {
      count++;
      rr += dr * sign;
      cc += dc * sign;
    }
    if (inBoard(rr, cc) && board[rr * SIZE + cc] === null) open++;
  }
  return { count, open };
}

/** 连子形态 → 分数（五连最高，活四次之，以此类推） */
function shapeScore({ count, open }: LineInfo): number {
  if (count >= WIN_LEN) return 1e9;
  if (count === 4) return open === 2 ? 1e6 : open === 1 ? 1e4 : 0;
  if (count === 3) return open === 2 ? 1e3 : open === 1 ? 1e2 : 0;
  if (count === 2) return open === 2 ? 1e2 : open === 1 ? 10 : 0;
  return open === 2 ? 10 : open === 1 ? 1 : 0;
}

/** 单点对我方的价值（四方向取最好的一向） */
function pointScore(board: (number | null)[], idx: number, seat: number): number {
  const r = Math.floor(idx / SIZE);
  const c = idx % SIZE;
  let best = 0;
  for (const [dr, dc] of DIRS) {
    const sc = shapeScore(lineInfo(board, r, c, dr, dc, seat));
    if (sc > best) best = sc;
    if (best >= 1e9) break;
  }
  return best;
}

export function createGomokuBot(name: string, aggression = 0.9): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { board?: (number | null)[]; size?: number; win_len?: number };
      const board = pub.board;
      const me = (view.you as { seat?: number } | undefined)?.seat;
      if (!Array.isArray(board) || typeof me !== "number") {
        submit({ type: "place", r: 0, c: 0 });
        return;
      }
      const empties: number[] = [];
      for (let i = 0; i < board.length; i++) if (board[i] === null) empties.push(i);
      if (empties.length === 0) {
        submit({ type: "place", r: 0, c: 0 });
        return;
      }

      const opps = new Set<number>();
      for (const v of board) if (typeof v === "number") opps.add(v);
      const opp = [...opps].find((x) => x !== me);

      // 1) 立刻成五
      for (const idx of empties) {
        if (pointScore(board, idx, me) >= 1e9) {
          submit({ type: "place", r: Math.floor(idx / SIZE), c: idx % SIZE });
          return;
        }
      }
      // 2) 堵对手的五
      if (typeof opp === "number") {
        for (const idx of empties) {
          if (pointScore(board, idx, opp) >= 1e9) {
            submit({ type: "place", r: Math.floor(idx / SIZE), c: idx % SIZE });
            return;
          }
        }
      }
      // 3) 综合评估：自己的潜力 + 对手在这个点的潜力（乘系数，稍偏进攻）
      let bestIdx = empties[0]!;
      let bestVal = -Infinity;
      for (const idx of empties) {
        const r = Math.floor(idx / SIZE);
        const c = idx % SIZE;
        const mine = pointScore(board, idx, me);
        const theirs = typeof opp === "number" ? pointScore(board, idx, opp) : 0;
        const center = Math.floor(SIZE / 2);
        const bias = center - Math.max(Math.abs(r - center), Math.abs(c - center));
        const val = mine + theirs * aggression + bias;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = idx;
        }
      }
      submit({ type: "place", r: Math.floor(bestIdx / SIZE), c: bestIdx % SIZE });
    },
  };
}
