/**
 * 规则型 House Bot（吹牛骰）——概率模型版
 * 核心策略：二项分布精确计算"当前叫价为真"的概率 P(X≥qty)，
 * 以 P 阈值驱动质疑/加价决策；加价选期望概率最高的候选
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

/** 二项分布 P(X >= k)，n 次试验每次概率 p */
function pAtLeast(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (n === 0 || k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += binomial(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return sum;
}

function binomial(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) {
    r = (r * (n - i)) / (i + 1);
  }
  return r;
}

export function createRuleBot(name: string, aggression = 0.5): SeatDriver {
  // aggression: 0 = 最谨慎（低质疑阈值，高加价概率），1 = 最激进（高质疑阈值，低加价概率）
  const challengeThreshold = 0.22 + aggression * 0.16; // 0.22~0.38
  const bidThreshold = 0.45 + aggression * 0.1; // 0.45~0.55

  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as unknown as LDPublic;
      const my = (view.private as { my_dice?: number[] }).my_dice ?? [];
      const minFace = pub.wildcard_ones ? 2 : 1;
      const totalDice = pub.players.reduce((a, p) => a + p.dice_count, 0);
      const bid = pub.current_bid;

      /** 评估叫价 (qty, face) 为真的概率：己方确定数量 + 对方二项分布 */
      const evalBid = (qty: number, face: number): number => {
        const own = my.filter((d) => d === face).length;
        const unknown = totalDice - my.length;
        const deficit = qty - own;
        return pAtLeast(unknown, deficit, 1 / 6);
      };

      if (!bid) {
        // 开局：选手中最多的面，叫一个 bidThreshold 以上置信度的量
        const counts = new Map<number, number>();
        for (const d of my) {
          if (d >= minFace) counts.set(d, (counts.get(d) ?? 0) + 1);
        }
        let face = minFace;
        let bestCount = -1;
        for (const [f, c] of counts) {
          if (c > bestCount || (c === bestCount && f > face)) {
            face = f;
            bestCount = c;
          }
        }
        let qty = 1;
        while (qty < totalDice && evalBid(qty + 1, face) >= bidThreshold) qty++;
        return submitSafe({ type: "bid", qty, face }, bid, submit);
      }

      const pTrue = evalBid(bid.qty, bid.face);
      const pMax = evalBid(bid.qty, 6);

      // 质疑条件：叫价为真的概率太低，或叫量已达物理极限
      if (pTrue < challengeThreshold || bid.qty >= totalDice) {
        submit({ type: "challenge" });
        return;
      }

      // 加价：在所有合法加价中选期望概率最高的
      let bestQty = bid.qty;
      let bestFace = bid.face;
      let bestP = -1;
      for (let q = bid.qty; q <= Math.min(bid.qty + 2, 30); q++) {
        for (let f = minFace; f <= 6; f++) {
          if (q === bid.qty && f <= bid.face) continue;
          const p = evalBid(q, f);
          if (p > bestP) {
            bestP = p;
            bestQty = q;
            bestFace = f;
          }
        }
      }
      if (bestQty > 30 || bestP < challengeThreshold * 0.5) {
        submit({ type: "challenge" });
        return;
      }
      return submitSafe({ type: "bid", qty: bestQty, face: bestFace }, bid, submit);
    },
  };
}

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
