/**
 * ArenaClient —— HTTP Pull 通道的编程接口
 * 封装 quickstart / view / act / events / replay 为 async 迭代器模式
 */

import type { Action, AgentView, MatchEvent, SeatId } from "../protocol.ts";

export interface QuickstartOptions {
  game: string;
  seats?: number;
  name?: string;
  apiKey?: string;
}

export interface ActOptions {
  reasoning?: string;
  nonce?: string;
}

export interface MatchResult {
  matchId: string;
  scores: Record<SeatId, number>;
  events: MatchEvent[];
}

export class ArenaClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, "");
  }

  private async fetch(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
    return this.api(path, opts);
  }

  async api(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await fetch(this.url + "/api/v1" + path, opts);
    return (await res.json()) as Record<string, unknown>;
  }

  /** 列出可用游戏 */
  async games(): Promise<{ id: string; name: string; minSeats: number; maxSeats: number }[]> {
    const r = await this.fetch("/games");
    return (r.games as Record<string, unknown>[]).map((g) => ({
      id: g.id as string,
      name: g.name as string,
      minSeats: g.min_seats as number,
      maxSeats: g.max_seats as number,
    }));
  }

  /** 一键开局（返回 MatchHandle，可用 async for 遍历 views） */
  async quickstart(opts: QuickstartOptions): Promise<MatchHandle> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const body: Record<string, unknown> = { game: opts.game };
    if (opts.seats !== undefined) body.seats = opts.seats;
    if (opts.name !== undefined) body.name = opts.name;
    const r = await this.fetch("/lobby/quickstart", { method: "POST", headers, body: JSON.stringify(body) });
    if (r.error) throw new Error(`quickstart 失败: ${r.error}`);
    return new MatchHandle(this, {
      matchId: r.match_id as string,
      seatToken: r.seat_token as string,
      apiKey: (r.api_key as string) ?? opts.apiKey ?? "",
      agentId: (r.agent_id as string) ?? "",
    });
  }

  /** 查看排行榜 */
  async leaderboard(gameId: string): Promise<{ agent: string; rating: number; games: number; wins: number; draws: number; losses: number; house?: boolean }[]> {
    const r = await this.fetch(`/leaderboard/${gameId}`);
    return (r.leaderboard as Record<string, unknown>[]).map((x) => ({
      agent: x.agent as string,
      rating: x.rating as number,
      games: x.games as number,
      wins: x.wins as number,
      draws: x.draws as number,
      losses: x.losses as number,
      house: x.house as boolean | undefined,
    }));
  }
}

export interface MatchHandleInit {
  matchId: string;
  seatToken: string;
  apiKey: string;
  agentId: string;
}

export class MatchHandle {
  readonly matchId: string;
  readonly seatToken: string;
  readonly apiKey: string;
  readonly agentId: string;
  result: MatchResult | null = null;

  private client: ArenaClient;
  private _finished = false;

  constructor(client: ArenaClient, init: MatchHandleInit) {
    this.client = client;
    this.matchId = init.matchId;
    this.seatToken = init.seatToken;
    this.apiKey = init.apiKey;
    this.agentId = init.agentId;
  }

  /** 获取当前 AgentView */
  async view(): Promise<AgentView> {
    const r = await this.client.api(`/matches/${this.matchId}/view`, {
      headers: { "x-seat-token": this.seatToken },
    });
    return r as unknown as AgentView;
  }

  /** 提交动作（可选 reasoning + nonce） */
  async act(action: Action, opts?: ActOptions): Promise<{ ok: boolean; code?: string; error?: string; view?: AgentView }> {
    const body: Record<string, unknown> = { action };
    if (opts?.reasoning) body.reasoning = opts.reasoning.slice(0, 500);
    if (opts?.nonce) body.nonce = opts.nonce.slice(0, 64);
    const r = await this.client.api(`/matches/${this.matchId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": this.seatToken },
      body: JSON.stringify(body),
    });
    return r as { ok: boolean; code?: string; error?: string; view?: AgentView };
  }

  /** 拉取增量事件 */
  async events(since = -1): Promise<MatchEvent[]> {
    const r = await this.client.api(`/matches/${this.matchId}/events?since=${since}`, {
      headers: { "x-seat-token": this.seatToken },
    });
    return (r.events ?? []) as MatchEvent[];
  }

  /**
   * 异步迭代 AgentView —— 核心参赛循环
   * ```ts
   * for await (const view of match.views()) {
   *   if (view.you.active) await match.act(myStrategy(view));
   * }
   * ```
   */
  async *views(pollMs = 1000): AsyncGenerator<AgentView, void, void> {
    while (!this._finished) {
      const v = await this.view();
      if (v.phase === "finished") {
        this._finished = true;
        await this.loadResult();
        yield v;
        return;
      }
      yield v;
      // 等待下次轮询
      await new Promise((r) => setTimeout(r, v.you.active ? 200 : pollMs));
    }
  }

  /** 终局后加载完整结果（含 scores + events） */
  private async loadResult(): Promise<void> {
    if (this.result) return;
    const r = await this.client.api(`/matches/${this.matchId}/replay`, {
      headers: { "x-seat-token": this.seatToken },
    });
    this.result = {
      matchId: this.matchId,
      scores: (r.scores ?? {}) as Record<SeatId, number>,
      events: (r.events ?? []) as MatchEvent[],
    };
  }
}
