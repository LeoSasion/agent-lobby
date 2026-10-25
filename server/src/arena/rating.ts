/**
 * Elo 评分（多人扩展）
 * - 2 人局退化为标准 Elo；N 人局用"对所有对手的期望均值"
 * - K 因子：前 10 局 40（定级期），之后 20
 * - 实际得分：胜 1 / 平 0.5 / 负 0（与 GameModule.scores 对齐）
 */

import type { MatchEvent, SeatId } from "../protocol.ts";

export interface RatingRecord {
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 累计行动数（含超时默认动作），r32 起统计 */
  actions?: number;
  /** 其中带 reasoning 的行动数，r32 起统计 */
  reasoned?: number;
}

export interface RatingDelta {
  seat: SeatId;
  agent: string;
  old: number;
  delta: number;
  new: number;
}

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export class RatingStore {
  private byGame = new Map<string, Map<string, RatingRecord>>();

  /** 取（或初始化）某游戏某 Agent 的评分记录 */
  record(gameId: string, agent: string): RatingRecord {
    let m = this.byGame.get(gameId);
    if (!m) {
      m = new Map();
      this.byGame.set(gameId, m);
    }
    let r = m.get(agent);
    if (!r) {
      r = { rating: 1200, games: 0, wins: 0, draws: 0, losses: 0, actions: 0, reasoned: 0 };
      m.set(agent, r);
    }
    return r;
  }

  /** 只读查询（不初始化——/agents/me 不应为从未对局的 (game, agent) 凭空造出 1200/0 记录） */
  peek(gameId: string, agent: string): RatingRecord | undefined {
    return this.byGame.get(gameId)?.get(agent);
  }

  /** 赛后结算：seatAgents 席位→Agent 映射，scores 席位→实际得分 */
  applyMatch(gameId: string, seatAgents: Map<SeatId, string>, scores: Record<SeatId, number>): RatingDelta[] {
    const seats = [...seatAgents.keys()].sort((a, b) => a - b);
    const recs = new Map(seats.map((s) => [s, this.record(gameId, seatAgents.get(s)!)]));
    const deltas: RatingDelta[] = [];

    for (const s of seats) {
      const me = recs.get(s)!;
      const k = me.games < 10 ? 40 : 20;
      const opponents = seats.filter((o) => o !== s);
      const exp =
        opponents.length === 0
          ? 0.5
          : opponents.reduce((a, o) => a + expectedScore(me.rating, recs.get(o)!.rating), 0) / opponents.length;
      const actual = scores[s] ?? 0;
      const delta = Math.round(k * (actual - exp) * 10) / 10;
      deltas.push({ seat: s, agent: seatAgents.get(s)!, old: me.rating, delta, new: Math.round((me.rating + delta) * 10) / 10 });
    }

    // r29 零和化（P1）：逐人独立结算的净漂移 = K × (Σ实际得分 − N/2)，而零和条件
    // Σ实际 = N/2 在多数赛制下不成立——单一冠军制（吹牛骰/黑白棋/德州）系统性通缩，
    // 多数人获胜制（卧底平民 5/6 胜）系统性通胀。r29 实测：6 席吹牛骰 −80、狼人杀 −40、卧底 +80。
    // 减去本局 delta 均值后每局 Σdelta 恒为 0；2 席局一正一负均值本就是 0，数值不变。
    if (deltas.length > 0) {
      const mean = deltas.reduce((a, d) => a + d.delta, 0) / deltas.length;
      if (Math.abs(mean) > 1e-9) {
        for (const d of deltas) {
          d.delta = Math.round((d.delta - mean) * 10) / 10;
          d.new = Math.round((d.old + d.delta) * 10) / 10;
        }
        // 一位小数舍入会留下残余（如 ±0.1）：补给 |delta| 最大的那位，保证严格零和
        const residual = Math.round(deltas.reduce((a, d) => a + d.delta, 0) * 10) / 10;
        if (Math.abs(residual) > 1e-9) {
          const pivot = deltas.reduce((best, d) => (Math.abs(d.delta) > Math.abs(best.delta) ? d : best), deltas[0]!);
          pivot.delta = Math.round((pivot.delta - residual) * 10) / 10;
          pivot.new = Math.round((pivot.old + pivot.delta) * 10) / 10;
        }
      }
    }

    for (const d of deltas) {
      const r = this.record(gameId, d.agent);
      r.rating = d.new;
      r.games += 1;
      const sc = scores[d.seat] ?? 0;
      if (sc > 0.99) r.wins += 1;
      else if (sc > 0.01) r.draws += 1;
      else r.losses += 1;
    }
    return deltas;
  }

  leaderboard(gameId: string): (RatingRecord & { agent: string })[] {
    const m = this.byGame.get(gameId);
    if (!m) return [];
    return [...m.entries()]
      .map(([agent, r]) => ({ agent, ...r }))
      .sort((a, b) => b.rating - a.rating);
  }

  /**
   * 决策方式统计（r32 · 缺口④「决策方式记分」的最小实现）：
   * 终局扫裁判视角事件流里的 acted 事件，按席位 → agent 累计行动数与带推理行动数。
   * 口径：超时默认动作也记 acted 但必无 reasoning → 带推理率自然排除超时。
   */
  applyActionStats(gameId: string, seatAgents: Map<SeatId, string>, events: readonly MatchEvent[]): void {
    for (const e of events) {
      if (e.type !== "acted") continue;
      const seat = (e.data as { seat?: unknown }).seat;
      const agent = typeof seat === "number" ? seatAgents.get(seat) : undefined;
      if (!agent) continue;
      const r = this.record(gameId, agent);
      r.actions = (r.actions ?? 0) + 1;
      if (typeof (e.data as { reasoning?: unknown }).reasoning === "string") {
        r.reasoned = (r.reasoned ?? 0) + 1;
      }
    }
  }

  /** 持久化导出 */
  export(): Record<string, Record<string, RatingRecord>> {
    const out: Record<string, Record<string, RatingRecord>> = {};
    for (const [gameId, m] of this.byGame) {
      out[gameId] = Object.fromEntries([...m.entries()]);
    }
    return out;
  }

  /** 持久化导入（旧数据无 actions/reasoned 字段，兜底为 0） */
  import(data: Record<string, Record<string, RatingRecord>>): void {
    for (const [gameId, agents] of Object.entries(data)) {
      const m = new Map<string, RatingRecord>();
      for (const [agent, r] of Object.entries(agents)) {
        m.set(agent, { actions: 0, reasoned: 0, ...r });
      }
      this.byGame.set(gameId, m);
    }
  }
}
