/**
 * House Bot（24 点）—— 穷举求解
 *
 * 4 个数两两合并，直到剩一个；分支约 4×3×4 = 48 一层，总节点几千，毫秒级。
 * 解不出就 pass（真实情况下约两成牌组无解）。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

const OPS = ["+", "-", "*", "/"] as const;
type Node = { v: number; e: string };

/** 穷举 4 个数的全部运算组合，返回一个等于 24 的表达式；无解返回 null */
export function solveTwentyFour(cards: number[]): string | null {
  const rec = (nums: Node[]): string | null => {
    if (nums.length === 1) return Math.abs(nums[0]!.v - 24) < 1e-9 ? nums[0]!.e : null;
    for (let i = 0; i < nums.length; i++) {
      for (let j = 0; j < nums.length; j++) {
        if (i === j) continue;
        const a = nums[i]!;
        const b = nums[j]!;
        const rest = nums.filter((_, k) => k !== i && k !== j);
        for (const op of OPS) {
          if (op === "/" && Math.abs(b.v) < 1e-12) continue;
          const v = op === "+" ? a.v + b.v : op === "-" ? a.v - b.v : op === "*" ? a.v * b.v : a.v / b.v;
          // 只保留正数中间值附近的解空间会漏解，这里全量搜索
          const r = rec([...rest, { v, e: `(${a.e}${op}${b.e})` }]);
          if (r) return r;
        }
      }
    }
    return null;
  };
  return rec(cards.map((c) => ({ v: c, e: String(c) })));
}

export function createTwentyFourBot(name: string): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { cards?: number[] };
      const cards = pub.cards;
      if (!Array.isArray(cards) || cards.length !== 4) {
        submit({ type: "pass" });
        return;
      }
      const expr = solveTwentyFour(cards);
      if (expr) submit({ type: "solve", expr });
      else submit({ type: "pass" });
    },
  };
}
