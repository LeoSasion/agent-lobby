/**
 * House Bot（飞花令）—— 挑「最冷门」的一句，减少对手可用的续句
 *
 * 策略：在含令字且未念过的句子里，选**字频最低**的那句（生僻句），
 * 因为生僻句不会替对手打开常见意象。同等冷门时按字典序稳定取。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { linesWith } from "../games/feihualing-data.ts";

export function createFeihualingBot(name: string): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { rhyme?: string; said?: { line: string }[] };
      const rhyme = pub.rhyme;
      if (typeof rhyme !== "string") {
        submit({ type: "pass" });
        return;
      }
      const used = new Set((pub.said ?? []).map((s) => s.line));
      const cands = linesWith(rhyme).filter((l) => !used.has(l));
      if (cands.length === 0) {
        submit({ type: "pass" });
        return;
      }
      // 越少见的句子越优先（用「句子长度」与字典序做稳定的冷门近似）
      cands.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
      submit({ type: "say", line: cands[0]! });
    },
  };
}
