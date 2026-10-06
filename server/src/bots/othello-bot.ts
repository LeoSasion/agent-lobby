/**
 * 黑白棋规则型 House Bot
 * 只依赖 public 信息（棋盘 + legal_actions 枚举），自行复算翻转数——顺带验证公域信息充分性
 * 三种风格：位置流（角优先）/ 吃子流（多翻转）/ 蒸发流（少翻转，逼对手铺子）
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

const WEIGHTS = [
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120,
];

const DIRS: [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function countFlips(board: number[], cell: number, player: number): number {
  if (board[cell] !== 0) return 0;
  const opp = 3 - player;
  const r = Math.floor(cell / 8);
  const c = cell % 8;
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let n = 0;
    let rr = r + dr;
    let cc = c + dc;
    let closed = false;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = board[rr * 8 + cc];
      if (v === opp) {
        n++;
      } else if (v === player) {
        closed = n > 0;
        break;
      } else {
        break;
      }
      rr += dr;
      cc += dc;
    }
    if (closed) total += n;
  }
  return total;
}

function legalCellsFrom(view: AgentView): number[] {
  const place = view.legal_actions.find((a) => a.type === "place");
  if (!place) return [];
  return ((place.schema?.values ?? []) as unknown[]).filter((v): v is number => typeof v === "number");
}

export function createOthelloBot(name: string, style: 0 | 1 | 2 = 0): SeatDriver {
  return {
    name,
    act: async (view, submit) => {
      const cells = legalCellsFrom(view);
      if (cells.length === 0) {
        submit({ type: "pass" });
        return;
      }
      const board = view.public.board as number[];
      const seat = view.you.seat;
      let best = cells[0];
      let bestScore = -Infinity;
      for (const cell of cells) {
        const flips = countFlips(board, cell, seat);
        const score = WEIGHTS[cell] + (style === 1 ? flips * 4 : style === 2 ? -flips * 2 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = cell;
        }
      }
      submit({ type: "place", cell: best });
    },
  };
}
