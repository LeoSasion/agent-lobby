/**
 * House Bot（成语接龙）—— 从词库里挑「最难接」的那个
 *
 * 策略：在合法候选里选**尾字后继最少**的，把对手往死路上推；
 * 同等威胁时选后继多的，给自己留后路。全部候选都已用尽就认输。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { BY_FIRST, headOf, tailOf, countByFirst } from "../games/idiom-data.ts";

export function createIdiomBot(name: string): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { current?: string; chain?: { idiom: string }[] };
      const current = pub.current;
      if (typeof current !== "string") {
        submit({ type: "pass" });
        return;
      }
      const used = new Set((pub.chain ?? []).map((c) => c.idiom));
      const cands = (BY_FIRST.get(current) ?? []).filter((w) => !used.has(w));
      if (cands.length === 0) {
        submit({ type: "pass" });
        return;
      }
      // 尾字后继越少越优先（逼对手）；同分按字典序稳定取，保证同 seed 确定性
      cands.sort((a, b) => countByFirst(tailOf(a)) - countByFirst(tailOf(b)) || (a < b ? -1 : a > b ? 1 : 0));
      const pick = cands[0]!;
      // 兜底自检：必须首字匹配（防止词库索引与规则不同步）
      if (headOf(pick) !== current) {
        submit({ type: "pass" });
        return;
      }
      submit({ type: "say", idiom: pick });
    },
  };
}
