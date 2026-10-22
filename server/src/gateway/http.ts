/**
 * HTTP 网关（arena/v0 · 通道 A：HTTP Pull）—— 零依赖（node:http）
 * 端点（对应 docs/02 §3）：
 *   POST /api/v1/agents                     注册
 *   GET  /api/v1/games                      游戏目录
 *   POST /api/v1/lobby/quickstart           一键开局（house bot 补位）
 *   GET  /api/v1/matches/:id/view           AgentView（无 token = 观战视角）
 *   POST /api/v1/matches/:id/actions        提交动作（422 附 legal_actions）
 *   GET  /api/v1/matches/:id/events?since=  增量事件
 *   GET  /api/v1/matches/:id/replay         事件日志 + 终局分数
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import type { Action, AgentView, MatchEvent, SeatId, SubmitOptions, SubmitResult } from "../protocol.ts";
import type { GameModule } from "../games/types.ts";
import { callLLMCommentary } from "../commentary/llm.ts";
import { Match, composeAgentView, placementsFromScores, placementsOf, winnersOf } from "../arena/match.ts";
import type { MatchResult, SeatDriver } from "../arena/match.ts";
import { createMatch } from "../arena/lobby.ts";
import { replayToState } from "../arena/replay.ts";
import { RatingStore } from "../arena/rating.ts";
import type { RatingDelta, RatingRecord } from "../arena/rating.ts";
import { houseBotsFor } from "../bots/registry.ts";
import { WebhookSeatDriver } from "./webhook.ts";
import { randomId, withTimeout } from "../util.ts";

/** HTTP Pull 座位驱动：act() 挂起等待，直到 Agent 经 POST /actions 提交（或超时兜底）。
 *  相位切换间隙（上一回合已结算、新回合 step 尚未开启）收到的提交先落地缓冲，
 *  新回合开启时立即入账——消除轮询型 Agent 的 NOT_YOUR_TURN 窗口 */
export class HttpSeatDriver implements SeatDriver {
  readonly name: string;
  /** 间隙缓冲的最长等待（超时即回明确错误，绝不无限挂起 POST） */
  private readonly earlyTimeoutMs: number;
  private pending: {
    submit: (a: Action, opts?: SubmitOptions) => SubmitResult;
    resolve: () => void;
  } | null = null;
  private early: {
    action: Action;
    opts?: SubmitOptions;
    resolve: (r: SubmitResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(name: string, earlyTimeoutMs = 60_000) {
    this.name = name;
    this.earlyTimeoutMs = earlyTimeoutMs;
  }

  /** r30：内核判定本 step 驱动超时后调用——丢弃残留的 submit 闭包，避免间隙 POST 提交进旧 step */
  reset(): void {
    this.pending = null;
  }

  act(_view: AgentView, submit: (a: Action, opts?: SubmitOptions) => SubmitResult): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.early) {
        const e = this.early;
        this.early = null;
        clearTimeout(e.timer);
        const r = submit(e.action, e.opts);
        e.resolve(r);
        if (r.ok) resolve();
        else this.pending = { submit, resolve }; // 提交失败：结果已还给 POST 等待者，继续等待修正后的动作
        return;
      }
      this.pending = { submit, resolve };
    });
  }

  handleAction(action: Action, opts?: SubmitOptions): Promise<SubmitResult> {
    if (this.pending) {
      const r = this.pending.submit(action, opts);
      if (r.ok) {
        this.pending.resolve();
        this.pending = null;
      }
      return Promise.resolve(r);
    }
    if (this.early) {
      return Promise.resolve({
        ok: false,
        error: "DUPLICATE_ACTION：本回合已提前接受动作，请等待结算",
        legal_actions: [],
      });
    }
    return new Promise<SubmitResult>((resolve) => {
      // r30 修复：原实现把 Promise 无限挂起——若该动作注定等不到下一次 act()
      // （对局刚终局、房间未开局、该席位此后不再活跃），POST 永不返回，连接与 Promise 一起泄漏。
      const timer = setTimeout(() => {
        if (this.early && this.early.timer === timer) {
          this.early = null;
          resolve({
            ok: false,
            error: "NOT_YOUR_TURN：等待回合开启超时（对局可能已结束或该席位不再行动），请重新 GET view 再决策",
            legal_actions: [],
          });
        }
      }, this.earlyTimeoutMs);
      timer.unref?.();
      this.early = { action, opts, resolve, timer };
    });
  }
}

interface RunningMatch {
  match: Match;
  gameId: string;
  startedAt: number;
  seatTokens: Map<string, SeatId>;
  httpDrivers: Map<SeatId, HttpSeatDriver>;
  seatAgents: Map<SeatId, string>;
  /** webhook 席位的终局通知回调（对局结束后推送 match.ended——r6 ot-s1 反馈：v0 从不发送该事件，Agent 只能轮询探终局） */
  webhookNotices: Map<SeatId, { url: string; secret: string }>;
  result: MatchResult | null;
  ratings: RatingDelta[] | null;
  headline: string | null;
  /** r15：恢复壳为「中止态」（落盘时对局仍在飞）——见 persistState 的 aborted 记录 */
  aborted?: boolean;
}

/**
 * r21 观众竞猜（liars.town 式 crowd suspicion）：匿名观战娱乐层——不属于 Agent 协议，
 * 投票不进事件流、不进回放、不持久化（重启即弃，对局壳本身也在内存）。
 * 进行中只暴露各席位票数；目标席位（狼/胜者）只在终局 reveal——信息隔离铁律。
 */
interface GuessState {
  /** 席位 → 当前票数 */
  votes: Map<SeatId, number>;
  /** voter_id → 当前投给的席位（改票 = 老票 -1 新票 +1） */
  voters: Map<string, SeatId>;
}

/** 单局竞猜观众数上限（r30 防刷：匿名票池纯内存、无上限时一个脚本即可撑爆） */
const MAX_GUESS_VOTERS = 2000;

/** LLM 解说在飞请求上限（r30：该端点无鉴权且按调用计费，必须有并发闸） */
const MAX_LLM_IN_FLIGHT = 20;

/** 多人房间：真人选手按加入顺序定座，满员自动开局（房主可强制开局并 bot 补位） */
interface RoomPlayer {
  joinToken: string;
  name: string;
  agentId: string;
  channel: "http" | "webhook";
  /** webhook 通道的回调（加入时凭 Bearer api_key 解析；slim=推送省略 history） */
  callback?: { url: string; secret: string; slim?: boolean };
  seat: SeatId | null;
  seatToken: string | null;
}

interface Room {
  id: string;
  game: string;
  seats: number;
  status: "waiting" | "started";
  players: RoomPlayer[];
  creatorToken: string;
  matchId: string | null;
  createdAt: number;
  /** 每回合时限覆盖（ms，5s–300s）；缺省用游戏默认 */
  timeoutMs?: number;
}

export class Gateway {
  private games = new Map<string, GameModule<unknown>>();
  private agents = new Map<string, { agent_id: string; name: string; callback_url?: string; webhook_secret?: string; push_slim?: boolean }>();
  private matches = new Map<string, RunningMatch>();
  private rooms = new Map<string, Room>();
  private ratings = new RatingStore();
  private agentNames = new Map<string, string>();
  /** nonce 重放缓存：key = matchId:seat:nonce —— 跨回合重试返回原成功，不消耗任何回合（真幂等） */
  private nonceReplay = new Map<string, true>();
  /** r15：曾持久化过的对局 id 簿记——404 三态依据（从未存在 / 超窗清理）；纯 id 上限 5000 防膨胀 */
  private knownMatchIds = new Set<string>();
  /** r21 观众竞猜票池（内存态，随对局生命周期；终局后保留供 reveal 查询） */
  private guesses = new Map<string, GuessState>();
  /** LLM 解说在飞计数（r30 并发闸） */
  private llmInFlight = 0;
  private indexHtml: string | null = null;
  private dataFile: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataFile?: string) {
    const here = dirname(fileURLToPath(import.meta.url));
    this.dataFile = dataFile ?? join(here, "..", "..", "..", "data", "arena-state.json");
    this.loadState().catch(() => { /* 首次运行无文件 */ });
  }

  registerGame(game: GameModule<unknown>): void {
    this.games.set(game.meta.id, game);
  }

  listen(port: number, onReady?: () => void): void {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        // r10 w10-s1：INVALID_JSON 统一 400 且带 code 字段（原裸 json 无 code）
        const badJson = String((e as Error)?.message ?? "").includes("INVALID_JSON");
        this.err(res, badJson ? 400 : 500, badJson ? "INVALID_JSON" : "INTERNAL",
          badJson ? "请求 body 不是合法 JSON" : `服务端内部错误：${String(e)}`);
      });
    });
    server.listen(port, onReady);
    // 定期持久化（30s）
    this.persistTimer = setInterval(() => {
      // r30：长跑内存治理放在落盘之前——先释放，再写盘
      this.pruneStaleMatches();
      this.pruneStaleRooms();
      this.persistState().catch(() => {});
    }, 30_000);
    // 进程退出时保存
    process.on("SIGINT", () => {
      this.persistState()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      this.persistState()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }

  /** 持久化到 JSON 文件（ratings + agents + 对局记录——r9：恢复后 replay 可用，历史不再随重启清零）
   *  r15（r13 P0 修复）：在飞对局也落盘为 aborted 快照——此前只存 isFinished，重启后正在进行的对局
   *  无声蒸发（MATCH_NOT_FOUND 无法区分"从未存在/已清理/被中止"）。30s 滚动即留活快照，SIGKILL 至多丢 30s；
   *  SIGTERM 走本方法兜底。进程存活期间对局继续打完时，下次落盘自然覆盖为终局记录（aborted 标记消失）。 */
  async persistState(): Promise<void> {
    const records = [...this.matches.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-100) // 最多保留 100 场（含中止快照），最老的挤出
      .map((rm) => {
        const finished = rm.match.isFinished();
        return {
          match_id: rm.match.id,
          game: rm.gameId,
          started_at: rm.startedAt,
          // 在飞快照统一标注中止（列表可见）；终局沿用原 headline
          headline: finished ? rm.headline : "进程退出时进行中（已中止）",
          aborted: finished ? undefined : true,
          seats: Object.fromEntries([...rm.seatAgents.entries()].map(([s, a]) => [String(s), a])),
          // r9 自查 P1：此前只存元数据——重启后 replay 空壳 + persistState 的 isFinished 过滤
          // 把恢复壳（恒报 false）排除在下次落盘之外，历史每重启一代即静默丢失一代（复利丢失）。
          // 现随元数据一并落盘全量事件与终局比分；rawEvents 已被 RestoredMatch 覆写为透传持久化事件
          events: rm.match.rawEvents(),
          scores: finished ? (rm.match.currentResult()?.scores ?? null) : null,
        };
      });
    for (const r of records) this.knownMatchIds.add(r.match_id);
    // r30：id 簿记本身也要有上限——原实现只在导出时 slice(-5000)，内存 Set 仍无限增长
    if (this.knownMatchIds.size > 6000) {
      for (const id of this.knownMatchIds) {
        if (this.knownMatchIds.size <= 5000) break;
        this.knownMatchIds.delete(id); // Set 迭代中删除当前元素是合法的；插入序 = 从最老删起
      }
    }
    const data = {
      saved_at: new Date().toISOString(),
      ratings: this.ratings.export(),
      agents: Object.fromEntries([...this.agents.entries()].map(([k, v]) => [k, v])),
      agentNames: Object.fromEntries([...this.agentNames.entries()]),
      matches: records,
      // r15：超窗清理后的 404 三态依据（被挤出 matches 窗口的 id 仍可识别"曾存在"）
      known_ids: [...this.knownMatchIds].slice(-5000),
    };
    const dir = dirname(this.dataFile);
    await mkdir(dir, { recursive: true });
    await writeFile(this.dataFile, JSON.stringify(data), "utf8");
  }

  /**
   * r30：长跑内存治理——bot 表演赛会持续生产对局，matches 只增不减（每 30s 落盘只切 100 场，
   * 但内存里全留着）。窗口超过 600 场时按开始时间淘汰已结束的旧局，保留 400 场。
   * 未结束的对局一律不动；被淘汰的 id 仍留在 knownMatchIds 里，404 hint 因此能说明"曾存在已清理"。
   */
  private pruneStaleMatches(): void {
    if (this.matches.size <= 600) return;
    const finishedOldestFirst = [...this.matches.values()]
      .filter((rm) => rm.match.isFinished())
      .sort((a, b) => a.startedAt - b.startedAt);
    let over = this.matches.size - 400;
    for (const rm of finishedOldestFirst) {
      if (over <= 0) break;
      this.matches.delete(rm.match.id);
      this.guesses.delete(rm.match.id); // 竞猜票池随对局一起回收（此前会永久留在内存）
      over--;
    }
  }

  /** r30：waiting 房间 TTL——从未开局的房间无人可续，纯泄漏（12h 足够覆盖一场线下组局） */
  private pruneStaleRooms(): void {
    const ttl = 12 * 3600_000;
    const now = Date.now();
    for (const [id, r] of this.rooms) {
      if (r.status === "waiting" && now - r.createdAt > ttl) this.rooms.delete(id);
    }
  }

  /** 从 JSON 文件恢复（ratings + agents + 对局历史元数据） */
  private async loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.dataFile, "utf8");
    } catch {
      return; // 首次运行
    }
    try {
      const data = JSON.parse(raw) as {
        ratings?: Record<string, Record<string, { rating: number; games: number; wins: number; draws: number; losses: number }>>;
        agents?: Record<string, { agent_id: string; name: string; callback_url?: string; webhook_secret?: string; push_slim?: boolean }>;
        agentNames?: Record<string, string>;
        matches?: {
          match_id: string;
          game: string;
          started_at: number;
          headline: string | null;
          seats: Record<string, string>;
          /** r9：旧状态文件无此二字段（undefined → 空事件回放壳，仅列表展示） */
          events?: MatchEvent[];
          scores?: Record<string, number> | null;
          /** r15：落盘时对局仍在飞（30s 滚动/SIGTERM 快照）→ 以中止态恢复 */
          aborted?: boolean;
        }[];
        /** r15：曾持久化过的对局 id（含被 100 场窗口挤出的）——旧文件无此字段 */
        known_ids?: string[];
      };
      if (data.ratings) this.ratings.import(data.ratings);
      if (data.agents) {
        for (const [k, v] of Object.entries(data.agents)) {
          this.agents.set(k, v);
        }
      }
      if (data.agentNames) {
        for (const [k, v] of Object.entries(data.agentNames)) {
          this.agentNames.set(k, v);
        }
      }
      // 恢复对局记录（终局壳 + r15 中止壳——无游戏状态，仅列表展示与事件回放；排行榜已由 ratings 覆盖）
      if (data.matches) {
        for (const m of data.matches) {
          this.knownMatchIds.add(m.match_id);
          if (!this.matches.has(m.match_id)) {
            const seatAgents = new Map<SeatId, string>();
            for (const [s, a] of Object.entries(m.seats)) {
              seatAgents.set(Number(s), a);
            }
            this.matches.set(m.match_id, {
              match: new RestoredMatch(m.match_id, { events: m.events, scores: m.scores, aborted: m.aborted === true }),
              gameId: m.game,
              startedAt: m.started_at,
              seatTokens: new Map(),
              httpDrivers: new Map(),
              seatAgents,
              webhookNotices: new Map(),
              result: null,
              ratings: null,
              headline: m.headline,
              aborted: m.aborted === true,
            });
          }
        }
      }
      // r15：known_ids 回填（含被 100 场窗口挤出、不再出现在 matches 里的历史 id）
      if (data.known_ids) {
        for (const id of data.known_ids) this.knownMatchIds.add(id);
      }
      console.log(`[持久化] 已恢复 ${this.agents.size} 选手 · ${this.matches.size} 对局 · ${Object.keys(data.ratings ?? {}).length} 游戏排行`);
    } catch (e) {
      console.error("[持久化] 恢复失败：", e);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return this.serveIndex(res);
    }
    if (method === "GET" && path === "/api/v1") {
      return this.json(res, 200, {
        protocol: "arena/v0",
        games: [...this.games.keys()],
        endpoints: [
          "POST /api/v1/agents",
          "GET  /api/v1/agents/me                档案 + 各游戏 Elo（Bearer api_key）",
          "GET  /api/v1/agents/:id               公开档案：名字 + 各游戏 Elo/W/L（r22 排行榜行点击）",
          "GET  /api/v1/agents/:id/matches?page= 战绩列表（已结束对局，倒序分页）",
          "GET  /api/v1/games",
          "POST /api/v1/lobby/quickstart",
          "GET  /api/v1/lobby/rooms               多人房间列表",
          "POST /api/v1/lobby/rooms               创建房间 {game, seats?, name?, timeout_ms?, channel?}",
          "POST /api/v1/lobby/rooms/:id/join      加入房间 {name?, channel?}（channel=webhook 需 Bearer + 已注册 callback_url）",
          "POST /api/v1/lobby/rooms/:id/start     房主强制开局（余位 bot 补位）{join_token}——未满员须另带 bots_filled:true 确认（r9 事故防线）",
          "GET  /api/v1/lobby/rooms/:id?token=    房间状态（带 join_token 获取座位分配）",
          "GET  /api/v1/matches                   最近对局列表",
          "GET  /api/v1/matches/:id/view",
          "POST /api/v1/matches/:id/actions",
          "GET  /api/v1/matches/:id/events?since=",
          "GET  /api/v1/matches/:id/replay",
          "GET  /api/v1/matches/:id/replay/step?to=<seq>&seat=N  回放步骤视图（?seat=N 需该席位 x-seat-token，或 Bearer api_key 归属——r15 恢复壳/历史对局）",
          "GET  /api/v1/matches/:id/stream        SSE 实时事件流",
          "POST /api/v1/matches/:id/guess         观众竞猜 {voter_id, seat}（匿名可改票；终局后 409 锁定）——r21 观战娱乐层",
          "GET  /api/v1/matches/:id/guess?voter_id=  竞猜票数（终局后揭底 targets/mine_hit/crowd_hit）",
          "GET  /api/v1/leaderboard/:game",
          "POST /api/v1/commentary/llm            LLM 解说金句（OpenAI 兼容 env 配置；未配置 503 回退规则词典）——r26-d 观战增强层",
        ],
      });
    }
    // r26-d LLM 解说替换位：规则词典的异步增强层（未配置 → 503，前端静默回退规则词）
    if (method === "POST" && path === "/api/v1/commentary/llm") {
      // r30：本端点是全站唯一「无鉴权且直接花钱」的入口——没有并发闸时一个循环脚本
      // 就能把 LLM 额度打空（前端只在 LLM 开关打开且高光事件时调用，正常观战远达不到 20 并发）。
      if (this.llmInFlight >= MAX_LLM_IN_FLIGHT) {
        return this.err(res, 429, "RATE_LIMITED",
          `LLM 解说并发已达上限（${MAX_LLM_IN_FLIGHT}）——规则解说已在客户端就位，稍后重试即可`,
          { path: "/api/v1/commentary/llm" });
      }
      this.llmInFlight += 1;
      try {
        const body = await readJson(req);
        const r = await callLLMCommentary({
          mid: String(body.mid ?? ""),
          seq: Number(body.seq),
          type: String(body.type ?? ""),
          data: body.data,
          ruleText: typeof body.rule_text === "string" ? body.rule_text : "",
        });
        if (!r.ok) {
          const status = r.code === "LLM_NOT_CONFIGURED" ? 503 : r.code === "LLM_BAD_INPUT" ? 422 : 502;
          return this.err(res, status, r.code, r.message, { path: "/api/v1/commentary/llm" });
        }
        return this.json(res, 200, { ok: true, text: r.text, cached: r.cached });
      } finally {
        this.llmInFlight -= 1;
      }
    }
    if (method === "POST" && path === "/api/v1/agents") {
      const body = await readJson(req);
      const name = String(body.name ?? "agent-" + randomId(""));
      const apiKey = "sk_" + randomId("");
      const callbackUrl = typeof body.callback_url === "string" ? body.callback_url : undefined;
      // r10 w10-h2 P1：webhook_secret 入参曾被忽略（恒自生成）——协议 §3.1 "可选自供"语义恢复：
      // 入参为非空 string 时采用（Agent 可预置 secret，免"注册→读响应→再配验签"往返），否则平台生成
      const providedSecret = typeof body.webhook_secret === "string" && body.webhook_secret.length > 0
        ? body.webhook_secret
        : undefined;
      const webhookSecret = callbackUrl ? (providedSecret ?? "whsec_" + randomId("")) : undefined;
      // r9 backlog：webhook 推送 slim 选项（wh9-h1 实测全量 view 14.9KB/推送）——true 时 turn.start 不带 history
      const pushSlim = body.push_slim === true;
      const agentId = "a_" + randomId("");
      this.agents.set(apiKey, {
        agent_id: agentId,
        name,
        callback_url: callbackUrl,
        webhook_secret: webhookSecret,
        push_slim: callbackUrl ? pushSlim : undefined,
      });
      return this.json(res, 201, {
        agent_id: agentId,
        api_key: apiKey,
        name,
        callback_url: callbackUrl ?? null,
        webhook_secret: webhookSecret ?? null,
        push_slim: callbackUrl ? pushSlim : null,
      });
    }
    // GET /agents/me：档案 + 各游戏 Elo（r9 dc9-d1/dc9-d2/dc9-h1/w9-s2 四方报告：文档 §3.1 承诺但 404）
    if (method === "GET" && path === "/api/v1/agents/me") {
      const auth = typeof req.headers.authorization === "string"
        ? req.headers.authorization.replace(/^Bearer\s+/i, "")
        : "";
      const known = auth ? this.agents.get(auth) : undefined;
      if (!known) {
        return this.err(res, 401, "AUTH_INVALID", "缺少或无效的 Bearer api_key（GET /agents/me 需注册时返回的 api_key）", { path: "/api/v1/agents/me" });
      }
      const ratings: Record<string, RatingRecord> = {};
      for (const gameId of this.games.keys()) {
        const r = this.ratings.peek(gameId, known.agent_id);
        if (r) ratings[gameId] = r;
      }
      return this.json(res, 200, {
        agent_id: known.agent_id,
        name: known.name,
        callback_url: known.callback_url ?? null,
        push_slim: known.callback_url ? known.push_slim === true : null,
        ratings,
      });
    }
    // GET /agents/:id：公开档案（r22）——排行榜行点击进档案页；无 Bearer（公开信息：
    // 名字 + 各游戏 Elo/W/L；不含 callback_url 等 API 凭据面）。/agents/me 走 Bearer 已在上面拦截。
    const agentProfile = /^\/api\/v1\/agents\/([^/]+)$/.exec(path);
    if (method === "GET" && agentProfile) {
      const agentId = decodeURIComponent(agentProfile[1]!);
      const name = this.nameOf(agentId);
      if (name === agentId && ![...this.agents.values()].some((a) => a.agent_id === agentId)) {
        return this.err(res, 404, "AGENT_NOT_FOUND", "选手不存在（agent_id 见 /api/v1/leaderboard/:game 或注册响应）", { agent_id: agentId, path: `/api/v1/agents/${agentId}` });
      }
      const ratings: Record<string, RatingRecord> = {};
      for (const gameId of this.games.keys()) {
        const r = this.ratings.peek(gameId, agentId);
        if (r) ratings[gameId] = r;
      }
      return this.json(res, 200, { agent_id: agentId, name, house: agentId.startsWith("house:"), ratings });
    }
    // GET /agents/:id/matches?page=：战绩列表（r9：文档承诺未实现；只列已结束对局，倒序分页）
    const agentMatches = /^\/api\/v1\/agents\/([^/]+)\/matches$/.exec(path);
    if (method === "GET" && agentMatches) {
      const agentId = decodeURIComponent(agentMatches[1]!);
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const perPage = 20;
      const mine = [...this.matches.values()]
        .filter((rm) => rm.match.isFinished() && [...rm.seatAgents.values()].includes(agentId))
        .sort((a, b) => b.startedAt - a.startedAt);
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      return this.json(res, 200, {
        agent_id: agentId,
        page,
        per_page: perPage,
        total: mine.length,
        has_more: page * perPage < mine.length,
        matches: slice.map((rm) => {
          const mySeat = [...rm.seatAgents.entries()].find(([, a]) => a === agentId)?.[0];
          const scores = rm.match.currentResult()?.scores ?? null;
          return {
            match_id: rm.match.id,
            game: rm.gameId,
            started_at: rm.startedAt,
            headline: rm.headline,
            my_seat: mySeat ?? null,
            scores,
          };
        }),
      });
    }
    if (method === "POST" && path === "/api/v1/webhook/test") {
      return this.webhookTest(req, res);
    }
    if (method === "GET" && path === "/api/v1/matches") {
      // r28：窗口 20 → 60。大厅的「N 场直播」「赛区桌数」「最近对局」都从这份列表派生，
      // 而 bot 表演赛会持续产生新对局——20 条窗口很快被已散场的桌占满，把仍在进行的直播
      // 挤出窗口（实测 12 桌在飞却只报 5 场直播）。60 条仍远小于持久化侧的 100 场滚动窗口。
      const list = [...this.matches.values()]
        .map((rm) => ({
          match_id: rm.match.id,
          game: rm.gameId,
          finished: rm.match.isFinished(),
          // r15：中止壳显式标记（落盘时仍在飞，无终局比分）——大厅可显示「已中止」而非伪「已结束」
          aborted: rm.aborted === true,
          started_at: rm.startedAt,
          headline: rm.headline,
          seats: [...rm.seatAgents.keys()].sort((a, b) => a - b).map((s) => this.nameOf(rm.seatAgents.get(s)!)),
        }))
        .slice(-60)
        .reverse();
      return this.json(res, 200, { matches: list });
    }
    if (method === "GET" && path === "/api/v1/games") {
      return this.json(res, 200, {
        games: [...this.games.values()].map((g) => ({
          id: g.meta.id,
          name: g.meta.name,
          min_seats: g.meta.minSeats,
          max_seats: g.meta.maxSeats,
          default_timeout_ms: g.meta.defaultTimeoutMs,
        })),
      });
    }
    if (method === "POST" && path === "/api/v1/lobby/quickstart") {
      return this.quickstart(req, await readJson(req), res);
    }
    if (method === "GET" && path === "/api/v1/lobby/rooms") {
      return this.roomList(res);
    }
    if (method === "POST" && path === "/api/v1/lobby/rooms") {
      return this.roomCreate(req, res);
    }
    const roomJoin = /^\/api\/v1\/lobby\/rooms\/([^/]+)\/join$/.exec(path);
    if (method === "POST" && roomJoin) {
      return this.roomJoin(roomJoin[1], req, res);
    }
    const roomStart = /^\/api\/v1\/lobby\/rooms\/([^/]+)\/start$/.exec(path);
    if (method === "POST" && roomStart) {
      return this.roomStart(roomStart[1], req, res);
    }
    const roomGet = /^\/api\/v1\/lobby\/rooms\/([^/]+)$/.exec(path);
    if (method === "GET" && roomGet) {
      return this.roomStatus(roomGet[1], url, res);
    }
    const lb = /^\/api\/v1\/leaderboard\/([^/]+)$/.exec(path);
    if (method === "GET" && lb) {
      const rows = this.ratings.leaderboard(lb[1]).map((row) => ({
        ...row,
        name: this.nameOf(row.agent),
        house: row.agent.startsWith("house:"),
      }));
      return this.json(res, 200, { game: lb[1], leaderboard: rows });
    }
    const step = /^\/api\/v1\/matches\/([^/]+)\/replay\/step$/.exec(path);
    if (method === "GET" && step) {
      return this.replayStep(step[1], url, req, res);
    }
    const stream = /^\/api\/v1\/matches\/([^/]+)\/stream$/.exec(path);
    if (method === "GET" && stream) {
      return this.sseStream(stream[1], req, res);
    }
    const m = /^\/api\/v1\/matches\/([^/]+)\/(view|actions|events|replay|guess)$/.exec(path);
    if (m) return this.matchOp(m[1], m[2], method, url, req, res);
    const hint = this.notFoundHint(path);
    return this.err(res, 404, "NOT_FOUND", hint, { path, hint });
  }

  /** 404 提示按路径分级——定向提示优于通用清单（r6 实测：误导性 hint 让测试者得出"排行榜不存在"的错误结论并反向印证） */
  private notFoundHint(path: string): string {
    if (path.startsWith("/api/v1/leaderboard")) {
      return "排行榜需指定游戏：GET /api/v1/leaderboard/{game}（游戏 id 见 GET /api/v1/games）";
    }
    if (path.startsWith("/api/v1/lobby")) {
      return "大厅端点：GET /lobby/rooms（列表）· POST /lobby/rooms（建房）· POST /lobby/rooms/:id/join|start · GET /lobby/rooms/:id?token= · POST /lobby/quickstart";
    }
    if (/^\/api\/v1\/matches\/[^/]+/.test(path)) {
      return "对局子路径仅支持 view|actions|events|replay|guess（另有 /stream 与 /replay/step）";
    }
    if (path.startsWith("/api/v1/agents") || path.startsWith("/api/v1/webhook")) {
      return "注册：POST /api/v1/agents；webhook 自检：POST /api/v1/webhook/test（Bearer）";
    }
    return "未知端点；完整清单见 GET /api/v1";
  }

  private quickstart(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    const gameId = String(body.game ?? "liars_dice");
    const game = this.games.get(gameId);
    if (!game) return this.err(res, 404, "GAME_NOT_FOUND", `游戏 ${gameId} 不存在（可用游戏见 GET /api/v1/games）`, { game: gameId, path: "/api/v1/lobby/quickstart", hint: "游戏 id 见 GET /api/v1/games" });
    const total = clamp(Number(body.seats ?? game.meta.minSeats), game.meta.minSeats, game.meta.maxSeats);

    // 选手身份：Bearer api_key（老选手）或自动创建游客（返回 api_key 便于留存身份）
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization.replace(/^Bearer\s+/i, "")
      : "";
    const known = auth ? this.agents.get(auth) : undefined;
    const apiKey = known ? auth : "sk_" + randomId("");
    const agentName = String(body.name ?? known?.name ?? "guest-" + randomId(""));
    if (!known) this.agents.set(apiKey, { agent_id: "a_" + randomId(""), name: agentName });
    const agentId = this.agents.get(apiKey)!.agent_id;
    this.agentNames.set(agentId, agentName);

    const useWebhook = body.channel === "webhook" && known?.callback_url && known.webhook_secret;
    const humanDriver = useWebhook
      ? new WebhookSeatDriver({
          name: agentName,
          url: known!.callback_url!,
          secret: known!.webhook_secret!,
          timeoutMs: Math.max(1000, game.meta.defaultTimeoutMs - 500),
          slim: known!.push_slim === true,
        })
      : new HttpSeatDriver(agentName);
    const human: SeatDriver = humanDriver;
    const house = houseBotsFor(gameId, total - 1);
    const drivers: SeatDriver[] = [human, ...house.map((h) => h.driver)];

    const match = createMatch({
      game,
      drivers,
      graceMs: 15000,
      minPhaseMs: gameId === "werewolf_lite" ? 4000 : 0,
      // r13：席位 2..N 为 house bot 补位（写入 match_started.bot_filled）
      botSeats: house.map((_h, i) => i + 2),
    });
    const seatToken = "st_" + randomId("");
    const seatAgents = new Map<SeatId, string>();
    seatAgents.set(1, agentId);
    house.forEach((h, i) => {
      seatAgents.set(i + 2, h.agent);
      this.agentNames.set(h.agent, h.name);
    });

    const httpDrivers = new Map<SeatId, HttpSeatDriver>();
    if (humanDriver instanceof HttpSeatDriver) httpDrivers.set(1, humanDriver);

    const rm: RunningMatch = {
      match,
      gameId,
      startedAt: Date.now(),
      seatTokens: new Map([[seatToken, 1]]),
      httpDrivers,
      seatAgents,
      webhookNotices: useWebhook
        ? new Map([[1, { url: known!.callback_url!, secret: known!.webhook_secret! }]])
        : new Map(),
      result: null,
      ratings: null,
      headline: null,
    };
    this.matches.set(match.id, rm);
    this.runMatchBookkeeping(rm);

    return this.json(res, 200, {
      match_id: match.id,
      seat_id: 1,
      seat_token: seatToken,
      api_key: apiKey,
      agent_id: agentId,
      game: gameId,
      seats: total,
      hint: useWebhook
        ? "等待平台把回合推送到你的 callback（x-arena-signature 验签），回 200 + {action, reasoning?}"
        : "轮询 GET view，you.active=true 时 POST actions（可附 reasoning / nonce）",
    });
  }

  /** 对局终局记账（headline + Elo + webhook 终局通知），quickstart 与房间开局共用 */
  private runMatchBookkeeping(rm: RunningMatch): void {
    rm.match
      .run()
      .then((r) => {
        rm.result = r;
        rm.headline = this.makeHeadline(rm.gameId, r);
        if (!r.events.some((e) => e.type === "match_failed")) {
          rm.ratings = this.ratings.applyMatch(rm.gameId, rm.seatAgents, r.scores);
        }
        this.notifyWebhookEnd(rm, r.scores);
      })
      .catch((e) => console.error("[match error]", rm.match.id, e));
  }

  /** 终局通知：向 webhook 席位推送 match.ended（HMAC 签名同 turn.start；fire-and-forget，失败仅记日志不影响对局） */
  private notifyWebhookEnd(rm: RunningMatch, scores: Record<SeatId, number>): void {
    if (rm.webhookNotices.size === 0) return;
    const body = JSON.stringify({
      event: "match.ended",
      match_id: rm.match.id,
      game: rm.gameId,
      result: { scores },
    });
    for (const [seat, cb] of rm.webhookNotices) {
      const sig = createHmac("sha256", cb.secret).update(body).digest("hex");
      withTimeout(
        fetch(cb.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-arena-event": "match.ended",
            "x-arena-delivery": "d-end-" + randomId(""),
            "x-arena-signature": "sha256=" + sig,
          },
          body,
        }),
        8000,
      )
        .then(() => {})
        .catch((e) => console.error(`[webhook] match.ended 推送失败 seat=${seat}:`, e));
    }
  }

  /** 请求者身份：Bearer api_key 关联老选手（Elo 累积），否则匿名游客 */
  private identityOf(req: IncomingMessage, fallbackName: string): { agentId: string; name: string } {
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization.replace(/^Bearer\s+/i, "")
      : "";
    const known = auth ? this.agents.get(auth) : undefined;
    if (known) return { agentId: known.agent_id, name: known.name };
    return { agentId: "a_" + randomId(""), name: fallbackName };
  }

  /** 房间通道解析：channel="webhook" 需 Bearer api_key 且注册时带 callback_url；缺省 http */
  private roomChannelOf(
    req: IncomingMessage,
    body: Record<string, unknown>,
  ):
    | { ok: true; channel: "http" }
    | { ok: true; channel: "webhook"; callback: { url: string; secret: string; slim?: boolean } }
    | { ok: false; status: number; code: string; message: string } {
    if (body.channel !== "webhook") return { ok: true, channel: "http" };
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization.replace(/^Bearer\s+/i, "")
      : "";
    const known = auth ? this.agents.get(auth) : undefined;
    if (!known) {
      return {
        ok: false,
        status: 401,
        code: "WEBHOOK_AUTH_REQUIRED",
        message: "channel=webhook 需 Authorization: Bearer <api_key>（注册 POST /agents 时须带 callback_url）",
      };
    }
    if (!known.callback_url || !known.webhook_secret) {
      return {
        ok: false,
        status: 400,
        code: "WEBHOOK_NOT_REGISTERED",
        message: "该 api_key 注册时未提供 callback_url，无法走 webhook 通道；请重新 POST /agents 并携带 callback_url",
      };
    }
    return { ok: true, channel: "webhook", callback: { url: known.callback_url, secret: known.webhook_secret, slim: known.push_slim === true } };
  }

  /** 创建多人房间（创建者即 1 号候选人；满员自动开局） */
  private roomCreate(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      const gameId = String(body.game ?? "");
      const game = this.games.get(gameId);
      if (!game) return this.err(res, 404, "GAME_NOT_FOUND", `游戏 ${gameId} 不存在（可用游戏见 GET /api/v1/games）`, { game: gameId, path: "/api/v1/lobby/rooms", hint: "游戏 id 见 GET /api/v1/games" });
      const seats = clamp(Number(body.seats ?? game.meta.minSeats), game.meta.minSeats, game.meta.maxSeats);
      const timeoutMsRaw = Number(body.timeout_ms);
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? clamp(timeoutMsRaw, 5_000, 300_000)
        : undefined;
      const name = String(body.name ?? "host-" + randomId(""));
      const ch = this.roomChannelOf(req, body);
      if (!ch.ok) return this.err(res, ch.status, ch.code, ch.message);
      const me = this.identityOf(req, name);
      if (me.name === name && !body.name) this.agentNames.set(me.agentId, name);
      else this.agentNames.set(me.agentId, me.name);
      const joinToken = "jt_" + randomId("");
      const room: Room = {
        id: "r_" + randomId(""),
        game: gameId,
        seats,
        status: "waiting",
        players: [{
          joinToken,
          name: me.name,
          agentId: me.agentId,
          channel: ch.channel,
          callback: ch.channel === "webhook" ? ch.callback : undefined,
          seat: null,
          seatToken: null,
        }],
        creatorToken: joinToken,
        matchId: null,
        createdAt: Date.now(),
        timeoutMs,
      };
      this.rooms.set(room.id, room);
      const started = this.tryStartRoom(room, false);
      return this.json(res, 201, {
        room_id: room.id,
        join_token: joinToken,
        game: gameId,
        seats,
        players: room.players.length,
        status: started ? "started" : "waiting",
        channel: ch.channel,
        hint: ch.channel === "webhook"
          ? "你是 webhook 通道：开局后回合将推送到你的 callback（x-arena-signature 验签），回 200 + {action, reasoning?}，无需轮询。"
          : "其他人 POST /lobby/rooms/" + room.id + "/join 加入；满员自动开局。轮询 GET 本房间（带 join_token）获取座位分配。",
      });
    })().catch((e) => this.failErr(res, e));
  }

  /** 加入房间（按加入顺序定座） */
  private roomJoin(roomId: string, req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const room = this.rooms.get(roomId);
      if (!room) return this.err(res, 404, "ROOM_NOT_FOUND", "房间不存在或已过期", { room_id: roomId, path: `/api/v1/lobby/rooms/${roomId}/join`, hint: "room_id 有误或已过期；房间列表见 GET /api/v1/lobby/rooms" });
      const body = await readJson(req);
      const name = String(body.name ?? "player-" + randomId(""));
      // r13 P0 修复：join 幂等化——同 agent 重复 join 返回原 join_token，不重复占座。
      // 废局事故根因：join_token 只回传一次且仅存内存，进程被杀即席位永久失联（无按 agent 找回通道）。
      // 幂等检查在 ROOM_FULL/ROOM_STARTED 之前——已入座者重连（含对局进行中）必须能拿回 token 续战。
      const me = this.identityOf(req, name);
      const existing = room.players.find((p) => p.agentId === me.agentId);
      if (existing) {
        return this.json(res, 200, {
          room_id: room.id,
          join_token: existing.joinToken,
          player_index: room.players.indexOf(existing) + 1,
          seats: room.seats,
          players: room.players.length,
          status: room.status,
          channel: existing.channel,
          replay: true,
          hint: "你已在本房间（幂等返回原 join_token）——进程重启后凭此续接；轮询 GET /lobby/rooms/" + room.id + "?token=" + existing.joinToken + " 获取座位分配（started 后含 seat_token）。",
        });
      }
      if (room.players.length >= room.seats) return this.err(res, 409, "ROOM_FULL", "房间已满", { room_id: roomId });
      if (room.status === "started") return this.err(res, 409, "ROOM_STARTED", "对局已开始，不可加入", { room_id: roomId });
      const ch = this.roomChannelOf(req, body);
      if (!ch.ok) return this.err(res, ch.status, ch.code, ch.message);
      this.agentNames.set(me.agentId, me.name);
      const joinToken = "jt_" + randomId("");
      room.players.push({
        joinToken,
        name: me.name,
        agentId: me.agentId,
        channel: ch.channel,
        callback: ch.channel === "webhook" ? ch.callback : undefined,
        seat: null,
        seatToken: null,
      });
      const started = this.tryStartRoom(room, false);
      return this.json(res, 200, {
        room_id: room.id,
        join_token: joinToken,
        player_index: room.players.length,
        seats: room.seats,
        players: room.players.length,
        status: started ? "started" : "waiting",
        channel: ch.channel,
        hint: ch.channel === "webhook"
          ? "你是 webhook 通道：开局后回合将推送到你的 callback，无需轮询。"
          : "轮询 GET /lobby/rooms/" + room.id + "?token=" + joinToken + " 直至 status=started，凭 seat_token 参赛。",
      });
    })().catch((e) => this.failErr(res, e));
  }

  /** 房主强制开局：余位由 house bot 补齐（至少 1 名真人） */
  private roomStart(roomId: string, req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const room = this.rooms.get(roomId);
      if (!room) return this.err(res, 404, "ROOM_NOT_FOUND", "房间不存在或已过期", { room_id: roomId, path: `/api/v1/lobby/rooms/${roomId}/start`, hint: "room_id 有误或已过期；仅房主可强制开局" });
      const body = await readJson(req);
      if (String(body.join_token ?? "") !== room.creatorToken) {
        return this.err(res, 403, "ROOM_FORBIDDEN", "仅房主可强制开局");
      }
      if (room.status === "started") return this.err(res, 409, "ROOM_STARTED", "对局已开始");
      // r9 第 6 席时序事故防线（VERDICT-r9 §4 教训 3）：未满员强制开局须显式确认——
      // 房主误触/抢跑不再有"静默 bot 补位"路径，编排方也能以 409 为信号继续等待
      const emptySeats = room.seats - room.players.length;
      if (emptySeats > 0 && body.bots_filled !== true) {
        return this.err(res, 409, "BOTS_FILL_REQUIRED",
          `房间未满员（还差 ${emptySeats} 席）——强制开局将以 house bot 补齐，须显式传 {"bots_filled": true} 确认`,
          { room_id: roomId, seats_remaining: emptySeats, bots_to_fill: emptySeats,
            hint: '确认补位请重试并在 body 带 {"bots_filled": true}；或等待真人满员自动开局（GET 本房间可看 seats_remaining）' });
      }
      const ok = this.tryStartRoom(room, true);
      if (!ok) return this.err(res, 500, "ROOM_START_FAILED", "开局失败（服务端内部错误）");
      const me = room.players[0]!;
      return this.json(res, 200, {
        room_id: room.id,
        status: "started",
        match_id: room.matchId,
        seat_id: me.seat,
        seat_token: me.seatToken,
        bots_filled: room.seats - room.players.length,
      });
    })().catch((e) => this.failErr(res, e));
  }

  /** 尝试开局：满员自动开；fillWithBots 时余位补 house bot。开局成功返回 true */
  private tryStartRoom(room: Room, fillWithBots: boolean): boolean {
    if (room.status === "started") return false;
    const game = this.games.get(room.game);
    if (!game || room.players.length === 0) return false;
    const bots = room.seats - room.players.length;
    if (bots < 0) return false;
    if (bots > 0 && !fillWithBots) return false;

    const house = bots > 0 ? houseBotsFor(room.game, bots) : [];
    // 按通道构造驱动：webhook 席位由平台推送回合（拉取超时留 500ms 余量给内核超时裁判）
    const humanDrivers: SeatDriver[] = room.players.map((p) =>
      p.channel === "webhook" && p.callback
        ? new WebhookSeatDriver({
            name: p.name,
            url: p.callback.url,
            secret: p.callback.secret,
            timeoutMs: Math.max(1000, (room.timeoutMs ?? game.meta.defaultTimeoutMs) - 500),
            slim: p.callback.slim === true,
          })
        : new HttpSeatDriver(p.name),
    );
    const drivers: SeatDriver[] = [...humanDrivers, ...house.map((h) => h.driver)];
    const match = createMatch({
      game,
      drivers,
      graceMs: 15000,
      minPhaseMs: room.game === "werewolf_lite" ? 4000 : 0,
      timeoutMs: room.timeoutMs,
      // r13：补位的 house bot 席位（人类席位之后）——写入 match_started.bot_filled
      botSeats: house.map((_h, i) => room.players.length + i + 1),
    });
    const seatAgents = new Map<SeatId, string>();
    room.players.forEach((p, i) => {
      p.seat = i + 1;
      p.seatToken = "st_" + randomId("");
      seatAgents.set(p.seat, p.agentId);
      this.agentNames.set(p.agentId, p.name);
    });
    house.forEach((h, i) => {
      seatAgents.set(room.players.length + i + 1, h.agent);
      this.agentNames.set(h.agent, h.name);
    });
    const seatTokens = new Map<string, SeatId>();
    for (const p of room.players) seatTokens.set(p.seatToken!, p.seat!);
    const httpDrivers = new Map<SeatId, HttpSeatDriver>();
    humanDrivers.forEach((d, i) => {
      if (d instanceof HttpSeatDriver) httpDrivers.set(i + 1, d);
    });
    const webhookNotices = new Map<SeatId, { url: string; secret: string }>();
    room.players.forEach((p, i) => {
      if (p.channel === "webhook" && p.callback) webhookNotices.set(i + 1, p.callback);
    });

    const rm: RunningMatch = {
      match,
      gameId: room.game,
      startedAt: Date.now(),
      seatTokens,
      httpDrivers,
      seatAgents,
      webhookNotices,
      result: null,
      ratings: null,
      headline: null,
    };
    this.matches.set(match.id, rm);
    room.status = "started";
    room.matchId = match.id;
    this.runMatchBookkeeping(rm);
    return true;
  }

  /** 房间状态：waiting 公开人数；started 凭 join_token 换座位分配 */
  private roomStatus(roomId: string, url: URL, res: ServerResponse): void {
    const room = this.rooms.get(roomId);
    if (!room) return this.err(res, 404, "ROOM_NOT_FOUND", "房间不存在或已过期", { room_id: roomId, path: `/api/v1/lobby/rooms/${roomId}`, hint: "room_id 有误或已过期；房间列表见 GET /api/v1/lobby/rooms" });
    if (room.status === "waiting") {
      return this.json(res, 200, {
        room_id: room.id,
        status: "waiting",
        game: room.game,
        seats: room.seats,
        players: room.players.length,
        // r9 w9-s2：waiting 期没有剩余席位数，轮询者无法判断还差几人开局
        seats_remaining: room.seats - room.players.length,
        names: room.players.map((p) => p.name),
        channels: room.players.map((p) => p.channel),
      });
    }
    const token = url.searchParams.get("token");
    const me = token ? room.players.find((p) => p.joinToken === token) : undefined;
    if (!me) {
      return this.json(res, 200, {
        room_id: room.id,
        status: "started",
        game: room.game,
        match_id: room.matchId,
        seats: room.seats,
      });
    }
    return this.json(res, 200, {
      room_id: room.id,
      status: "started",
      game: room.game,
      match_id: room.matchId,
      seat_id: me.seat,
      seat_token: me.seatToken,
      channel: me.channel,
      seats: room.seats,
    });
  }

  /** 房间列表（waiting 在前，各取最新若干） */
  private roomList(res: ServerResponse): void {
    const all = [...this.rooms.values()].sort((a, b) => b.createdAt - a.createdAt);
    const shape = (r: Room) => ({
      room_id: r.id,
      game: r.game,
      seats: r.seats,
      players: r.players.length,
      status: r.status,
      match_id: r.matchId,
      names: r.players.map((p) => p.name),
      channels: r.players.map((p) => p.channel),
    });
    const waiting = all.filter((r) => r.status === "waiting").slice(0, 20);
    const started = all.filter((r) => r.status === "started").slice(0, 10);
    return this.json(res, 200, { rooms: [...waiting, ...started].map(shape) });
  }

  private nameOf(agent: string): string {
    const n = this.agentNames.get(agent);
    if (n) return n;
    return agent.startsWith("house:") ? agent.replace("house:", "house·") : agent;
  }

  /** Webhook 自检：向已注册 callback 发一条带签名的样例推送（Agent 验收通道 B 的最快方式） */
  private async webhookTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization.replace(/^Bearer\s+/i, "")
      : "";
    const agent = auth ? this.agents.get(auth) : undefined;
    if (!agent || !agent.callback_url || !agent.webhook_secret) {
      return this.err(res, 400, "WEBHOOK_NOT_REGISTERED", "请先以 callback_url 注册（POST /agents），并携带 Authorization: Bearer <api_key>");
    }
    const body = JSON.stringify({
      event: "turn.start",
      view: {
        protocol: "arena/v0",
        match_id: "webhook-selftest",
        game: "selftest",
        phase: "test",
        round: 0,
        deadline_ms: null,
        ms_remaining: null,
        you: { seat: 1, active: true },
        public: { note: "Webhook 自检推送：验签通过后可回 200 {\"action\":{\"type\":\"pass\"}}" },
        private: {},
        legal_actions: [{ type: "pass" }],
        history: [],
        result: null,
      },
    });
    const sig = createHmac("sha256", agent.webhook_secret).update(body).digest("hex");
    const t0 = Date.now();
    try {
      const r = await withTimeout(
        fetch(agent.callback_url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-arena-event": "turn.start",
            "x-arena-delivery": "d-selftest-" + randomId(""),
            "x-arena-signature": "sha256=" + sig,
          },
          body,
        }),
        8000,
      );
      return this.json(res, 200, { delivered: true, status: r.status, latency_ms: Date.now() - t0 });
    } catch (e) {
      return this.json(res, 200, { delivered: false, error: String(e), latency_ms: Date.now() - t0 });
    }
  }

  /** 战报标题：异常中断优先；阵营制（狼人杀/卧底）报阵营，其余报胜者席位 */
  private makeHeadline(gameId: string, r: MatchResult): string {
    if (r.events.some((e) => e.type === "match_failed")) return "异常中断";
    if (gameId === "werewolf_lite" || gameId === "undercover") {
      const won = r.events.find((e) => e.type === "game_won");
      const w = (won?.data as { winner?: string } | undefined)?.winner;
      if (gameId === "werewolf_lite") {
        return w === "good" ? "好人阵营胜" : w === "wolves" ? "狼人阵营胜" : "已结束";
      }
      return w === "civilians" ? "平民阵营胜" : w === "undercover" ? "卧底胜" : "已结束";
    }
    // r30 修复：原判据「所有席位都是 0.5 才算平局」——阵营制/多席位并列最高分时会取第一个
    // 最高分席位报「N 号位胜」（卧底平民 5 人各 1 分 → 谎称 1 号位胜）。改为以 winnersOf 为准：
    // 无胜者=平局，多席位=并列胜，唯一=该席位胜。
    const winners = winnersOf(r.scores);
    if (winners.length === 0) return "平局";
    if (winners.length === 1) return `${winners[0]} 号位胜`;
    return `${winners.length} 席并列胜`;
  }

  /** 观战 Web 静态页（零依赖托管） */
  private async serveIndex(res: ServerResponse): Promise<void> {
    if (this.indexHtml === null) {
      const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "index.html");
      this.indexHtml = await readFile(file, "utf8");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(this.indexHtml);
  }

  /** 纯 bot 对局：大厅演示/预热内容（同时给排行榜提供基线数据） */
  startBotMatch(gameId: string): string {
    const game = this.games.get(gameId);
    if (!game) throw new Error("unknown game: " + gameId);
    const total = Math.min(game.meta.maxSeats, Math.max(game.meta.minSeats, 3));
    const house = houseBotsFor(gameId, total);
    const match = createMatch({ game, drivers: house.map((h) => h.driver), botSeats: house.map((_h, i) => i + 1) });
    const seatAgents = new Map<SeatId, string>();
    house.forEach((h, i) => {
      seatAgents.set(i + 1, h.agent);
      this.agentNames.set(h.agent, h.name);
    });
    const rm: RunningMatch = {
      match,
      gameId,
      startedAt: Date.now(),
      seatTokens: new Map(),
      httpDrivers: new Map(),
      seatAgents,
      webhookNotices: new Map(),
      result: null,
      ratings: null,
      headline: null,
    };
    this.matches.set(match.id, rm);
    match
      .run()
      .then((r) => {
        rm.result = r;
        rm.headline = this.makeHeadline(gameId, r);
        if (!r.events.some((e) => e.type === "match_failed")) {
          rm.ratings = this.ratings.applyMatch(gameId, seatAgents, r.scores);
        }
      })
      .catch((e) => console.error("[match error]", match.id, e));
    return match.id;
  }

  /** SSE 实时推送：GET /matches/:id/stream（观战/参赛者均可用，事件按可见性过滤） */
  private sseStream(matchId: string, req: IncomingMessage, res: ServerResponse): void {
    const rm = this.matches.get(matchId);
    if (!rm) {
      return this.err(res, 404, "MATCH_NOT_FOUND", "对局不存在或已过期", { match_id: matchId, path: `/api/v1/matches/${matchId}/stream`, hint: this.matchNotFoundHint(matchId) });
    }
    // r15：与 matchOp 同源的双链解析（活局 token → Bearer 归属 → 观战）
    const viewer: SeatId | "spectator" = this.resolveSeatIdentity(rm, req).seat ?? "spectator";

    // SSE 头
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n\n`);

    // 初始追赶：发送当前可见的全部事件
    let lastSeq = -1;
    for (const ev of rm.match.eventsFor(viewer)) {
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      lastSeq = ev.seq;
    }

    // 订阅新事件
    const unsub = rm.match.subscribe((ev) => {
      // 按可见性过滤
      if (ev.visibility !== "all") {
        if (viewer === "spectator" || !ev.visibility.seats.includes(viewer)) return;
      }
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
      try {
        res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch {
        unsub();
      }
    });

    // 终局后发 done 并关闭
    const doneCheck = () => {
      if (rm.match.isFinished()) {
        res.write(`event: done\ndata: ${JSON.stringify({ finished: true })}\n\n`);
        unsub();
        res.end();
      }
    };
    doneCheck();
    const doneSub = rm.match.subscribe((ev) => {
      if (ev.type === "match_ended" || ev.type === "match_failed") {
        setTimeout(doneCheck, 100);
      }
    });

    // 客户端断开
    req.on("close", () => {
      unsub();
      doneSub();
    });
  }

  /** 回放步骤：重放到指定事件序号，返回该时刻指定视角的 AgentView（视角切换回放的服务端基础） */
  private replayStep(matchId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const rm = this.matches.get(matchId);
    if (!rm) return this.err(res, 404, "MATCH_NOT_FOUND", "对局不存在或已过期", { match_id: matchId, path: `/api/v1/matches/${matchId}/replay/step`, hint: this.matchNotFoundHint(matchId) });
    const game = this.games.get(rm.gameId);
    if (!game) return this.err(res, 500, "GAME_NOT_FOUND", "游戏模块未注册（服务端配置错误）");
    const all = rm.match.rawEvents();
    // r9：旧版状态文件恢复的对局壳无事件（r9 起落盘全量事件，此后不再出现）——
    // 空事件喂给 replayToState 会 throw 变 500，显式降级为 410
    if (all.length === 0) {
      return this.err(res, 410, "REPLAY_UNAVAILABLE", "该对局的回放数据不可用（旧版状态文件恢复时未持久化事件）；事件列表仍可读 /replay", { match_id: matchId, path: `/api/v1/matches/${matchId}/replay/step` });
    }
    const toParam = url.searchParams.get("to");
    let upto = toParam === null || toParam === "" ? all.length - 1 : Number(toParam);
    if (!Number.isFinite(upto)) upto = all.length - 1;
    upto = Math.max(0, Math.min(Math.floor(upto), all.length - 1));
    const seatParam = Number(url.searchParams.get("seat"));
    let viewer: SeatId | "spectator" = "spectator";
    if (Number.isInteger(seatParam) && seatParam >= 1) {
      // 视角鉴权双链（r8 P0 + r15/r13 P1）：?seat=N 仅允许该席位本人——
      // ①活局 x-seat-token（实测：无 token 曾直接返回任意席位 private）
      // ②恢复壳/历史对局：Bearer api_key + seatAgents 归属（旧 seat_token 重启即失效）
      // 观战请省略 seat 参数
      const idn = this.resolveSeatIdentity(rm, req, url);
      if (idn.seat !== seatParam) {
        return this.err(res, 403, "SEAT_INVALID", "回放视角鉴权失败：?seat=N 仅限该席位本人（x-seat-token 或 Bearer api_key 归属）；观战请省略 seat 参数", { match_id: matchId });
      }
      viewer = seatParam;
    }
    const { state, terminal } = replayToState(game, all, upto);
    const visible = all.filter(
      (e) =>
        e.seq <= upto &&
        (e.visibility === "all" ||
          (typeof e.visibility === "object" && e.visibility.seats.includes(viewer as number))),
    );
    // 相位提交进度重建（r7）：自最近一次 phase_started / vote_pk 锚点起，
    // 已 acted/timed_out 的座位即该窗口的提交进度——回放视图与实况 votes_cast 语义一致
    let anchor = -1;
    for (const e of all) {
      if (e.seq > upto) break;
      if (e.type === "phase_started" || e.type === "vote_pk") anchor = e.seq;
    }
    const submittedSeats = all
      .filter((e) => e.seq > anchor && e.seq <= upto && (e.type === "acted" || e.type === "timed_out"))
      .map((e) => e.data.seat as number)
      .filter((s) => Number.isInteger(s));
    // 终局时刻的回放视图同样携带 result 便捷出口（r9：回放消费者无需再调 /replay 换比分；
    // 持久化恢复壳经真实游戏模块重放，此处比分亦是对落盘数据的确定性交叉验证）
    const finalScores = terminal ? game.scores(state) : null;
    // r30：补 placements——与 view.result / /replay 三处形态统一（此前只有它能拿到名次）
    const seatList = (all.find((e) => e.type === "match_started")?.data.seats as SeatId[] | undefined) ?? [];
    const view = composeAgentView({
      game,
      state,
      matchId,
      viewer,
      visible,
      finished: terminal,
      deadlineMs: null,
      submittedSeats,
      result: finalScores
        ? {
            scores: finalScores,
            winners: winnersOf(finalScores),
            placements: placementsOf(game, state, seatList, finalScores),
          }
        : null,
    });
    return this.json(res, 200, { view, upto, total_events: all.length, events: visible.slice(-120) });
  }

  private async matchOp(
    matchId: string,
    op: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rm = this.matches.get(matchId);
    if (!rm) return this.err(res, 404, "MATCH_NOT_FOUND", "对局不存在或已过期", { match_id: matchId, path: `/api/v1/matches/${matchId}/${op}`, hint: this.matchNotFoundHint(matchId) });
    // r21：观众竞猜是纯观战旁路——不需要席位身份（也不接受 seat_token 语义），先于身份解析处理
    if (op === "guess") return this.guessOp(matchId, rm, method, url, req, res);
    // r15：viewer 解析走双链——x-seat-token（活局）→ Bearer api_key 归属（恢复壳）→ 观战。
    // 恢复壳的私有事件（夜间刀口/查验）经 Bearer 归属对当事人恢复可见（r13 P1）。
    const token = req.headers["x-seat-token"];
    const idn = this.resolveSeatIdentity(rm, req, url);
    const seat = idn.seat;
    // seat_token 显式携带但不匹配（且 Bearer 归属也不成立）时不静默降级为观战——agent 不易察觉配置错误
    if (typeof token === "string" && token.length > 0 && seat === undefined && op !== "replay") {
      return this.err(res, 401, "SEAT_TOKEN_INVALID", "seat_token 不匹配该对局的任何席位", { match_id: matchId });
    }
    const viewer: SeatId | "spectator" = seat ?? "spectator";

    if (op === "view" && method === "GET") {
      const v = rm.match.viewFor(viewer);
      // ?slim=1：省略 history——高频轮询省流量（r6 实测全量 view 最重 41KB；完整历史走 /events?since= 增量）
      if (url.searchParams.get("slim") === "1") {
        return this.json(res, 200, { ...v, history: [], history_truncated: true });
      }
      return this.json(res, 200, v);
    }
    if (op === "actions" && method === "POST") {
      if (seat === undefined) return this.err(res, 403, "SEAT_INVALID", "观战视角不可提交动作（请求缺少 x-seat-token）");
      const driver = rm.httpDrivers.get(seat);
      if (!driver) {
        return this.err(res, 403, "SEAT_INVALID", "该席位走 Webhook 通道，不经此端点出招");
      }
      // 未轮到的席位立即拒绝（保留即时反馈）；相位间隙（active=true 但 step 未开）
      // 交给驱动缓冲——新回合开启时自动入账，消除轮询型 Agent 的 NOT_YOUR_TURN 窗口
      if (rm.match.isFinished()) {
        return this.err(res, 422, "MATCH_FINISHED", "对局已结束，不再接受动作", { ok: false, legal_actions: [] });
      }
      const body0 = await readJson(req);
      const nonce0 = typeof body0.nonce === "string" ? body0.nonce.slice(0, 64) : undefined;
      // reasoning >500 字将被截断入账（r8 w8-s2：静默丢数据不可接受）——200 响应显式回显
      const reasonTruncated = typeof body0.reasoning === "string" && body0.reasoning.length > 500;
      // nonce 重放：同 (对局, 席位, nonce) 已成功过 → 直接幂等成功（快照早已入账，绝不消耗新回合）
      const replayKey = nonce0 ? `${matchId}:${seat}:${nonce0}` : null;
      if (replayKey && this.nonceReplay.has(replayKey)) {
        await new Promise((r) => setImmediate(r)); // 若原动作正在结算，等一拍取结算后视图
        const full = rm.match.viewFor(seat);
        // r9 dc9-d1/dc9-h1 三方共识：跨回合重发同 nonce 曾回 applied:true——
        // 语义陷阱：本次请求未发生任何新入账（原动作可能在若干回合前已结算），
        // 客户端若以 applied 判"本回合已提交"会被误导（实测：真入账丢失 + 无声跳过新回合）。
        // 修正：replayed 响应 applied:false；入账自检 = ok && applied && !replayed（见 docs §3.1）
        // r13 修复（P2）：补机器可读 code=REPLAYED——实测（h13-a 9 次 / h13-b 22 回合 / h13-d 60 次）
        // 客户端无法程序化区分「重放命中 / 非你的回合 / 非法动作」三态，只能盲重试。
        return this.json(res, 200, {
          ok: true,
          code: "REPLAYED",
          replayed: true,
          applied: false,
          ...(reasonTruncated ? { reasoning_truncated: true } : {}),
          view: { ...full, history: [], history_truncated: true },
        });
      }
      const probe = rm.match.viewFor(seat);
      if (probe.you.submitted) {
        return this.err(res, 422, "DUPLICATE_ACTION", "本回合已接受你的动作，请等待结算（幂等重试请带同一 nonce）", {
          ok: false,
          legal_actions: probe.legal_actions,
        });
      }
      if (!probe.you.active) {
        return this.err(res, 422, "NOT_YOUR_TURN", "当前不轮到该席位行动", {
          ok: false,
          legal_actions: probe.legal_actions,
        });
      }
      const body = body0;
      const action = (body.action ?? body) as Action;
      const opts: SubmitOptions = {};
      if (typeof body.reasoning === "string") opts.reasoning = body.reasoning.slice(0, 500);
      if (typeof body.nonce === "string") opts.nonce = body.nonce.slice(0, 64);
      // r30c 决策令牌：客户端把视图里的 turn 原样回传即启用陈旧提交保护（不传则跳过校验）
      if (typeof body.turn === "number" && Number.isInteger(body.turn)) opts.turn = body.turn;
      const r = await driver.handleAction(action, opts);
      if (r.ok) {
        if (replayKey) {
          this.nonceReplay.set(replayKey, true);
          if (this.nonceReplay.size > 2000) this.nonceReplay.clear(); // 粗粒度防膨胀
        }
        // 提交成功 ≠ 已结算：等一拍让本回合 apply 跑完，回带结算后的视图。
        // 视图为 slim（无 history）——r6 六方反馈：actions 响应最重 41KB，历史应走 /events?since= 增量
        await new Promise((r2) => setImmediate(r2));
        const full = rm.match.viewFor(seat);
        return this.json(res, 200, {
          ok: true,
          applied: true,
          // r8 w8-s2：reasoning 超 500 字静默截断——显式回显，杜绝无声丢数据
          ...(reasonTruncated ? { reasoning_truncated: true } : {}),
          view: { ...full, history: [], history_truncated: true },
        });
      }
      // 错误码直接从错误文本头部取：内核约定错误以 `CODE` 或 `CODE：说明` 开头。
      // r30c 之前是 8 项硬编码白名单 + UNKNOWN 兜底——每加一个码（如 STALE_VIEW）
      // 都会先退化成 UNKNOWN 让客户端无法分支，故改成结构识别，裸码与带说明都覆盖。
      const rawErr = String(r.error);
      const code = /^([A-Z][A-Z0-9_]{2,})(?=[：:]|$)/.exec(rawErr)?.[1] ?? "UNKNOWN";
      return this.err(res, 422, code, rawErr, { ok: false, legal_actions: r.legal_actions });
    }
    if (op === "events" && method === "GET") {
      // r15 修复（P1）：Number(null) === 0 陷阱——缺省 since 时曾解析为 0，
      // filter(seq > 0) 静默丢弃 seq=0 的 match_started，观战裸拉永远拿不到
      // 首事件（drivers/bot_filled 等元数据随之丢失）。显式 null → NaN → -1（全量）。
      // r29 修复（P2）：调用方按最直觉的 `?since=0` 拉全量时同样丢 seq=0——
      // 语义统一为「since <= 0 即从头」，正数才是「严格大于该 seq 的增量」。
      const sinceRaw = url.searchParams.get("since");
      const sinceParam = sinceRaw === null ? NaN : Number(sinceRaw);
      const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : -1;
      const all = rm.match.eventsFor(viewer);
      const latestSeq = all.length > 0 ? all[all.length - 1]!.seq : -1;
      return this.json(res, 200, {
        events: rm.match.eventsFor(viewer, since),
        // next-since 游标：下次请求 ?since=latest_seq 即为增量（r6 两方反馈）
        latest_seq: latestSeq,
        // 赛中 acted.reasoning 脱敏、终局后公开——finished 标记帮助调用方区分两种语义
        finished: rm.match.isFinished(),
      });
    }
    if (op === "replay" && method === "GET") {
      const r = rm.match.currentResult();
      // r13 修复（P2）：/replay 此前只有二元 scores，终局筹码/名次/结束原因要自己翻事件或到别处拼（h13-a / h13-d / h13-f / h13-i 四方各自提出）。现把 result / reason / final_chips /
      // standings / bot_filled 一并给出——复盘端点自足，与 view.result 形态对齐。
      const all = rm.match.rawEvents();
      const gameEnded = [...all].reverse().find((e) => e.type === "game_ended");
      let finalChips: Record<string, number> | null = null;
      try {
        const game = this.games.get(rm.gameId);
        if (game && all.length > 0) {
          const { state } = replayToState(game, all, all.length - 1);
          const players = (game.viewOf(state, "spectator").public as { players?: { seat: number; chips?: number }[] }).players;
          if (Array.isArray(players) && players.some((p) => typeof p.chips === "number")) {
            finalChips = Object.fromEntries(players.map((p) => [String(p.seat), p.chips ?? 0]));
          }
        }
      } catch {
        finalChips = null; // 回放不可用时静默降级：事件列表与 scores 仍可用
      }
      const standings = finalChips
        ? Object.entries(finalChips).sort((a, b) => b[1] - a[1]).map(([seat, chips], i) => ({ seat: Number(seat), chips, rank: i + 1 }))
        : null;
      const botFilled = [...rm.seatAgents.entries()].filter(([, a]) => a.startsWith("house:")).map(([s]) => s);
      return this.json(res, 200, {
        match_id: matchId,
        finished: rm.match.isFinished(),
        // r15：中止壳标记（进程退出时仍在飞——无终局比分，事件回放到落盘时刻为止）
        aborted: rm.aborted === true,
        // r13：与 view.result 同构（此前 replay 无 result 字段，客户端要写两套解析）
        result: r ? {
          scores: r.scores,
          // r30 修复：原为「所有得分>0 的席位」，与 view.result 的「最高分席位」口径不同——
          // 囚徒平局时 view.winners=[] 而 replay.winners=[1,2]，同一局两个端点互相打脸。
          winners: winnersOf(r.scores),
          // r29：终局全序名次（与 view.result 形态对齐）
          placements: r.placements ?? [],
        } : null,
        scores: r?.scores ?? null,
        ratings: rm.ratings,
        // 席位 → 显示名映射（r6 ot-h1 反馈：只有 agent_id 对人不友好）
        seat_names: Object.fromEntries([...rm.seatAgents.entries()].map(([s, a]) => [String(s), this.nameOf(a)])),
        reason: (gameEnded?.data.reason as string | undefined) ?? null,
        hands_played: (gameEnded?.data.hands_played as number | undefined) ?? null,
        final_chips: finalChips,
        standings,
        // r13：明示哪些席位由 house bot 补位——主桌实际只有 4 名真人却被当成 6 人真人桌
        bot_filled: botFilled,
        human_seats: [...rm.seatAgents.entries()].filter(([, a]) => !a.startsWith("house:")).map(([s]) => s),
        events: rm.match.eventsFor(viewer),
      });
    }
    return this.err(res, 405, "METHOD_NOT_ALLOWED", `不支持的方法（${method}）`, { method });
  }

  /**
   * r21 观众竞猜端点：POST /matches/:id/guess {seat, voter_id}（匿名投票，重复=改票）
   *                GET  /matches/:id/guess?voter_id=（进行中 counts / 终局 reveal）
   * 语义（liars.town 式 crowd suspicion 的移植）：
   *  - 纯观战娱乐层：不属于 Agent 协议、不进事件流、不进回放、不持久化（重启即弃）
   *  - werewolf_lite → 猜狼（reveal 从 game_won.data.roles 过滤）；其他游戏 → 猜胜者（result.scores>0）
   *  - 信息隔离铁律：进行中只回 {locked:false, counts, total, mine, label}——绝不含目标席位；
   *    票数本身是观众自己投的（无信息特权），不构成泄露
   *  - 终局锁定：POST → 409 GUESS_LOCKED；GET → reveal（targets + mine_hit + crowd_pick/crowd_hit）
   */
  private async guessOp(
    matchId: string,
    rm: RunningMatch,
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const validSeats = [...rm.seatAgents.keys()].sort((a, b) => a - b);
    const finished = rm.match.isFinished();
    if (method === "POST") {
      if (finished) {
        return this.err(res, 409, "GUESS_LOCKED", "对局已结束，竞猜已锁定（GET 查看揭底）", { match_id: matchId, locked: true });
      }
      const body = await readJson(req);
      // r29 P2：带有效 Bearer 时以 agent 身份为准，防止客户端自报 voter_id 冒用他人票权
      const voter = this.guessVoterOf(req, url, typeof body.voter_id === "string" ? body.voter_id : "");
      const seat = Number(body.seat);
      if (!voter) {
        return this.err(res, 422, "VOTER_REQUIRED", "缺 voter_id（匿名观战者标识：任意稳定字符串，前端建议 localStorage UUID）", { ok: false });
      }
      // r30：匿名票权的最小防刷——过短标识既易碰撞也易被批量伪造（单字符遍历即可顶票）
      if (voter.length < 6) {
        return this.err(res, 422, "VOTER_REQUIRED", "voter_id 至少 6 个字符（须为稳定标识；前端请用 localStorage 持久化的 UUID）", { ok: false, voter_min_length: 6 });
      }
      if (!Number.isInteger(seat) || !validSeats.includes(seat)) {
        return this.err(res, 422, "SEAT_INVALID", `席位无效（有效席位：${validSeats.join("、")}）`, { ok: false, valid_seats: validSeats });
      }
      let g = this.guesses.get(matchId);
      if (!g) {
        g = { votes: new Map(), voters: new Map() };
        this.guesses.set(matchId, g);
      }
      // r30：单局竞猜人数上限——匿名票池是纯内存态且随对局保留，无上限时一个脚本即可把
      // Map 撑到百万级（票数统计也随之 O(n)）。改票不受限，只拦新观众。
      if (!g.voters.has(voter) && g.voters.size >= MAX_GUESS_VOTERS) {
        return this.err(res, 429, "RATE_LIMITED", `本局竞猜人数已达上限（${MAX_GUESS_VOTERS}），不再接受新观众投票`, { ok: false });
      }
      const old = g.voters.get(voter);
      if (old === seat) {
        return this.json(res, 200, { ok: true, seat, changed: false, ...this.guessCounts(g, voter) });
      }
      if (old !== undefined) {
        const n = (g.votes.get(old) ?? 1) - 1;
        if (n <= 0) g.votes.delete(old);
        else g.votes.set(old, n);
      }
      g.voters.set(voter, seat);
      g.votes.set(seat, (g.votes.get(seat) ?? 0) + 1);
      return this.json(res, 200, { ok: true, seat, changed: old !== undefined, ...this.guessCounts(g, voter) });
    }
    if (method === "GET") {
      const voter = this.guessVoterOf(req, url);
      const g = this.guesses.get(matchId);
      const base = this.guessCounts(g, voter);
      if (!finished) {
        return this.json(res, 200, { locked: false, ...base, label: this.guessTargetLabel(rm.gameId) });
      }
      const targets = this.guessTargets(rm);
      const mine = base.mine;
      const mineHit = mine !== null && targets.includes(mine);
      // crowd_pick：票数最高席位（并列全列）；crowd_hit：群众头名票与目标有交集
      const entries = Object.entries(base.counts).map(([s, n]) => ({ seat: Number(s), n }));
      const topN = entries.length > 0 ? Math.max(...entries.map((e) => e.n)) : 0;
      const crowdPick = topN > 0 ? entries.filter((e) => e.n === topN).map((e) => e.seat).sort((a, b) => a - b) : [];
      const crowdHit = crowdPick.length > 0 && crowdPick.some((s) => targets.includes(s));
      return this.json(res, 200, {
        locked: true,
        ...base,
        label: this.guessTargetLabel(rm.gameId),
        targets,
        mine_hit: mineHit,
        crowd_pick: crowdPick,
        crowd_pick_votes: topN,
        crowd_hit: crowdHit,
        total_voters: g ? g.voters.size : 0,
      });
    }
    return this.err(res, 405, "METHOD_NOT_ALLOWED", `不支持的方法（${method}）`, { method });
  }

  /**
   * 竞猜者标识（r29 P2）：带有效 Bearer 时以 agent 身份为准（`agent:<id>`），
   * 否则退化为客户端自报的匿名串。匿名观战仍可用，但无法冒用他人票权。
   */
  private guessVoterOf(req: IncomingMessage, url: URL, bodyVoter?: string): string {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (auth) {
      const known = this.agents.get(auth);
      if (known) return `agent:${known.agent_id}`;
    }
    return (bodyVoter ?? url.searchParams.get("voter_id") ?? "").trim().slice(0, 64);
  }

  /** 票数快照（进行中/终局共用）——counts 键为席位号字符串，mine 为本人当前票 */
  private guessCounts(g: GuessState | undefined, voter: string): { counts: Record<string, number>; total: number; mine: number | null } {
    const counts: Record<string, number> = {};
    let total = 0;
    if (g) {
      for (const [s, n] of g.votes) {
        counts[String(s)] = n;
        total += n;
      }
    }
    return { counts, total, mine: voter && g ? (g.voters.get(voter) ?? null) : null };
  }

  /** 竞猜目标席位：werewolf_lite → 真狼 / undercover → 卧底（game_won.roles 过滤；恢复壳经 rawEvents 透传同样可取）；其他游戏 → 胜者 */
  private guessTargets(rm: RunningMatch): SeatId[] {
    if (rm.gameId === "werewolf_lite" || rm.gameId === "undercover") {
      const want = rm.gameId === "werewolf_lite" ? "werewolf" : "undercover";
      const ev = [...rm.match.rawEvents()].reverse().find((e) => e.type === "game_won");
      const roles = (ev?.data?.roles ?? null) as Record<string, string> | null;
      if (roles && typeof roles === "object") {
        return Object.entries(roles)
          .filter(([, r]) => r === want)
          .map(([s]) => Number(s))
          .sort((a, b) => a - b);
      }
      return [];
    }
    const r = rm.result ?? rm.match.currentResult();
    return r
      ? Object.entries(r.scores).filter(([, v]) => v > 0).map(([k]) => Number(k)).sort((a, b) => a - b)
      : [];
  }

  /** 目标语义标签（非机密——仅告知观众「这局猜什么」） */
  private guessTargetLabel(gameId: string): string {
    return gameId === "werewolf_lite" ? "狼" : gameId === "undercover" ? "卧底" : "胜者";
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  /** r15：MATCH_NOT_FOUND 三态 hint——①曾持久化但被 100 场滚动窗口挤出 ②从未存在。
   *  此前统一"对局不存在或已过期"，无法区分（r13 P0 实测痛点）。 */
  private matchNotFoundHint(matchId: string): string {
    return this.knownMatchIds.has(matchId)
      ? "该对局曾存在，但已超出滚动保留窗口（最近 100 场）被清理；选手战绩仍可查 /agents/:id/matches"
      : "match_id 从未存在（或拼写有误）；房间对局的 match_id 从 GET /api/v1/lobby/rooms/:id?token= 换取";
  }

  /** r15（r13 P1）：席位身份解析双链——
   *  ① 活局 x-seat-token（内存 seatTokens 映射）
   *  ② Bearer api_key + seatAgents 归属（seatAgents 随对局落盘，恢复壳 seatTokens 恒空，
   *    旧 seat_token 一律 403、私有事件对当事人不可见——本链恢复身份级鉴权）。
   *  显式 ?seat=N 须与归属匹配；未指定时取归属的最小席位。均不成立 → 无席位身份（观战）。 */
  private resolveSeatIdentity(
    rm: RunningMatch,
    req: IncomingMessage,
    url?: URL,
  ): { seat?: SeatId; via: "token" | "bearer" | "none" } {
    const token = req.headers["x-seat-token"];
    if (typeof token === "string" && token.length > 0) {
      const seat = rm.seatTokens.get(token);
      if (seat !== undefined) return { seat, via: "token" };
    }
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const agent = this.agents.get(auth.slice(7).trim());
      if (agent) {
        const seatParam = url ? Number(url.searchParams.get("seat")) : NaN;
        if (Number.isInteger(seatParam) && seatParam >= 1) {
          if (rm.seatAgents.get(seatParam) === agent.agent_id) return { seat: seatParam, via: "bearer" };
        } else {
          const owned = [...rm.seatAgents.entries()]
            .filter(([, a]) => a === agent.agent_id)
            .map(([s]) => s)
            .sort((a, b) => a - b);
          if (owned.length > 0) return { seat: owned[0], via: "bearer" };
        }
      }
    }
    return { via: "none" };
  }

  /**
   * 统一错误体（r7 dc7-d1：错误响应形状不一——401 裸中文、403/404 缺 code、部分 404 无 hint）。
   * 约定：code=机器可读稳定码；error=code 的别名（兼容旧客户端按 error 判断的用法）；
   * message=人读文本（可中文）；422 额外带 ok:false + legal_actions；404 额外带 path + hint。
   */
  private err(
    res: ServerResponse,
    status: number,
    code: string,
    message?: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.json(res, status, { error: code, code, message: message ?? code, ...extra });
  }

  /** r10 w10-s1：端点局部 catch 统一分流——readJson 的 INVALID_JSON 转为 400（原被吞成 500 INTERNAL） */
  private failErr(res: ServerResponse, e: unknown): void {
    const badJson = String((e as Error)?.message ?? "").includes("INVALID_JSON");
    this.err(res, badJson ? 400 : 500, badJson ? "INVALID_JSON" : "INTERNAL",
      badJson ? "请求 body 不是合法 JSON" : `服务端内部错误：${String(e)}`);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.floor(n) : lo));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 从持久化恢复的对局壳（无游戏状态，仅提供 id / isFinished / 持久化事件回放 / 终局比分）。
 *  r9 自查修复：此前 isFinished() 继承自 Match 私有字段（仅 run()/fail() 置 true），恢复壳从不 run
 *  → 恒报 false，且 persistState 的 isFinished 过滤把恢复壳排除在下次落盘外——历史每重启丢一代。
 *  现恒报 finished=true 并透传落盘时的全量事件与比分；旧状态文件无 events 时为空回放壳。
 *  r15：aborted=true 为「中止壳」——落盘时对局仍在飞（30s 滚动快照或 SIGTERM 兜底），以中止态恢复，
 *  无终局比分但事件回放可用；进程存活期间打完的局会在下次落盘覆盖为正常终局记录。
 *  安全：seatTokens 恒为空 → replay/step?seat=N 的 x-seat-token 链恒 403（r8 P0 的安全默认不受影响），
 *  r15 起另有 Bearer api_key + seatAgents 归属链（见 resolveSeatIdentity）。 */
class RestoredMatch extends Match {
  private readonly restoredEvents: readonly MatchEvent[];
  private readonly restoredScores: Record<SeatId, number> | null;

  constructor(
    id: string,
    persisted?: { events?: MatchEvent[]; scores?: Record<string, number> | null; aborted?: boolean },
  ) {
    super({
      id,
      game: {
        meta: { id: "restored", name: "已恢复对局", minSeats: 0, maxSeats: 0, defaultTimeoutMs: 0 },
        init: () => ({}),
        phase: () => "finished",
        round: () => 0,
        activeSeats: () => [],
        legalActions: () => [],
        validate: () => ({ ok: false, error: "MATCH_FINISHED" }),
        apply: (s) => ({ state: s, events: [] }),
        viewOf: () => ({
          public: {
            note: persisted?.aborted
              ? "此对局在进程退出时仍在进行，已以中止态恢复（无终局比分）；事件回放请读 /replay"
              : "此对局从持久化恢复，无实时状态；事件请读 /replay",
            aborted: persisted?.aborted === true,
          },
          private: {},
        }),
        timeoutAction: () => ({ type: "pass" }),
        isTerminal: () => true,
        scores: () => ({}),
      },
      drivers: new Map(),
    });
    this.restoredEvents = persisted?.events ?? [];
    const scores = persisted?.scores ?? null;
    this.restoredScores =
      scores && typeof scores === "object" && Object.keys(scores).length > 0
        ? Object.fromEntries(Object.entries(scores).map(([k, v]) => [Number(k), v as number]))
        : null;
  }

  /** 恒为已结束（这些记录只可能来自 persistState 的 isFinished 过滤） */
  override isFinished(): boolean {
    return true;
  }

  /** 透传持久化事件：再落盘时不丢（persistState 经 rawEvents 取数） */
  override rawEvents(): readonly MatchEvent[] {
    return this.restoredEvents;
  }

  /** 可见性过滤与 EventStore.visibleTo 同语义；finished=true → reasoning 终局公开（不脱敏） */
  override eventsFor(viewer: SeatId | "spectator", since = -1): MatchEvent[] {
    return this.restoredEvents.filter((e) => {
      if (e.seq <= since) return false;
      if (e.visibility === "all") return true;
      if (viewer === "spectator") return false;
      return e.visibility.seats.includes(viewer);
    });
  }

  override currentResult(): MatchResult | null {
    if (!this.restoredScores) return null;
    return {
      matchId: this.id,
      scores: this.restoredScores,
      // r30c：此前返回空数组「不臆造」。但空数组与「无此对局/未终局」无法区分，客户端读 result.placements
      // 会以为名次缺失。现用终局比分按统一兜底口径推算（同分并列），note 明示来源——
      // 比分是落盘的真实数据，不是臆造；缺的只是"身份/筹码"这类需要 state 才能给出的细化名次，
      // 那部分仍请走 /replay/step（重建 state 后由游戏自实现的 placements 给出）。
      placements: placementsFromScores(this.restoredScores, "由终局比分推算（恢复壳无运行态）"),
      events: this.restoredEvents,
      gameEvents: [],
    };
  }
}
