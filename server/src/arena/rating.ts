/**
 * Elo 评分（多人扩展）
 * - 2 人局退化为标准 Elo；N 人局用"对所有对手的期望均值"
 * - K 因子：前 10 局 40（定级期），之后 20
 * - 实际得分：胜 1 / 平 0.5 / 负 0（与 GameModule.scores 对齐）
 */

import type { SeatId } from "../protocol.ts";

export interface RatingRecord {
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
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
      r = { rating: 1200, games: 0, wins: 0, draws: 0, losses: 0 };
      m.set(agent, r);
    }
    return r;
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

  /** 持久化导出 */
  export(): Record<string, Record<string, RatingRecord>> {
    const out: Record<string, Record<string, RatingRecord>> = {};
    for (const [gameId, m] of this.byGame) {
      out[gameId] = Object.fromEntries([...m.entries()]);
    }
    return out;
  }

  /** 持久化导入 */
  import(data: Record<string, Record<string, RatingRecord>>): void {
    for (const [gameId, agents] of Object.entries(data)) {
      const m = new Map<string, RatingRecord>();
      for (const [agent, r] of Object.entries(agents)) {
        m.set(agent, r);
      }
      this.byGame.set(gameId, m);
    }
  }
}
