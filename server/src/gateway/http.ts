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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { randomId } from "../util.ts";

/** HTTP Pull 座位驱动：act() 挂起等待，直到 Agent 经 POST /actions 提交（或超时兜底） */
class HttpSeatDriver implements SeatDriver {
  readonly name: string;
  private pending: {
    submit: (a: Action) => SubmitResult;
    resolve: () => void;
  } | null = null;

  constructor(name: string) {
    this.name = name;
  }

  act(_view: AgentView, submit: (a: Action) => SubmitResult): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending = { submit, resolve };
    });
  }

  handleAction(action: Action): SubmitResult {
    if (!this.pending) {
      return { ok: false, error: "NOT_YOUR_TURN：当前无待提交回合", legal_actions: [] };
    }
    const r = this.pending.submit(action);
    if (r.ok) {
      this.pending.resolve();
      this.pending = null;
    }
    return r;
  }
}

interface RunningMatch {
  match: Match;
  gameId: string;
  seatTokens: Map<string, SeatId>;
  httpDrivers: Map<SeatId, HttpSeatDriver>;
  seatAgents: Map<SeatId, string>;
  result: MatchResult | null;
  ratings: RatingDelta[] | null;
}

export class Gateway {
  private games = new Map<string, GameModule<unknown>>();
  private agents = new Map<string, { agent_id: string; name: string; callback_url?: string; webhook_secret?: string }>();
  private matches = new Map<string, RunningMatch>();
  private ratings = new RatingStore();
  private agentNames = new Map<string, string>();
  private indexHtml: string | null = null;

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
      this.agents.set(apiKey, {
        agent_id: "a_" + randomId(""),
        name,
        callback_url: callbackUrl,
        webhook_secret: webhookSecret,
      });
      return this.json(res, 201, {
        api_key: apiKey,
        name,
        callback_url: callbackUrl ?? null,
        webhook_secret: webhookSecret ?? null,
      });
    }
    if (method === "GET" && path === "/api/v1/matches") {
      const list = [...this.matches.values()]
        .map((rm) => ({
          match_id: rm.match.id,
          game: rm.gameId,
          finished: rm.match.isFinished(),
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
    const m = /^\/api\/v1\/matches\/([^/]+)\/(view|actions|events|replay)$/.exec(path);
    if (m) return this.matchOp(m[1], m[2], method, url, req, res);
    return this.json(res, 404, { error: "NOT_FOUND", path });
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
    const human: SeatDriver = useWebhook
      ? new WebhookSeatDriver({
          name: agentName,
          url: known!.callback_url!,
          secret: known!.webhook_secret!,
          timeoutMs: Math.max(1000, game.meta.defaultTimeoutMs - 500),
        })
      : new HttpSeatDriver(agentName);
    const house = houseBotsFor(gameId, total - 1);
    const drivers: SeatDriver[] = [human, ...house.map((h) => h.driver)];

    const match = createMatch({ game, drivers });
    const seatToken = "st_" + randomId("");
    const seatAgents = new Map<SeatId, string>();
    seatAgents.set(1, agentId);
    house.forEach((h, i) => {
      seatAgents.set(i + 2, h.agent);
      this.agentNames.set(h.agent, h.name);
    });

    const rm: RunningMatch = {
      match,
      gameId,
      seatTokens: new Map([[seatToken, 1]]),
      httpDrivers: new Map([[1, human]]),
      seatAgents,
      result: null,
      ratings: null,
    };
    this.matches.set(match.id, rm);
    match
      .run()
      .then((r) => {
        rm.result = r;
        rm.ratings = this.ratings.applyMatch(gameId, seatAgents, r.scores);
      })
      .catch((e) => console.error("[match error]", match.id, e));

    return this.json(res, 200, {
      match_id: match.id,
      seat_id: 1,
      seat_token: seatToken,
      api_key: apiKey,
      agent_id: agentId,
      game: gameId,
      seats: total,
      hint: "轮询 GET view，you.active=true 时 POST actions",
    });
  }

  private nameOf(agent: string): string {
    const n = this.agentNames.get(agent);
    if (n) return n;
    return agent.startsWith("house:") ? agent.replace("house:", "house·") : agent;
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
      seatTokens: new Map(),
      httpDrivers: new Map(),
      seatAgents,
      result: null,
      ratings: null,
    };
    this.matches.set(match.id, rm);
    match
      .run()
      .then((r) => {
        rm.result = r;
        rm.ratings = this.ratings.applyMatch(gameId, seatAgents, r.scores);
      })
      .catch((e) => console.error("[match error]", match.id, e));
    return match.id;
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
    const viewer: SeatId | "spectator" = seat ?? "spectator";

    if (op === "view" && method === "GET") {
      return this.json(res, 200, rm.match.viewFor(viewer));
    }
    if (op === "actions" && method === "POST") {
      if (seat === undefined) return this.json(res, 403, { error: "SEAT_INVALID" });
      const body = await readJson(req);
      const action = (body.action ?? body) as Action;
      const r = rm.httpDrivers.get(seat)!.handleAction(action);
      return this.json(res, r.ok ? 200 : 422, r);
    }
    if (op === "events" && method === "GET") {
      const since = Number(url.searchParams.get("since") ?? -1);
      return this.json(res, 200, { events: rm.match.eventsFor(viewer, since) });
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
