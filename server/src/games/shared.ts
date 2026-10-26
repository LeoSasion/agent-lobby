/**
 * 游戏模块共用的小工具（r39）
 *
 * 15 款游戏的 GameModule 实现里有三类逻辑被反复重写，且**必然会各自漂移**：
 *   1. 胜者制计分（winner → 1 / 平局 0.5 / 其余 0）—— 7 款游戏逐字相同
 *   2. 按累计值排名（同分并列、并列后跳号）—— 5 款逐字相同
 *   3. 淘汰制轮转（跳过已出局者找下一个）—— 接龙与飞花令逐字相同
 *
 * 抽出来的判据不是「行数能省多少」（其实没省几行），而是：
 * **这些语义必须在全平台保持一致**。比如「平局给 0.5」如果某一款写成 0，
 * Elo 会静默偏斜；「并列后跳号」如果某一款写成连续排名，名次榜就会自相矛盾。
 */

import type { SeatId } from "../protocol.ts";

/** 终局裁决：胜者席位 / 平局 / 尚未终局 */
export type Outcome = SeatId | "draw" | null;

/**
 * 胜者制计分：胜者 1、平局各 0.5、其余 0。
 * 与内核 `winnersOf` 的口径一致（最高分 ≤0.5 视为平局）。
 */
export function winnerScores(seats: SeatId[], winner: Outcome): Record<SeatId, number> {
  const out: Record<SeatId, number> = {};
  for (const t of seats) {
    out[t] = winner === null ? 0 : winner === "draw" ? 0.5 : t === winner ? 1 : 0;
  }
  return out;
}

/**
 * 按累计值排名：**同分并列、并列后跳号**（1,1,3 而不是 1,1,2）。
 * 平台另外还有一条兜底（内核 `placementsFromScores`），两者口径必须一致。
 */
export function rankByValue(
  seats: SeatId[],
  valueOf: (seat: SeatId) => number,
  noteFn?: (seat: SeatId, value: number) => string,
): { seat: SeatId; rank: number; note?: string }[] {
  const rows = seats.map((seat) => ({ seat, v: valueOf(seat) }));
  rows.sort((a, b) => b.v - a.v || a.seat - b.seat);
  let rank = 0;
  let prev: number | null = null;
  return rows.map((r, i) => {
    if (prev === null || r.v !== prev) rank = i + 1;
    prev = r.v;
    const note = noteFn ? noteFn(r.seat, r.v) : undefined;
    return note === undefined ? { seat: r.seat, rank } : { seat: r.seat, rank, note };
  });
}

/**
 * 淘汰制轮转：从 justActed 之后找下一个**未出局**的席位。
 * 找不到（全员出局或只剩自己）时返回 null，由调用方决定终局。
 */
export function nextAliveAfter(seats: SeatId[], eliminated: SeatId[], justActed: SeatId): SeatId | null {
  const dead = new Set(eliminated);
  const i = seats.indexOf(justActed);
  const start = i < 0 ? -1 : i;
  for (let k = 1; k <= seats.length; k++) {
    const t = seats[(start + k) % seats.length]!;
    if (!dead.has(t)) return t;
  }
  return null;
}
