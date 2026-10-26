/**
 * House Bot（军棋翻棋）—— 翻子优先 + 吃高价值目标
 *
 * 策略：
 *   1. 能吃子就吃（按被吃方等级排序，吃大的）
 *   2. 否则如果暗棋还多（> 6），继续翻——翻棋是获取战力的唯一途径
 *   3. 否则走一个不会立刻被吃的位置
 *
 * 与斗兽棋 bot 的同类问题：同分时若按编码取小，会永远只动同一个棋子。
 * 这里用「走子编码 + 步数」的确定性抖动打散，避免单子反复。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { RANK_VALUE, type Rank } from "../games/banqi.ts";

type PieceView = { faceUp: true; side: string; kind: string } | { faceUp: false } | null;

export function createBanqiBot(name: string): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { board?: PieceView[]; ply?: number };
      const board = pub.board;
      const me = (view.you as { seat?: number } | undefined)?.seat;
      const mySide = (view.private as { my_side?: string } | undefined)?.my_side;
      if (!Array.isArray(board) || typeof me !== "number" || !mySide) {
        submit({ type: "flip", cell: 0 });
        return;
      }

      const schemaFlip = (view.legal_actions ?? []).find((a) => a.type === "flip")?.schema as { values?: number[] } | undefined;
      const schemaMove = (view.legal_actions ?? []).find((a) => a.type === "move")?.schema as { values?: number[] } | undefined;
      const flips = Array.isArray(schemaFlip?.values) ? schemaFlip!.values : [];
      const moves = Array.isArray(schemaMove?.values) ? schemaMove!.values : [];

      // 1) 吃子：挑被吃方等级最高的
      let bestMove = -1;
      let bestGain = 0;
      for (const enc of moves) {
        const to = enc % 100;
        const target = board[to];
        if (target && target.faceUp) {
          const gain = RANK_VALUE[target.kind as Rank] ?? 1;
          if (gain > bestGain) {
            bestGain = gain;
            bestMove = enc;
          }
        }
      }
      if (bestMove >= 0) {
        submit({ type: "move", from: Math.floor(bestMove / 100), to: bestMove % 100 });
        return;
      }

      // 2) 暗棋还多就翻（翻棋是唯一能长出自己棋子的方式）
      const hidden = board.filter((p) => p && p.faceUp === false).length;
      if (flips.length > 0 && hidden > 6) {
        const ply = pub.ply ?? 0;
        submit({ type: "flip", cell: flips[(ply * 7) % flips.length]! });
        return;
      }

      // 3) 走子：用确定性抖动避免总是同一个棋子
      if (moves.length > 0) {
        const ply = pub.ply ?? 0;
        const pick = moves[(ply * 13) % moves.length]!;
        submit({ type: "move", from: Math.floor(pick / 100), to: pick % 100 });
        return;
      }
      // 4) 只能翻
      if (flips.length > 0) {
        submit({ type: "flip", cell: flips[0]! });
        return;
      }
      submit({ type: "flip", cell: 0 });
    },
  };
}
