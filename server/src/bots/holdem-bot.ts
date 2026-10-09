/**
 * House Bot（德州扑克·简化版）—— 成牌强度 + 底池赔率版
 * 策略：preflop 用起手牌强度分（Chen 简化版）；
 * postflop 用 evaluateBest 当前成牌等级 × 潜力加成；
 * 面对下注时按 pot odds 决定跟注；强度高时主动加注（半池）。
 * aggression 参数制造风格多样性（0 谨慎 … 1 激进）。
 */

import type { Action, AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { evaluateBest, type Card } from "../games/holdem-lite.ts";

interface HPublic {
  hand_no: number;
  street: "preflop" | "flop" | "turn" | "river";
  community: string[];
  pot: number;
  current_bet: number;
  min_raise: number;
  to_act: number | null;
  button: number;
  big_blind: number;
  players: { seat: number; chips: number; bet: number; committed: number; folded: boolean; allin: boolean }[];
}

function parseCard(s: string): Card {
  const r = "23456789TJQKA".indexOf(s[0]) + 2;
  const sIdx = "shdc".indexOf(s[1]);
  return { r, s: sIdx };
}

/** Chen 公式简化版起手强度（约 -1 … 20） */
function preflopScore(hole: Card[]): number {
  const [a, b] = [...hole].sort((x, y) => y.r - x.r);
  let score = a.r / 2;
  if (a.r === b.r) {
    score = Math.max(5, a.r); // 对子
  } else {
    if (a.s === b.s) score += 2;
    const gap = a.r - b.r - 1;
    if (gap === 1) score += 1;
    else if (gap === 2) score -= 1;
    else if (gap >= 3) score -= 4;
    if (a.r === 14) score += 1;
  }
  return score;
}

export function createHoldemBot(name: string, aggression = 0.5): SeatDriver {
  const raiseThresh = 11 - aggression * 4; // 强度分超过则加注（7~11）
  const callThresh = 4.5 - aggression * 1.5; // 底线（3~4.5）
  const bluff = aggression * 0.08; // 诈唬概率（hash 确定性替代 Math.random——见纪律）

  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as unknown as HPublic;
      const my = view.private as { hole_cards?: string[]; my_chips?: number; my_bet?: number };
      const hole = (my.hole_cards ?? []).map(parseCard);
      const community = pub.community.map(parseCard);
      const myBet = my.my_bet ?? 0;
      const toCall = pub.current_bet - myBet;

      // 成牌强度（postflop）：evaluateBest 等级 0-8
      const made = community.length >= 3 ? evaluateBest([...hole, ...community]).rank : -1;
      // preflop 强度分
      const pre = preflopScore(hole);

      // hash 确定性伪随机（禁 Math.random——回放纪律）
      const h = Math.abs(Math.imul(pub.hand_no * 31 + (pub.to_act ?? 0) * 131 + community.length, 2654435761) % 1000) / 1000;

      const strong = pub.street === "preflop" ? pre >= raiseThresh : made >= 3 || (made >= 1 && h < 0.3);
      const medium = pub.street === "preflop" ? pre >= callThresh : made >= 1;

      const maxTo = myBet + (my.my_chips ?? 0);

      if (toCall <= 0) {
        // 可 check：强牌下注（半池），弱牌 check；小概率诈唬
        if (strong || h < bluff) {
          const target = Math.max(pub.current_bet + pub.min_raise, Math.ceil((pub.pot + pub.current_bet) / 2 / 10) * 10);
          const to = Math.min(target, maxTo);
          if (to > pub.current_bet) {
            const r = submit({ type: "raise", to });
            if (!r.ok) submit({ type: "check" });
            return;
          }
        }
        submit({ type: "check" });
        return;
      }

      // 面对下注：pot odds
      const potOdds = toCall / (pub.pot + pub.current_bet + toCall);
      if (strong) {
        // 强牌加注（或跟注）
        const target = pub.current_bet + pub.min_raise * 2;
        const to = Math.min(target, maxTo);
        if (to > pub.current_bet && h < 0.5) {
          const r = submit({ type: "raise", to });
          if (!r.ok) {
            const c = submit({ type: "call" });
            if (!c.ok) submit({ type: "fold" });
          }
          return;
        }
        const c = submit({ type: "call" });
        if (!c.ok) submit({ type: "fold" });
        return;
      }
      if (medium && potOdds < 0.35) {
        const c = submit({ type: "call" });
        if (!c.ok) submit({ type: "fold" });
        return;
      }
      // 弱牌：小注跟一手（limp，≤2BB），大注弃
      if (toCall <= pub.big_blind * 2) {
        const c = submit({ type: "call" });
        if (!c.ok) submit({ type: "fold" });
        return;
      }
      submit({ type: "fold" });
    },
  };
}
