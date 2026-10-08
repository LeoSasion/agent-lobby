/**
 * 概率策略（种子）：吹牛骰 liars_dice
 * 视角：只看得到自己骰子 + 全场公开信息
 * 关键公式：P(全场 face 数 >= qty) = P(X >= qty - own) , X ~ Bin(unknown, 1/6)
 */

export interface LDView {
  phase: string;
  round: number;
  you: { seat: number; active: boolean };
  public: {
    round: number;
    players: { seat: number; dice_count: number }[];
    current_bid: { seat: number; qty: number; face: number } | null;
    turn: number | null;
    wildcard_ones: boolean;
  };
  private: { my_dice?: number[] };
}

function binom(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** P(X >= k), X~Bin(n, p) */
export function pAtLeast(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (n <= 0 || k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i++) sum += binom(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  return sum;
}

const CHALLENGE_P = 0.30; // 低于此"为真概率"则质疑
const MIN_BID_P = 0.55; // 加价后要求的最低为真概率（我视角）

/**
 * 返回 { action, reasoning, note }；action 需严格合法，非法由调用方兜底
 */
export function decide(v: LDView): { action: { type: string; qty?: number; face?: number }; reasoning: string } {
  const pub = v.public;
  const my = v.private.my_dice ?? [];
  const minFace = pub.wildcard_ones ? 2 : 1;
  const totalDice = pub.players.reduce((a, p) => a + p.dice_count, 0);
  const unknown = totalDice - my.length;
  const bid = pub.current_bid;

  /** 我视角下 (qty,face) 为真的概率：己方精确 + 他方二项 */
  const evalP = (qty: number, face: number): number => {
    const own = my.filter((d) => d === face).length;
    return pAtLeast(unknown, qty - own, 1 / 6);
  };

  if (!bid) {
    // 开局：选我手里最多的面（他方低估 → 更可能被错误质疑、我获益），加价到置信度边界
    const counts = new Map<number, number>();
    for (const d of my) if (d >= minFace) counts.set(d, (counts.get(d) ?? 0) + 1);
    let face = minFace;
    let best = -1;
    for (const [f, c] of counts) if (c > best || (c === best && f > face)) { face = f; best = c; }
    let qty = 1;
    while (qty < totalDice && evalP(qty + 1, face) >= MIN_BID_P) qty++;
    return { action: { type: "bid", qty, face }, reasoning: `开局：手里 ${my.filter((d) => d === face).length} 个${face}，叫 ${qty} 个${face}` };
  }

  const pTrue = evalP(bid.qty, bid.face);
  // 质疑：为真概率过低，或叫量已达物理上限
  if (pTrue < CHALLENGE_P || bid.qty >= totalDice) {
    return { action: { type: "challenge" }, reasoning: `叫价 ${bid.qty}×${bid.face} 我算为真概率仅 ${(pTrue * 100).toFixed(0)}%，质疑` };
  }

  // 加价：在所有合法加价里挑我视角期望概率最高者
  let bestQty = bid.qty, bestFace = bid.face, bestP = -1;
  for (let q = bid.qty; q <= Math.min(bid.qty + 2, 30); q++) {
    for (let f = minFace; f <= 6; f++) {
      if (q === bid.qty && f <= bid.face) continue;
      const p = evalP(q, f);
      if (p > bestP) { bestP = p; bestQty = q; bestFace = f; }
    }
  }
  if (bestP < CHALLENGE_P) {
    return { action: { type: "challenge" }, reasoning: `无高置信加价（最佳 ${(bestP * 100).toFixed(0)}%），转为质疑` };
  }
  return { action: { type: "bid", qty: bestQty, face: bestFace }, reasoning: `加价到 ${bestQty}×${bestFace}（我视角为真 ${(bestP * 100).toFixed(0)}%）` };
}
