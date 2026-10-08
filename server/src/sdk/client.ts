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
  /** HTTP 状态码（422=业务拒绝可自纠；其余非 2xx 已抛 ArenaApiError） */
  status?: number;
  /** 动作已入账的显式确认（r6 反馈：ok 与 applied 语义区分） */
  applied?: boolean;
  /** 422 时可自纠的错误码（NOT_YOUR_TURN / ILLEGAL_ACTION / NONCE_EXPIRED / DUPLICATE_ACTION …） */
  code?: string;
  error?: string;
  legal_actions?: LegalAction[];
  /** 提交成功时回带结算后的 AgentView（slim：不含 history；幂等重放时 replayed=true） */
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
    // r7 统一错误体：message 承载人读文本、error=code 别名——优先取 message（旧 body 无 message 时回落 error）
    super(`Arena API ${status}${code ? " " + code : ""}: ${String(body.message ?? body.error ?? "请求失败")}`);
    this.name = "ArenaApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * fetch 包装：网络层异常（无法连接 / DNS / 超时）→ status=0 的 ArenaApiError（code=TIMEOUT/NETWORK_ERROR），
 * 绝不裸抛 TypeError——views() 退避重试耗尽后抛出的也应是结构化异常（r7 ot7-h1 离线实测）
 */
function fetchGuarded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) }).catch((e: unknown) => {
    const name = e instanceof Error ? e.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new ArenaApiError(0, {
      error: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: `网络请求失败：${e instanceof Error ? e.message : String(e)}`,
    });
  });
}

export class ArenaClient {
  readonly url: string;
  /** 单请求超时（毫秒）；超时/网络错误抛异常，绝不无限挂起（r6 ot-h1 反馈） */
  readonly requestTimeoutMs: number;

  constructor(url: string, opts?: { requestTimeoutMs?: number }) {
    this.url = url.replace(/\/$/, "");
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 15_000;
  }

  /** 请求并解析 JSON；非 2xx 抛 ArenaApiError（保留 body 供自纠） */
  private async request(path: string, opts: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetchGuarded(this.url + "/api/v1" + path, opts, this.requestTimeoutMs);
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

  /**
   * 挂载进行中/已结束的对局（r6 ot-h1 反馈：quickstart 曾是唯一入口）。
   * @param matchId 对局 id（建房方从房间 status 的 match_id 取；quickstart 从响应取）
   * @param seatToken 席位凭证（本人 join_token 换出的 seat_token——身份与座位的绑定物）
   * @param opts.apiKey 可选：涉及本人身份的统计端点需要；仅 view/act/events/replay 可不传
   */
  attach(matchId: string, seatToken: string, opts?: { apiKey?: string; agentId?: string }): MatchHandle {
    return new MatchHandle(this, {
      matchId,
      seatToken,
      apiKey: opts?.apiKey ?? "",
      agentId: opts?.agentId ?? "",
    });
  }

  /** 创建多人房间（创建者即 1 号位；满员自动开局） */
  async createRoom(opts: {
    game: string;
    seats?: number;
    name?: string;
    timeoutMs?: number;
    apiKey?: string;
    channel?: "http" | "webhook";
  }): Promise<{ roomId: string; joinToken: string; status: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const body: Record<string, unknown> = { game: opts.game };
    if (opts.seats !== undefined) body.seats = opts.seats;
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.timeoutMs !== undefined) body.timeout_ms = opts.timeoutMs;
    if (opts.channel) body.channel = opts.channel;
    const r = (await this.request("/lobby/rooms", { method: "POST", headers, body: JSON.stringify(body) })).body;
    return { roomId: r.room_id as string, joinToken: r.join_token as string, status: r.status as string };
  }

  /** 加入房间（webhook 通道需 apiKey 且该身份注册时带 callback_url） */
  async joinRoom(
    roomId: string,
    opts: { name?: string; apiKey?: string; channel?: "http" | "webhook" },
  ): Promise<{ roomId: string; joinToken: string; status: string; playerIndex: number }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.channel) body.channel = opts.channel;
    const r = (await this.request(`/lobby/rooms/${roomId}/join`, { method: "POST", headers, body: JSON.stringify(body) })).body;
    return {
      roomId,
      joinToken: r.join_token as string,
      status: r.status as string,
      playerIndex: r.player_index as number,
    };
  }

  /** 房间状态（waiting 公开；started 需本人 join_token 换座位分配） */
  async roomStatus(roomId: string, joinToken?: string): Promise<Record<string, unknown>> {
    return (await this.request(`/lobby/rooms/${roomId}${joinToken ? `?token=${joinToken}` : ""}`)).body;
  }

  /**
   * 轮询等待开局，返回座位分配（官方轮询模板——r6 反馈：每个 agent 都在重造这个循环）。
   * 默认超时 5 分钟（r7 ot7-h1：默认 Infinity 会让漏人的房间把参赛进程挂成僵尸）；
   * 长于默认的等待请显式传 timeoutMs（Number.POSITIVE_INFINITY = 不设限）
   */
  async waitForStart(
    roomId: string,
    joinToken: string,
    opts?: { pollMs?: number; timeoutMs?: number },
  ): Promise<{ matchId: string; seatId: SeatId; seatToken: string }> {
    const pollMs = opts?.pollMs ?? 2000;
    const deadline = Date.now() + (opts?.timeoutMs !== undefined ? opts.timeoutMs : 300_000);
    for (;;) {
      const r = await this.roomStatus(roomId, joinToken);
      if (r.status === "started" && typeof r.match_id === "string" && typeof r.seat_token === "string") {
        return { matchId: r.match_id, seatId: r.seat_id as SeatId, seatToken: r.seat_token };
      }
      if (Date.now() > deadline) {
        throw new ArenaApiError(408, { error: `waitForStart 超时（room=${roomId}）` });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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

  /** 获取当前 AgentView（slim=true 省略 history——高频轮询省流量，完整历史走 pollEvents） */
  async view(slim = false): Promise<AgentView> {
    const r = await this.client.api(`/matches/${this.matchId}/view${slim ? "?slim=1" : ""}`, {
      headers: { "x-seat-token": this.seatToken },
    });
    return r as unknown as AgentView;
  }

  /**
   * 提交动作（可选 reasoning + nonce）。
   * 业务拒绝（422）不抛异常，返回 {ok:false, status:422, code, legal_actions} 供自纠；
   * 基础设施错误（401/403/404/5xx）抛 ArenaApiError——绝不把配置问题吞成"动作被拒"（r6 ot-h1 反馈）。
   * 幂等建议：每回合生成唯一 nonce（如 `${matchId}:${turn}:act`）；同 nonce 跨回合重试将得到
   * 网关重放缓存的成功（replayed=true）或 NONCE_EXPIRED——都不会消耗新回合。
   */
  async act(action: Action, opts?: ActOptions): Promise<ActResult> {
    const body: Record<string, unknown> = { action };
    if (opts?.reasoning) body.reasoning = opts.reasoning.slice(0, 500);
    if (opts?.nonce) body.nonce = opts.nonce.slice(0, 64);
    const res = await fetchGuarded(this.client.url + `/api/v1/matches/${this.matchId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": this.seatToken },
      body: JSON.stringify(body),
    }, this.client.requestTimeoutMs);
    let r: Record<string, unknown>;
    try {
      r = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ArenaApiError(res.status, { error: `提交响应不是合法 JSON（${res.status}）` });
    }
    if (!res.ok && res.status !== 422) {
      throw new ArenaApiError(res.status, r);
    }
    return { ...(r as unknown as ActResult), status: res.status };
  }

  /** 拉取增量事件 */
  async events(since = -1): Promise<MatchEvent[]> {
    const r = await this.client.api(`/matches/${this.matchId}/events?since=${since}`, {
      headers: { "x-seat-token": this.seatToken },
    });
    return (r.events ?? []) as MatchEvent[];
  }

  /** 拉取增量事件（结构化：latestSeq 作下次 since 游标，finished 标记终局——r6 两方反馈） */
  async pollEvents(since = -1): Promise<{ events: MatchEvent[]; latestSeq: number; finished: boolean }> {
    const r = await this.client.api(`/matches/${this.matchId}/events?since=${since}`, {
      headers: { "x-seat-token": this.seatToken },
    });
    return {
      events: (r.events ?? []) as MatchEvent[],
      latestSeq: typeof r.latest_seq === "number" ? r.latest_seq : since,
      finished: r.finished === true,
    };
  }

  /**
   * 异步迭代 AgentView —— 核心参赛循环
   * ```ts
   * for await (const view of match.views()) {
   *   if (view.you.active) await match.act(myStrategy(view));
   * }
   * ```
   * 视图缺少 phase/you 字段（网关异常等）时抛错，绝不静默继续。
   * 网络抖动自动退避重试（默认 3 次，1s/2s/4s），连续失败才抛出——单次 fetch 故障不再终止整个参赛循环（r6 ot-h1 反馈）。
   */
  async *views(pollMs = 1000, activePollMs = 200, opts?: { maxRetries?: number; slim?: boolean }): AsyncGenerator<AgentView, void, void> {
    const maxRetries = opts?.maxRetries ?? 3;
    const slim = opts?.slim ?? false;
    let retries = 0;
    while (!this._finished) {
      let v: AgentView;
      try {
        v = await this.view(slim);
        retries = 0;
      } catch (e) {
        if (retries >= maxRetries) throw e;
        retries++;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (retries - 1)));
        continue;
      }
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
