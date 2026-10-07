/**
 * Match 执法器：内核心脏（规划 §5 架构 - Arena Core）
 * 职责：驱动游戏状态机、回合执法、超时默认动作、动作校验、事件记录、视图组装
 * 设计要点：
 *  - SeatDriver 与协议同构（view → submit），远程 Agent 只需一个 HTTP 适配器即可接入
 *  - validate 先行（协议 422 语义），apply 只接受已验证动作
 *  - 同时相位的动作按座位号顺序应用，保证确定性
 *  - 驱动崩溃/超时一律兜底，比赛永不卡死（容错优先）
 */

import type { Action, AgentView, MatchEvent, SeatId, SubmitResult } from "../protocol.ts";
import type { GameEvent, GameModule } from "../games/types.ts";
import { mulberry32, randomSeed } from "../rng.ts";
import type { Rng } from "../rng.ts";
import { EventStore } from "./event-store.ts";
import { randomId, withTimeout } from "../util.ts";

export interface SeatDriver {
  name: string;
  /** 收到自己的 AgentView，通过 submit 提交动作（opts.reasoning 进入回放、opts.nonce 幂等重试）；非法提交会收到错误可重试 */
  act(view: AgentView, submit: (action: Action, opts?: { reasoning?: string; nonce?: string }) => SubmitResult): Promise<void>;
}

export interface RecordedGameEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface MatchResult {
  matchId: string;
  scores: Record<SeatId, number>;
  events: readonly MatchEvent[];
  gameEvents: RecordedGameEvent[];
}

export interface MatchOptions {
  id?: string;
  game: GameModule<unknown>;
  drivers: Map<SeatId, SeatDriver>;
  seed?: number;
  /** 覆盖游戏的默认超时（测试用） */
  timeoutMs?: number;
  /** 开局宽限：第一步的 deadline 额外延长（给 Agent 写驱动脚本的时间） */
  graceMs?: number;
  /** 相位最短持续时长：防止 bot 秒应导致相位闪过（观战/轮询不可见） */
  minPhaseMs?: number;
}

/** 组装 AgentView（Match 实时视图与回放步骤视图共用；viewOf 是信息隔离唯一出口） */
export function composeAgentView(opts: {
  game: GameModule<unknown>;
  state: unknown;
  matchId: string;
  viewer: SeatId | "spectator";
  visible: MatchEvent[];
  finished: boolean;
  deadlineMs: number | null;
}): AgentView {
  const snap = opts.game.viewOf(opts.state, opts.viewer);
  const active = opts.finished ? [] : opts.game.activeSeats(opts.state);
  return {
    protocol: "arena/v0",
    match_id: opts.matchId,
    game: opts.game.meta.id,
    phase: opts.game.phase(opts.state),
    round: opts.game.round(opts.state),
    deadline_ms: opts.deadlineMs,
    you: {
      seat: opts.viewer === "spectator" ? -1 : opts.viewer,
      active: opts.viewer !== "spectator" && active.includes(opts.viewer),
    },
    public: snap.public,
    private: snap.private,
    legal_actions: opts.viewer === "spectator" ? [] : opts.game.legalActions(opts.state, opts.viewer),
    history: opts.visible.slice(-50),
  };
}

export class Match {
  readonly id: string;
  readonly seats: SeatId[];
  private readonly game: GameModule<unknown>;
  private readonly drivers: Map<SeatId, SeatDriver>;
  private readonly seed: number;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly minPhaseMs: number;
  private firstStep = true;
  private readonly rng: Rng;
  private readonly store = new EventStore();
  private readonly gameEvents: RecordedGameEvent[] = [];
  private state!: unknown;
  private finished = false;
  private lastPhaseKey = "";
  private acting = new Set<SeatId>();
  private received = new Map<SeatId, Action>();
  private reasons = new Map<SeatId, string>();
  private lastNonces = new Map<SeatId, string>();
  private nonceOwners = new Map<string, SeatId>();
  private turnDeadline: number | null = null;
  private result: MatchResult | null = null;

  constructor(opts: MatchOptions) {
    this.id = opts.id ?? randomId("m");
    this.game = opts.game;
    this.drivers = opts.drivers;
    this.seed = opts.seed ?? randomSeed();
    this.timeoutMs = opts.timeoutMs ?? opts.game.meta.defaultTimeoutMs;
    this.graceMs = opts.graceMs ?? 0;
    this.minPhaseMs = opts.minPhaseMs ?? 0;
    this.rng = mulberry32(this.seed);
    this.seats = [...opts.drivers.keys()].sort((a, b) => a - b);
  }

  async run(): Promise<MatchResult> {
    if (this.state !== undefined) throw new Error("match already run");
    this.state = this.game.init(this.seats, this.rng);
    this.store.append("match_started", {
      seed: this.seed,
      game: this.game.meta.id,
      seats: this.seats,
      drivers: this.seats.map((s) => this.drivers.get(s)?.name ?? "?"),
    });
    for (;;) {
      if (this.finished || this.game.isTerminal(this.state)) break;
      this.announcePhase();
      const active = this.game.activeSeats(this.state);
      if (active.length === 0) {
        throw new Error(
          `阶段 ${this.game.phase(this.state)} 无行动者但未终局（游戏模块缺陷）`,
        );
      }
      const stepStart = Date.now();
      await this.step(active);
      // 相位节奏：bot 秒应导致相位闪过时，强制保持最短可见时长
      const stepDur = Date.now() - stepStart;
      if (
        this.minPhaseMs > 0 &&
        !this.finished &&
        !this.game.isTerminal(this.state) &&
        stepDur < this.minPhaseMs
      ) {
        await new Promise((r) => setTimeout(r, this.minPhaseMs - stepDur));
      }
    }
    const scores = this.game.scores(this.state);
    this.store.append("match_ended", { scores });
    this.finished = true;
    this.turnDeadline = null;
    this.result = {
      matchId: this.id,
      scores,
      events: this.store.all(),
      gameEvents: this.gameEvents,
    };
    return this.result;
  }

  /** 组装 AgentView：viewOf 是信息隔离唯一出口 */
  viewFor(viewer: SeatId | "spectator"): AgentView {
    return composeAgentView({
      game: this.game,
      state: this.state,
      matchId: this.id,
      viewer,
      visible: this.store.visibleTo(viewer),
      finished: this.finished,
      deadlineMs: this.turnDeadline,
    });
  }

  /** 原始事件（含私有事件，供回放重放使用；对外输出必须走 eventsFor 过滤） */
  rawEvents(): readonly MatchEvent[] {
    return this.store.all();
  }

  /** 网关所需只读访问器 */
  isFinished(): boolean {
    return this.finished;
  }

  eventsFor(viewer: SeatId | "spectator", since = -1): MatchEvent[] {
    return this.store.visibleTo(viewer).filter((e) => e.seq > since);
  }

  currentResult(): MatchResult | null {
    return this.result;
  }

  private announcePhase(): void {
    const phase = this.game.phase(this.state);
    const round = this.game.round(this.state);
    const key = `${phase}#${round}`;
    if (key === this.lastPhaseKey) return;
    this.lastPhaseKey = key;
    this.store.append("phase_started", { phase, round });
  }

  private async step(active: SeatId[]): Promise<void> {
    this.acting = new Set(active);
    this.received = new Map();
    this.reasons = new Map();
    this.turnDeadline = Date.now() + this.timeoutMs + (this.firstStep ? this.graceMs : 0);
    this.firstStep = false;
    await Promise.all(active.map((seat) => this.drive(seat)));
    // 超时兜底：未提交者执行游戏默认动作（并校验其合法性——这是游戏模块的契约）
    for (const seat of active) {
      if (!this.received.has(seat)) {
        const action = this.game.timeoutAction(this.state, seat);
        const v = this.game.validate(this.state, seat, action);
        if (!v.ok) {
          this.fail(`游戏模块缺陷：seat ${seat} 的超时默认动作非法（${v.error}）`);
          return;
        }
        this.received.set(seat, action);
        this.store.append("timed_out", { seat, default_action: action }, this.eventVisibility(seat, action));
      }
    }
    // 确定性：同时相位按座位号顺序应用；游戏模块异常不外抛，转为 match_failed 优雅终局
    for (const seat of [...active].sort((a, b) => a - b)) {
      const action = this.received.get(seat)!;
      const reasoning = this.reasons.get(seat);
      const vis = this.eventVisibility(seat, action);
      let res: { state: unknown; events: GameEvent[] };
      try {
        res = this.game.apply(this.state, seat, action, this.rng);
      } catch (e) {
        this.fail(`游戏模块 apply 异常（seat ${seat}）：${e}`);
        return;
      }
      this.state = res.state;
      const actedData: Record<string, unknown> = { seat, action };
      if (reasoning) actedData.reasoning = reasoning;
      this.store.append("acted", actedData, vis);
      for (const ev of res.events) {
        this.store.append(ev.type, ev.data ?? {}, ev.visibility ?? "all");
        this.gameEvents.push({ type: ev.type, data: ev.data ?? {} });
      }
    }
  }

  /** acted/timed_out 的脱敏钩子：在动作应用前、以动作发生时的状态调用（相位正确） */
  private eventVisibility(seat: SeatId, action: Action): MatchEvent["visibility"] {
    return this.game.actionVisibility
      ? this.game.actionVisibility(this.state, seat, action)
      : "all";
  }

  /** 框架兜底：任何内核/游戏模块异常都以 match_failed 优雅终局，绝不留僵尸对局 */
  private fail(reason: string): void {
    let scores: Record<SeatId, number> = {};
    try {
      scores = this.game.scores(this.state);
    } catch {
      /* 状态已损坏，按空分数处理 */
    }
    this.store.append("match_failed", { reason });
    this.finished = true;
    this.turnDeadline = null;
    this.result = {
      matchId: this.id,
      scores,
      events: this.store.all(),
      gameEvents: this.gameEvents,
    };
  }

  private async drive(seat: SeatId): Promise<void> {
    const driver = this.drivers.get(seat);
    if (!driver) return;
    const view = this.viewFor(seat);
    try {
      await withTimeout(
        driver.act(view, (a, o) => this.trySubmit(seat, a, o)),
        this.timeoutMs,
      );
    } catch {
      // 驱动崩溃或超时：不外抛，交由超时默认动作兜底（容错优先）
    }
  }

  private trySubmit(seat: SeatId, action: Action, opts?: { reasoning?: string; nonce?: string }): SubmitResult {
    if (this.finished) return { ok: false, error: "MATCH_FINISHED", legal_actions: [] };

    // 幂等重试：同 nonce 同座位 → 无论回合是否已推进，返回成功（网络重试安全）
    if (opts?.nonce !== undefined) {
      const owner = this.nonceOwners.get(opts.nonce);
      if (owner === seat) return { ok: true };
      if (owner !== undefined) {
        return { ok: false, error: "NONCE_REUSED：该 nonce 已被其他座位使用", legal_actions: [] };
      }
    }

    if (!this.acting.has(seat)) return { ok: false, error: "NOT_YOUR_TURN", legal_actions: [] };
    if (this.received.has(seat)) {
      return { ok: false, error: "NONCE_REUSED：本回合已接受动作（无 nonce 重试）", legal_actions: [] };
    }
    const v = this.game.validate(this.state, seat, action);
    if (!v.ok) {
      return {
        ok: false,
        error: v.error,
        legal_actions: this.game.legalActions(this.state, seat),
      };
    }
    this.received.set(seat, action);
    if (opts?.nonce !== undefined) {
      this.lastNonces.set(seat, opts.nonce);
      this.nonceOwners.set(opts.nonce, seat);
    }
    if (typeof opts?.reasoning === "string" && opts.reasoning.length > 0) {
      this.reasons.set(seat, opts.reasoning.slice(0, 500));
    }
    return { ok: true };
  }
}
