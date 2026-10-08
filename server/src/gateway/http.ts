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
import type { Action, AgentView, SeatId, SubmitResult } from "../protocol.ts";
import type { GameModule } from "../games/types.ts";
import { Match, composeAgentView } from "../arena/match.ts";
import type { MatchResult, SeatDriver } from "../arena/match.ts";
import { createMatch } from "../arena/lobby.ts";
import { replayToState } from "../arena/replay.ts";
import { RatingStore } from "../arena/rating.ts";
import type { RatingDelta } from "../arena/rating.ts";
import { houseBotsFor } from "../bots/registry.ts";
import { WebhookSeatDriver } from "./webhook.ts";
import { randomId, withTimeout } from "../util.ts";

/** HTTP Pull 座位驱动：act() 挂起等待，直到 Agent 经 POST /actions 提交（或超时兜底）。
 *  相位切换间隙（上一回合已结算、新回合 step 尚未开启）收到的提交先落地缓冲，
 *  新回合开启时立即入账——消除轮询型 Agent 的 NOT_YOUR_TURN 窗口 */
class HttpSeatDriver implements SeatDriver {
  readonly name: string;
  private pending: {
    submit: (a: Action, opts?: { reasoning?: string; nonce?: string }) => SubmitResult;
    resolve: () => void;
  } | null = null;
  private early: {
    action: Action;
    opts?: { reasoning?: string; nonce?: string };
    resolve: (r: SubmitResult) => void;
  } | null = null;

  constructor(name: string) {
    this.name = name;
  }

  act(_view: AgentView, submit: (a: Action, opts?: { reasoning?: string; nonce?: string }) => SubmitResult): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.early) {
        const e = this.early;
        this.early = null;
        const r = submit(e.action, e.opts);
        e.resolve(r);
        if (r.ok) resolve();
        else this.pending = { submit, resolve }; // 提交失败：结果已还给 POST 等待者，继续等待修正后的动作
        return;
      }
      this.pending = { submit, resolve };
    });
  }

  handleAction(action: Action, opts?: { reasoning?: string; nonce?: string }): Promise<SubmitResult> {
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
      this.early = { action, opts, resolve };
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
  result: MatchResult | null;
  ratings: RatingDelta[] | null;
  headline: string | null;
}

/** 多人房间：真人选手按加入顺序定座，满员自动开局（房主可强制开局并 bot 补位） */
interface RoomPlayer {
  joinToken: string;
  name: string;
  agentId: string;
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
  private agents = new Map<string, { agent_id: string; name: string; callback_url?: string; webhook_secret?: string }>();
  private matches = new Map<string, RunningMatch>();
  private rooms = new Map<string, Room>();
  private ratings = new RatingStore();
  private agentNames = new Map<string, string>();
  /** nonce 重放缓存：key = matchId:seat:nonce —— 跨回合重试返回原成功，不消耗任何回合（真幂等） */
  private nonceReplay = new Map<string, true>();
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
        const badJson = String((e as Error)?.message ?? "").includes("INVALID_JSON");
        this.json(res, badJson ? 400 : 500, {
          error: badJson ? "INVALID_JSON" : "INTERNAL",
          message: String(e),
        });
      });
    });
    server.listen(port, onReady);
    // 定期持久化（30s）
    this.persistTimer = setInterval(() => {
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

  /** 持久化到 JSON 文件（ratings + agents + 已结束对局元数据） */
  async persistState(): Promise<void> {
    const finishedMatches = [...this.matches.values()]
      .filter((rm) => rm.match.isFinished())
      .slice(-100) // 最多保留 100 场
      .map((rm) => ({
        match_id: rm.match.id,
        game: rm.gameId,
        started_at: rm.startedAt,
        headline: rm.headline,
        seats: Object.fromEntries([...rm.seatAgents.entries()].map(([s, a]) => [String(s), a])),
      }));
    const data = {
      saved_at: new Date().toISOString(),
      ratings: this.ratings.export(),
      agents: Object.fromEntries([...this.agents.entries()].map(([k, v]) => [k, v])),
      agentNames: Object.fromEntries([...this.agentNames.entries()]),
      matches: finishedMatches,
    };
    const dir = dirname(this.dataFile);
    await mkdir(dir, { recursive: true });
    await writeFile(this.dataFile, JSON.stringify(data), "utf8");
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
        agents?: Record<string, { agent_id: string; name: string; callback_url?: string; webhook_secret?: string }>;
        agentNames?: Record<string, string>;
        matches?: { match_id: string; game: string; started_at: number; headline: string | null; seats: Record<string, string> }[];
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
      // 恢复历史对局元数据（无 events，仅列表展示；排行榜已由 ratings 覆盖）
      if (data.matches) {
        for (const m of data.matches) {
          if (!this.matches.has(m.match_id)) {
            const seatAgents = new Map<SeatId, string>();
            for (const [s, a] of Object.entries(m.seats)) {
              seatAgents.set(Number(s), a);
            }
            this.matches.set(m.match_id, {
              match: new RestoredMatch(m.match_id),
              gameId: m.game,
              startedAt: m.started_at,
              seatTokens: new Map(),
              httpDrivers: new Map(),
              seatAgents,
              result: null,
              ratings: null,
              headline: m.headline,
            });
          }
        }
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
          "GET  /api/v1/games",
          "POST /api/v1/lobby/quickstart",
          "GET  /api/v1/lobby/rooms               多人房间列表",
          "POST /api/v1/lobby/rooms               创建房间 {game, seats?, name?}",
          "POST /api/v1/lobby/rooms/:id/join      加入房间 {name?}",
          "POST /api/v1/lobby/rooms/:id/start     房主强制开局（余位 bot 补位）{join_token}",
          "GET  /api/v1/lobby/rooms/:id?token=    房间状态（带 join_token 获取座位分配）",
          "GET  /api/v1/matches/:id/view",
          "POST /api/v1/matches/:id/actions",
          "GET  /api/v1/matches/:id/events?since=",
          "GET  /api/v1/matches/:id/replay",
          "GET  /api/v1/leaderboard/:game",
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/agents") {
      const body = await readJson(req);
      const name = String(body.name ?? "agent-" + randomId(""));
      const apiKey = "sk_" + randomId("");
      const callbackUrl = typeof body.callback_url === "string" ? body.callback_url : undefined;
      const webhookSecret = callbackUrl ? "whsec_" + randomId("") : undefined;
      const agentId = "a_" + randomId("");
      this.agents.set(apiKey, {
        agent_id: agentId,
        name,
        callback_url: callbackUrl,
        webhook_secret: webhookSecret,
      });
      return this.json(res, 201, {
        agent_id: agentId,
        api_key: apiKey,
        name,
        callback_url: callbackUrl ?? null,
        webhook_secret: webhookSecret ?? null,
      });
    }
    if (method === "POST" && path === "/api/v1/webhook/test") {
      return this.webhookTest(req, res);
    }
    if (method === "GET" && path === "/api/v1/matches") {
      const list = [...this.matches.values()]
        .map((rm) => ({
          match_id: rm.match.id,
          game: rm.gameId,
          finished: rm.match.isFinished(),
          started_at: rm.startedAt,
          headline: rm.headline,
          seats: [...rm.seatAgents.keys()].sort((a, b) => a - b).map((s) => this.nameOf(rm.seatAgents.get(s)!)),
        }))
        .slice(-20)
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
      return this.replayStep(step[1], url, res);
    }
    const stream = /^\/api\/v1\/matches\/([^/]+)\/stream$/.exec(path);
    if (method === "GET" && stream) {
      return this.sseStream(stream[1], req, res);
    }
    const m = /^\/api\/v1\/matches\/([^/]+)\/(view|actions|events|replay)$/.exec(path);
    if (m) return this.matchOp(m[1], m[2], method, url, req, res);
    return this.json(res, 404, {
      error: "NOT_FOUND",
      path,
      hint: "对局子路径仅支持 view|actions|events|replay（另有 /stream 与 /replay/step）",
    });
  }

  private quickstart(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse): void {
    const gameId = String(body.game ?? "liars_dice");
    const game = this.games.get(gameId);
    if (!game) return this.json(res, 404, { error: "GAME_NOT_FOUND", game: gameId });
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

  /** 对局终局记账（headline + Elo），quickstart 与房间开局共用 */
  private runMatchBookkeeping(rm: RunningMatch): void {
    rm.match
      .run()
      .then((r) => {
        rm.result = r;
        rm.headline = this.makeHeadline(rm.gameId, r);
        if (!r.events.some((e) => e.type === "match_failed")) {
          rm.ratings = this.ratings.applyMatch(rm.gameId, rm.seatAgents, r.scores);
        }
      })
      .catch((e) => console.error("[match error]", rm.match.id, e));
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

  /** 创建多人房间（创建者即 1 号候选人；满员自动开局） */
  private roomCreate(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      const gameId = String(body.game ?? "");
      const game = this.games.get(gameId);
      if (!game) return this.json(res, 404, { error: "GAME_NOT_FOUND", game: gameId });
      const seats = clamp(Number(body.seats ?? game.meta.minSeats), game.meta.minSeats, game.meta.maxSeats);
      const timeoutMsRaw = Number(body.timeout_ms);
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? clamp(timeoutMsRaw, 5_000, 300_000)
        : undefined;
      const name = String(body.name ?? "host-" + randomId(""));
      const me = this.identityOf(req, name);
      if (me.name === name && !body.name) this.agentNames.set(me.agentId, name);
      else this.agentNames.set(me.agentId, me.name);
      const joinToken = "jt_" + randomId("");
      const room: Room = {
        id: "r_" + randomId(""),
        game: gameId,
        seats,
        status: "waiting",
        players: [{ joinToken, name: me.name, agentId: me.agentId, seat: null, seatToken: null }],
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
        hint: "其他人 POST /lobby/rooms/" + room.id + "/join 加入；满员自动开局。轮询 GET 本房间（带 join_token）获取座位分配。",
      });
    })().catch((e) => this.json(res, 500, { error: "INTERNAL", message: String(e) }));
  }

  /** 加入房间（按加入顺序定座） */
  private roomJoin(roomId: string, req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const room = this.rooms.get(roomId);
      if (!room) return this.json(res, 404, { error: "ROOM_NOT_FOUND", room_id: roomId });
      if (room.players.length >= room.seats) return this.json(res, 409, { error: "ROOM_FULL：房间已满", room_id: roomId });
      if (room.status === "started") return this.json(res, 409, { error: "ROOM_STARTED：对局已开始", room_id: roomId });
      const body = await readJson(req);
      const name = String(body.name ?? "player-" + randomId(""));
      const me = this.identityOf(req, name);
      this.agentNames.set(me.agentId, me.name);
      const joinToken = "jt_" + randomId("");
      room.players.push({ joinToken, name: me.name, agentId: me.agentId, seat: null, seatToken: null });
      const started = this.tryStartRoom(room, false);
      return this.json(res, 200, {
        room_id: room.id,
        join_token: joinToken,
        player_index: room.players.length,
        seats: room.seats,
        players: room.players.length,
        status: started ? "started" : "waiting",
        hint: "轮询 GET /lobby/rooms/" + room.id + "?token=" + joinToken + " 直至 status=started，凭 seat_token 参赛。",
      });
    })().catch((e) => this.json(res, 500, { error: "INTERNAL", message: String(e) }));
  }

  /** 房主强制开局：余位由 house bot 补齐（至少 1 名真人） */
  private roomStart(roomId: string, req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const room = this.rooms.get(roomId);
      if (!room) return this.json(res, 404, { error: "ROOM_NOT_FOUND", room_id: roomId });
      const body = await readJson(req);
      if (String(body.join_token ?? "") !== room.creatorToken) {
        return this.json(res, 403, { error: "ROOM_FORBIDDEN：仅房主可强制开局" });
      }
      if (room.status === "started") return this.json(res, 409, { error: "ROOM_STARTED：对局已开始" });
      const ok = this.tryStartRoom(room, true);
      if (!ok) return this.json(res, 500, { error: "ROOM_START_FAILED" });
      const me = room.players[0]!;
      return this.json(res, 200, {
        room_id: room.id,
        status: "started",
        match_id: room.matchId,
        seat_id: me.seat,
        seat_token: me.seatToken,
        bots_filled: room.seats - room.players.length,
      });
    })().catch((e) => this.json(res, 500, { error: "INTERNAL", message: String(e) }));
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
    const humanDrivers = room.players.map((p) => new HttpSeatDriver(p.name));
    const drivers: SeatDriver[] = [...humanDrivers, ...house.map((h) => h.driver)];
    const match = createMatch({
      game,
      drivers,
      graceMs: 15000,
      minPhaseMs: room.game === "werewolf_lite" ? 4000 : 0,
      timeoutMs: room.timeoutMs,
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
    humanDrivers.forEach((d, i) => httpDrivers.set(i + 1, d));

    const rm: RunningMatch = {
      match,
      gameId: room.game,
      startedAt: Date.now(),
      seatTokens,
      httpDrivers,
      seatAgents,
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
    if (!room) return this.json(res, 404, { error: "ROOM_NOT_FOUND", room_id: roomId });
    if (room.status === "waiting") {
      return this.json(res, 200, {
        room_id: room.id,
        status: "waiting",
        game: room.game,
        seats: room.seats,
        players: room.players.length,
        names: room.players.map((p) => p.name),
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
      return this.json(res, 400, { error: "请先以 callback_url 注册（POST /agents），并携带 Authorization: Bearer <api_key>" });
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

  /** 战报标题：异常中断优先，狼人杀报阵营，其余报胜者席位 */
  private makeHeadline(gameId: string, r: MatchResult): string {
    if (r.events.some((e) => e.type === "match_failed")) return "异常中断";
    if (gameId === "werewolf_lite") {
      const won = r.events.find((e) => e.type === "game_won");
      const w = (won?.data as { winner?: string } | undefined)?.winner;
      return w === "good" ? "好人阵营胜" : w === "wolves" ? "狼人阵营胜" : "已结束";
    }
    let top: SeatId | null = null;
    let max = -1;
    let draw = true;
    for (const [seat, sc] of Object.entries(r.scores)) {
      const v = Number(sc);
      if (v > max) {
        max = v;
        top = Number(seat);
      }
      if (v !== 0.5) draw = false;
    }
    if (draw) return "平局";
    return top !== null ? `${top} 号位胜` : "已结束";
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
    const match = createMatch({ game, drivers: house.map((h) => h.driver) });
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
      return this.json(res, 404, { error: "MATCH_NOT_FOUND", match_id: matchId });
    }
    const token = req.headers["x-seat-token"];
    const seat = typeof token === "string" ? rm.seatTokens.get(token) : undefined;
    const viewer: SeatId | "spectator" = seat ?? "spectator";

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

  /** 回放步骤：重放到指定事件序号，返回该时刻任意视角的 AgentView（视角切换回放的服务端基础） */
  private replayStep(matchId: string, url: URL, res: ServerResponse): void {
    const rm = this.matches.get(matchId);
    if (!rm) return this.json(res, 404, { error: "MATCH_NOT_FOUND", match_id: matchId });
    const game = this.games.get(rm.gameId);
    if (!game) return this.json(res, 500, { error: "GAME_NOT_FOUND" });
    const all = rm.match.rawEvents();
    const toParam = url.searchParams.get("to");
    let upto = toParam === null || toParam === "" ? all.length - 1 : Number(toParam);
    if (!Number.isFinite(upto)) upto = all.length - 1;
    upto = Math.max(0, Math.min(Math.floor(upto), all.length - 1));
    const seatParam = Number(url.searchParams.get("seat"));
    const viewer: SeatId | "spectator" = Number.isInteger(seatParam) && seatParam >= 1 ? seatParam : "spectator";
    const { state, terminal } = replayToState(game, all, upto);
    const visible = all.filter(
      (e) =>
        e.seq <= upto &&
        (e.visibility === "all" ||
          (typeof e.visibility === "object" && e.visibility.seats.includes(viewer as number))),
    );
    const view = composeAgentView({
      game,
      state,
      matchId,
      viewer,
      visible,
      finished: terminal,
      deadlineMs: null,
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
    if (!rm) return this.json(res, 404, { error: "MATCH_NOT_FOUND", match_id: matchId });
    const token = req.headers["x-seat-token"];
    const seat = typeof token === "string" ? rm.seatTokens.get(token) : undefined;
    // seat_token 无效时不静默降级为观战——agent 不易察觉配置错误
    if (typeof token === "string" && token.length > 0 && seat === undefined && op !== "replay") {
      return this.json(res, 401, { error: "SEAT_TOKEN_INVALID：token 不匹配该对局的任何席位", match_id: matchId });
    }
    const viewer: SeatId | "spectator" = seat ?? "spectator";

    if (op === "view" && method === "GET") {
      return this.json(res, 200, rm.match.viewFor(viewer));
    }
    if (op === "actions" && method === "POST") {
      if (seat === undefined) return this.json(res, 403, { error: "SEAT_INVALID" });
      const driver = rm.httpDrivers.get(seat);
      if (!driver) {
        return this.json(res, 403, { error: "SEAT_INVALID：该席位走 Webhook 通道，不经此端点出招" });
      }
      // 未轮到的席位立即拒绝（保留即时反馈）；相位间隙（active=true 但 step 未开）
      // 交给驱动缓冲——新回合开启时自动入账，消除轮询型 Agent 的 NOT_YOUR_TURN 窗口
      if (rm.match.isFinished()) {
        return this.json(res, 422, { ok: false, code: "MATCH_FINISHED", error: "MATCH_FINISHED", legal_actions: [] });
      }
      const body0 = await readJson(req);
      const nonce0 = typeof body0.nonce === "string" ? body0.nonce.slice(0, 64) : undefined;
      // nonce 重放：同 (对局, 席位, nonce) 已成功过 → 直接幂等成功（快照早已入账，绝不消耗新回合）
      const replayKey = nonce0 ? `${matchId}:${seat}:${nonce0}` : null;
      if (replayKey && this.nonceReplay.has(replayKey)) {
        await new Promise((r) => setImmediate(r)); // 若原动作正在结算，等一拍取结算后视图
        return this.json(res, 200, { ok: true, replayed: true, view: rm.match.viewFor(seat) });
      }
      const probe = rm.match.viewFor(seat);
      if (probe.you.submitted) {
        return this.json(res, 422, {
          ok: false,
          code: "DUPLICATE_ACTION",
          error: "DUPLICATE_ACTION：本回合已接受你的动作，请等待结算（幂等重试请带同一 nonce）",
          legal_actions: probe.legal_actions,
        });
      }
      if (!probe.you.active) {
        return this.json(res, 422, {
          ok: false,
          code: "NOT_YOUR_TURN",
          error: "NOT_YOUR_TURN：当前不轮到该席位行动",
          legal_actions: probe.legal_actions,
        });
      }
      const body = body0;
      const action = (body.action ?? body) as Action;
      const opts: { reasoning?: string; nonce?: string } = {};
      if (typeof body.reasoning === "string") opts.reasoning = body.reasoning.slice(0, 500);
      if (typeof body.nonce === "string") opts.nonce = body.nonce.slice(0, 64);
      const r = await driver.handleAction(action, opts);
      if (r.ok) {
        if (replayKey) {
          this.nonceReplay.set(replayKey, true);
          if (this.nonceReplay.size > 2000) this.nonceReplay.clear(); // 粗粒度防膨胀
        }
        // 提交成功 ≠ 已结算：等一拍让本回合 apply 跑完，回带结算后的视图
        await new Promise((r2) => setImmediate(r2));
        const view = rm.match.viewFor(seat);
        return this.json(res, 200, { ok: true, view });
      }
      const code =
        ["MATCH_FINISHED", "NOT_YOUR_TURN", "NONCE_REUSED", "NONCE_EXPIRED", "DUPLICATE_ACTION", "ILLEGAL_ACTION", "SEAT_INVALID"].find(
          (c) => String(r.error).startsWith(c),
        ) ?? "UNKNOWN";
      return this.json(res, 422, { ok: false, code, error: r.error, legal_actions: r.legal_actions });
    }
    if (op === "events" && method === "GET") {
      const sinceParam = Number(url.searchParams.get("since"));
      const since = Number.isFinite(sinceParam) ? sinceParam : -1;
      return this.json(res, 200, {
        events: rm.match.eventsFor(viewer, since),
        // 赛中 acted.reasoning 脱敏、终局后公开——finished 标记帮助调用方区分两种语义
        finished: rm.match.isFinished(),
      });
    }
    if (op === "replay" && method === "GET") {
      const r = rm.match.currentResult();
      return this.json(res, 200, {
        match_id: matchId,
        finished: rm.match.isFinished(),
        scores: r?.scores ?? null,
        ratings: rm.ratings,
        events: rm.match.eventsFor(viewer),
      });
    }
    return this.json(res, 405, { error: "METHOD_NOT_ALLOWED", method });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
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

/** 从持久化恢复的对局壳（无游戏状态，仅提供 id / isFinished / 空 events / spectator view） */
class RestoredMatch extends Match {
  constructor(id: string) {
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
        viewOf: () => ({ public: { note: "此对局从持久化恢复，无实时状态" }, private: {} }),
        timeoutAction: () => ({ type: "pass" }),
        isTerminal: () => true,
        scores: () => ({}),
      },
      drivers: new Map(),
    });
  }
}
