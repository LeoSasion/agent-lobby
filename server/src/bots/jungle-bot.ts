/**
 * House Bot（斗兽棋）—— 单步评分，不做搜索
 *
 * 评分项（按权重从高到低）：
 *   进对方兽穴 +100000 · 吃子 +被吃方等级×200 · 自己踏进对方陷阱 −自己等级×150
 *   · 落点受威胁 −自己等级×100 · 离对方兽穴更近 −距离×3
 *
 * 「踏进对方陷阱」比「受威胁」罚得更重：陷阱让棋子战斗力变 0，
 * 等于白送——这是斗兽棋最反直觉的一处，也是新手最容易犯的错。
 *
 * 不做极小化极大：分支因子约 20-30，两层就是 ~700 节点，收益不大；
 * house bot 的定位是「不犯低级错误」，不是「强」。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { RANK_VALUE, type Rank } from "../games/jungle-chess.ts";

type PieceView = { seat: number; side: string; kind: string } | null;

const DIRS: readonly [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export function createJungleBot(name: string, caution = 1.0): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as {
        board?: PieceView[];
        width?: number;
        height?: number;
        dens?: { red: number; blue: number };
        traps?: { red: number[]; blue: number[] };
        red?: number;
        blue?: number;
      };
      const board = pub.board;
      const width = pub.width ?? 7;
      const height = pub.height ?? 9;
      const me = (view.you as { seat?: number } | undefined)?.seat;
      const mySide = (view.private as { my_side?: string } | undefined)?.my_side;
      if (!Array.isArray(board) || typeof me !== "number" || !mySide) {
        submit({ type: "move", from: 0, to: 0 });
        return;
      }
      const enemySide = mySide === "red" ? "blue" : "red";
      const enemyDen = enemySide === "red" ? pub.dens?.red : pub.dens?.blue;
      const enemyTraps = new Set((enemySide === "red" ? pub.traps?.red : pub.traps?.blue) ?? []);

      // 走子候选：来自法表（引擎已经算好全部合法走子，bot 不需要自己实现规则）
      const schema = (view.legal_actions ?? []).find((a) => a.type === "move")?.schema as
        | { values?: unknown }
        | undefined;
      const vals = Array.isArray(schema?.values) ? (schema!.values as number[]) : [];
      if (vals.length === 0) {
        submit({ type: "move", from: 0, to: 0 });
        return;
      }

      const at = (i: number): PieceView => board[i] ?? null;
      const dist = (i: number): number => {
        if (typeof enemyDen !== "number") return 0;
        const dx = Math.abs((i % width) - (enemyDen % width));
        const dy = Math.abs(Math.floor(i / width) - Math.floor(enemyDen / width));
        return dx + dy;
      };
      const threatened = (to: number, myRank: number): boolean => {
        const x = to % width;
        const y = Math.floor(to / width);
        for (const [dx, dy] of DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const q = at(ny * width + nx);
          if (q && q.seat !== me && RANK_VALUE[q.kind as Rank] > myRank) return true;
        }
        return false;
      };

      let best = vals[0]!;
      let bestScore = -Infinity;
      // 破循环：静态评分对「走过去」和「走回来」打分相同，两个 bot 会无限震荡
      // （实测 80 手无吃子判和，盘面几乎没变）。用历史走子给重复走法扣分。
      const myRecent = ((pub as { moves?: { seat: number; from: number; to: number }[] }).moves ?? [])
        .filter((m) => m.seat === me)
        .slice(-20);
      const ply = ((pub as { moves?: unknown[] }).moves ?? []).length;
      for (const enc of vals) {
        const from = Math.floor(enc / 100);
        const to = enc % 100;
        const p = at(from);
        if (!p || p.seat !== me) continue;
        const myRank = RANK_VALUE[p.kind as Rank] ?? 1;
        let score = 0;

        if (typeof enemyDen === "number" && to === enemyDen) score += 100000;
        const victim = at(to);
        if (victim && victim.seat !== me) score += (RANK_VALUE[victim.kind as Rank] ?? 1) * 300;
        if (enemyTraps.has(to)) score -= myRank * 150 * caution;
        if (threatened(to, myRank)) score -= myRank * 15 * caution;
        score -= dist(to) * 12;  // 太小会被「避威胁」压过 → 双方原地磨蹭
        // 破循环：静态评分对往返走子给同样的分，不罚的话双方会无限顶牛。
        // 窗口要够长——只看出最近 6 手时，周期为 4 的往返能完美躲过惩罚。
        if (myRecent.some((m) => m.from === from && m.to === to)) score -= 150;
        // 确定性抖动：同分时若按编码取小，会永远只有索引最小的那个棋子动
        // （实测两只象互相顶牛 80 手，其余七子一步没走）。用走子与手数的确定性哈希打散。
        score += ((from * 31 + to * 17 + ply * 7) % 13) * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = enc;
        }
      }
      submit({ type: "move", from: Math.floor(best / 100), to: best % 100 });
    },
  };
}
