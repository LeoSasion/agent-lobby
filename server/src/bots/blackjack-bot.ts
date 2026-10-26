/**
 * House Bot（21 点）—— 基本策略的骨架版
 *
 * 只看两个量：自己点数、庄家明牌。规则：
 *   17+ 停 · 12-16 且庄家 2-6（明牌弱）停 · 其余要牌
 * 这是经典基本策略里最有价值的一条（「庄家弱时就别冒险」），
 * 不做完整策略表——house bot 的定位是「不犯低级错误」，不是「最优」。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { cardValue, handValue, type Card } from "../games/blackjack.ts";

export function createBlackjackBot(name: string): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as { dealer_up?: Card | null };
      const priv = (view.private ?? {}) as { my_cards?: Card[] };
      const cards = priv.my_cards;
      if (!Array.isArray(cards) || cards.length === 0) {
        submit({ type: "stand" });
        return;
      }
      const mine = handValue(cards);
      const up = typeof pub.dealer_up === "number" ? cardValue(pub.dealer_up) : 10;
      // 17+ 停；12-16 面对庄家弱牌（2-6）也停；其余要牌
      if (mine >= 17) submit({ type: "stand" });
      else if (mine >= 12 && up >= 2 && up <= 6) submit({ type: "stand" });
      else submit({ type: "hit" });
    },
  };
}
