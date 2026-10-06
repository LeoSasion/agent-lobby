/**
 * 规则型 House Bot（吹牛骰）
 * 确定性策略（无随机），便于冒烟测试稳定复现
 * 策略：以"自己手中该面数量 + 他人期望值"评估当前叫价可信度，不可信则质疑，可信则最小加价
 */

import type { Action, AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

interface LDPublic {
  round: number;
  players: { seat: number; dice_count: number }[];
  current_bid: { seat: number; qty: number; face: number } | null;
  turn: number | null;
  wildcard_ones: boolean;
}

/** 手中最常见的可叫面（平手取大） */
function bestFace(dice: number[], min: number): number {
  const counts = new Map<number, number>();
  for (const d of dice) if (d >= min) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = min;
  let bestCount = -1;
  for (const [face, c] of counts) {
    if (c > bestCount || (c === bestCount && face > best)) {
      best = face;
      bestCount = c;
    }
  }
  return best;
}

export function createRuleBot(name: string, aggression = 0.5): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as LDPublic;
      const my = (view.private as { my_dice?: number[] }).my_dice ?? [];
      const minFace = pub.wildcard_ones ? 2 : 1;
      const totalDice = pub.players.reduce((a, p) => a + p.dice_count, 0);
      const bid = pub.current_bid;

      if (!bid) {
        const qty = Math.max(1, Math.round((totalDice / 6) * 0.7));
        submitSafe({ type: "bid", qty, face: bestFace(my, minFace) }, bid, submit);
        return;
      }

      const own = my.filter((d) => d === bid.face).length;
      const othersExpected = (totalDice - my.length) / 6;
      const margin = (1 - aggression) * 1.2; // 越谨慎越倾向于质疑
      const credible = own + othersExpected + margin >= bid.qty;

      if (!credible || bid.qty >= totalDice) {
        submit({ type: "challenge" });
        return;
      }
      let qty = bid.qty;
      let face = bid.face + 1;
      if (face > 6) {
        face = minFace;
        qty = bid.qty + 1;
      }
      if (qty > 30) {
        submit({ type: "challenge" });
        return;
      }
      submitSafe({ type: "bid", qty, face }, bid, submit);
    },
  };
}

/** 加价被拒时退回质疑（理论上不会触发，属防御性兜底） */
function submitSafe(
  action: Action,
  bid: LDPublic["current_bid"],
  submit: (a: Action) => { ok: true } | { ok: false; error: string; legal_actions: unknown },
): void {
  const r = submit(action);
  if (!r.ok && action.type === "bid" && bid) submit({ type: "challenge" });
}

/** 永不响应的 bot：用于验证超时兜底 */
export function createHangingBot(name: string): SeatDriver {
  return {
    name,
    act: () => new Promise<void>(() => {}),
  };
}
