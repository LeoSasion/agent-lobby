/**
 * House Bot（拍卖行·密封竞价）—— 估值比例出价
 * 策略：只看自己的私有估值，按风格比例出价（不猜测对手——密封竞价里没有可观测的对手行为）。
 *   ratio 0.5 谨慎（留足利润，但很容易抢不到）
 *   ratio 0.75 均衡
 *   ratio 0.92 激进（接近于「估值即出价」，赢面大但几乎不赚钱）
 * 资金不足时按余额封顶；估值为 0 或余额为 0 时放弃本件。
 *
 * 注意（这是拍卖 bot 最容易写错的地方）：bot **不能**看 public.history 里别人的估值来反推
 * 本轮该出多少——那等于作弊。每轮估值独立，唯一的决策依据是自己的 my_estimate。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

export function createAuctionBot(name: string, ratio: number): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const priv = (view.private ?? {}) as { my_estimate?: number | null; my_balance?: number };
      const est = priv.my_estimate;
      const bal = priv.my_balance ?? 0;
      if (typeof est !== "number" || est <= 0 || bal <= 0) {
        submit({ type: "pass" });
        return;
      }
      const bid = Math.min(bal, Math.max(0, Math.floor(est * ratio)));
      if (bid <= 0) submit({ type: "pass" });
      else submit({ type: "bid", amount: bid });
    },
  };
}
