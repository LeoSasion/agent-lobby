/**
 * ArenaClient —— HTTP Pull 通道的编程接口
 * 封装 quickstart / view / act / events / replay 为 async 迭代器模式
 * 错误约定：非 2xx 响应抛 ArenaApiError（含 status + code + body），绝不静默当数据
 */

import type { Action, AgentView, LegalAction, MatchEvent, SeatId } from "../protocol.ts";

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

export interface ActResult {
  ok: boolean;
  /** 422 时可自纠的错误码（NOT_YOUR_TURN / ILLEGAL_ACTION / NONCE_EXPIRED / DUPLICATE_ACTION …） */
  code?: string;
  error?: string;
  legal_actions?: LegalAction[];
  /** 提交成功时回带结算后的 AgentView（幂等重放时 replayed=true） */
  view?: AgentView;
  replayed?: boolean;
}

export interface MatchResult {
  matchId: string;
  scores: Record<SeatId, number>;
  events: MatchEvent[];
}

export interface GameInfo {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  defaultTimeoutMs: number;
}

export interface LeaderboardRow {
  agent: string;
  name?: string;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  house?: boolean;
}

/** 网关返回非 2xx / 业务错误时的结构化异常 */
export class ArenaApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.code === "string" ? body.code : undefined;
    super(`Arena API ${status}${code ? " " + code : ""}: ${String(body.error ?? body.message ?? "请求失败")}`);
    this.name = "ArenaApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class ArenaClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, "");
  }

  /** 请求并解析 JSON；非 2xx 抛 ArenaApiError（保留 body 供自纠） */
  private async request(path: string, opts: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(this.url + "/api/v1" + path, opts);
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ArenaApiError(res.status, { error: `响应不是合法 JSON（${res.status}）` });
    }
    if (!res.ok) throw new ArenaApiError(res.status, body);
    return { status: res.status, body };
  }

  /** 兼容旧用法：直接返回 body（非 2xx 抛错） */
  async api(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
    return (await this.request(path, opts)).body;
  }

  /** 列出可用游戏 */
  async games(): Promise<GameInfo[]> {
    const { body } = await this.request("/games");
    return (body.games as Record<string, unknown>[]).map((g) => ({
      id: g.id as string,
      name: g.name as string,
      minSeats: g.min_seats as number,
      maxSeats: g.max_seats as number,
      defaultTimeoutMs: g.default_timeout_ms as number,
    }));
  }

  /** 一键开局（返回 MatchHandle，可用 async for 遍历 views） */
  async quickstart(opts: QuickstartOptions): Promise<MatchHandle> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const body: Record<string, unknown> = { game: opts.game };
    if (opts.seats !== undefined) body.seats = opts.seats;
    if (opts.name !== undefined) body.name = opts.name;
    let r: Record<string, unknown>;
    try {
      r = (await this.request("/lobby/quickstart", { method: "POST", headers, body: JSON.stringify(body) })).body;
    } catch (e) {
      if (e instanceof ArenaApiError) throw new ArenaApiError(e.status, { ...e.body, error: `${e.message}（game=${opts.game}）` });
      throw e;
    }
    if (r.error) throw new ArenaApiError(200, r);
    return new MatchHandle(this, {
      matchId: r.match_id as string,
      seatToken: r.seat_token as string,
      apiKey: (r.api_key as string) ?? opts.apiKey ?? "",
      agentId: (r.agent_id as string) ?? "",
    });
  }

  /** 查看排行榜 */
  async leaderboard(gameId: string): Promise<LeaderboardRow[]> {
    const { body } = await this.request(`/leaderboard/${gameId}`);
    return (body.leaderboard as Record<string, unknown>[]).map((x) => ({
      agent: x.agent as string,
      name: x.name as string | undefined,
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

  /**
   * 提交动作（可选 reasoning + nonce）。
   * 业务拒绝（422）不抛异常，返回 {ok:false, code, legal_actions} 供自纠；
   * 网络/服务端故障（非 2xx）抛 ArenaApiError。
   * 幂等建议：每回合生成唯一 nonce（如 `${matchId}:${turn}:act`）；同 nonce 跨回合重试将得到
   * 网关重放缓存的成功（replayed=true）或 NONCE_EXPIRED——都不会消耗新回合。
   */
  async act(action: Action, opts?: ActOptions): Promise<ActResult> {
    const body: Record<string, unknown> = { action };
    if (opts?.reasoning) body.reasoning = opts.reasoning.slice(0, 500);
    if (opts?.nonce) body.nonce = opts.nonce.slice(0, 64);
    const res = await fetch(this.client.url + `/api/v1/matches/${this.matchId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": this.seatToken },
      body: JSON.stringify(body),
    });
    let r: Record<string, unknown>;
    try {
      r = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ArenaApiError(res.status, { error: `提交响应不是合法 JSON（${res.status}）` });
    }
    return r as unknown as ActResult;
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
   * 视图缺少 phase/you 字段（网关异常等）时抛错，绝不静默继续。
   */
  async *views(pollMs = 1000, activePollMs = 200): AsyncGenerator<AgentView, void, void> {
    while (!this._finished) {
      const v = await this.view();
      if (typeof v?.phase !== "string" || typeof v?.you?.active !== "boolean") {
        throw new Error(`views() 收到异常视图：${JSON.stringify(v).slice(0, 200)}`);
      }
      if (v.phase === "finished") {
        this._finished = true;
        await this.loadResult();
        yield v;
        return;
      }
      yield v;
      // 等待下次轮询
      await new Promise((r) => setTimeout(r, v.you.active ? activePollMs : pollMs));
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
