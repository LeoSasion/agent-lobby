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
  /** r13：house bot 补位的席位号——写入 match_started 的 human_seats / bot_filled，供选手与复盘识别"这桌有多少真人" */
  botSeats?: SeatId[];
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
  /** 本席位本回合是否已提交（防重复提交的即时信号） */
  youSubmitted?: boolean;
  /** 本相位已提交（含超时默认）的座位——viewOf ctx 的数据源（r7：day_vote votes_cast 曾因读 s.votes 恒空） */
  submittedSeats?: SeatId[];
  result?: { scores: Record<SeatId, number>; winners: SeatId[] } | null;
}): AgentView {
  const snap = opts.game.viewOf(
    opts.state,
    opts.viewer,
    opts.submittedSeats ? { submittedSeats: opts.submittedSeats } : undefined,
  );
  const active = opts.finished ? [] : opts.game.activeSeats(opts.state);
  return {
    protocol: "arena/v0",
    match_id: opts.matchId,
    game: opts.game.meta.id,
    phase: opts.game.phase(opts.state),
    round: opts.game.round(opts.state),
    deadline_ms: opts.deadlineMs,
    // 倒计时推荐读 ms_remaining（deadline_ms 是绝对 epoch 毫秒）；null = 当前无执法时限
    ms_remaining: opts.deadlineMs !== null ? Math.max(0, opts.deadlineMs - Date.now()) : null,
    you: {
      seat: opts.viewer === "spectator" ? -1 : opts.viewer,
      active: opts.viewer !== "spectator" && active.includes(opts.viewer),
      submitted: opts.youSubmitted ?? false,
    },
    public: snap.public,
    private: snap.private,
    legal_actions: opts.viewer === "spectator" ? [] : opts.game.legalActions(opts.state, opts.viewer),
    history: opts.visible.slice(-50),
    history_truncated: opts.visible.length > 50,
    // 终局附比分与胜者（一次性判定的便捷出口；对局中为 null）
    result: opts.result ?? null,
  };
}

/** 终局胜者：取最高分席位（>0）；平局全员同最高分仍列为 winners，0 分局为空 */
export function winnersOf(scores: Record<SeatId, number>): SeatId[] {
  let max = 0;
  for (const v of Object.values(scores)) max = Math.max(max, v);
  if (max <= 0) return [];
  return Object.entries(scores)
    .filter(([, v]) => v === max)
    .map(([k]) => Number(k));
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
  /** r13：house bot 补位的席位集合（写入 match_started.bot_filled / human_seats） */
  private readonly botSeats: Set<SeatId>;
  private firstStep = true;
  private readonly rng: Rng;
  private readonly store = new EventStore();
  private readonly gameEvents: RecordedGameEvent[] = [];
  private state!: unknown;
  private finished = false;
  private lastPhaseKey = "";
  private received = new Map<SeatId, Action>();
  private reasons = new Map<SeatId, string>();
  /** 每座位动作入账时刻（epoch ms）：写入 acted.submitted_at——观测定时分析（r7 w7 反馈：批量结算的 ts 全相同，区分不了先后提交） */
  private submittedAt = new Map<SeatId, number>();
  /** nonce → {seat, turn}：幂等重试绑定回合——跨回合重试不再是隐式成功 */
  private nonceOwners = new Map<string, { seat: SeatId; turn: number }>();
  /** 回合序号：每次 step() 递增，用于 nonce 与回合绑定 */
  private turnSeq = 0;
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
    this.botSeats = new Set(opts.botSeats ?? []);
  }

  async run(): Promise<MatchResult> {
    if (this.state !== undefined) throw new Error("match already run");
    this.state = this.game.init(this.seats, this.rng);
    // r13 修复（P1）：明示本局真人/补位构成——房间强制开局时 bot 补位曾让人误以为是满员真人桌（主桌 4 真人 + 2 bot）
    const bot = this.botSeats;
    this.store.append("match_started", {
      seed: this.seed,
      game: this.game.meta.id,
      seats: this.seats,
      drivers: this.seats.map((s) => this.drivers.get(s)?.name ?? "?"),
      bot_filled: this.seats.filter((s) => bot.has(s)),
      human_seats: this.seats.filter((s) => !bot.has(s)),
    });
    // r13 修复：初始事件钩子——init 产生的开局事件（首手发牌/盲注）入账，
    // 纯事件流重建首手账本不再缺手（P1：首手 30 筹码账本误差）
    const init0 = this.game.initialEvents?.(this.state);
    if (init0) {
      for (const ev of init0) {
        this.store.append(ev.type, ev.data ?? {}, ev.visibility ?? "all");
        this.gameEvents.push({ type: ev.type, data: ev.data ?? {} });
      }
    }
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
    const scores = this.result?.scores;
    return composeAgentView({
      game: this.game,
      state: this.state,
      matchId: this.id,
      viewer,
      visible: this.visibleEvents(viewer),
      finished: this.finished,
      deadlineMs: this.turnDeadline,
      youSubmitted: viewer !== "spectator" && this.received.has(viewer),
      // 相位提交进度（公开相位派生信息的唯一正确数据源）：received 是实时缓冲，
      // 游戏侧 s.votes 等要到批量 apply 才写入——窗口期读它恒为空（r7 P0 教训）
      submittedSeats: [...this.received.keys()],
      result: this.finished && scores ? { scores, winners: winnersOf(scores) } : null,
    });
  }

  /** 原始事件（含私有事件，供回放重放使用；对外输出必须走 eventsFor 过滤） */
  rawEvents(): readonly MatchEvent[] {
    return this.store.all();
  }

  /** 订阅新事件（SSE/WS 用），返回取消函数 */
  subscribe(cb: (event: MatchEvent) => void): () => void {
    return this.store.subscribe(cb);
  }

  /** 网关所需只读访问器 */
  isFinished(): boolean {
    return this.finished;
  }

  eventsFor(viewer: SeatId | "spectator", since = -1): MatchEvent[] {
    return this.visibleEvents(viewer).filter((e) => e.seq > since);
  }

  /**
   * 可见事件（含赛中脱敏）：acted.reasoning 是选手私有推理，
   * 赛中对其他席位/观战隐藏（防竞技泄露）；终局后随事件流公开，供复盘解说。
   */
  private visibleEvents(viewer: SeatId | "spectator"): MatchEvent[] {
    const evs = this.store.visibleTo(viewer);
    if (this.finished) return evs;
    return evs.map((e) => {
      if (e.type === "acted" && e.data.reasoning !== undefined) {
        const { reasoning: _stripped, ...rest } = e.data;
        return { ...e, data: rest };
      }
      return e;
    });
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
    this.turnSeq += 1;
    this.turnDeadline = Date.now() + this.timeoutMs + (this.firstStep ? this.graceMs : 0);
    this.firstStep = false;
    // 相位间隙已提前提交的座位直接入账，不再挂起等待
    const toDrive = active.filter((seat) => !this.received.has(seat));
    await Promise.all(toDrive.map((seat) => this.drive(seat)));
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
        this.submittedAt.set(seat, Date.now());
        // r10 dc10-d2：timed_out 也带 submitted_at（=兜底时刻，与配对 acted 的 Δ0 一致）——
        // 文档 §6.1/§6.3 写的是 acted/timed_out 均有，原实现漏了 timed_out（0/6 不带）
        this.store.append("timed_out", { seat, default_action: action }, this.eventVisibility(seat, action), this.submittedAt.get(seat));
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
      // submitted_at：该座位实际提交时刻（顶层观测元数据，不进 data/哈希——批量结算的 ts 对全员相同）
      this.store.append("acted", actedData, vis, this.submittedAt.get(seat));
      for (const ev of res.events) {
        this.store.append(ev.type, ev.data ?? {}, ev.visibility ?? "all");
        this.gameEvents.push({ type: ev.type, data: ev.data ?? {} });
      }
    }
    // 回合收尾：清空缓冲。此后状态已推进，新相位的行动者可立即提前提交
    // （trySubmit 按 activeSeats 放行），消除 NOT_YOUR_TURN 窗口；
    // deadline 预置为下一回合时限（step 开始时会重置并附加开局宽限）——
    // 间隙期的视图不再出现 deadline_ms=null 的困惑
    this.received = new Map();
    this.reasons = new Map();
    this.submittedAt = new Map();
    this.turnDeadline =
      this.finished || this.game.isTerminal(this.state) ? null : Date.now() + this.timeoutMs;
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

    // 幂等重试（绑定回合）：
    //   同回合同座位同 nonce → 幂等成功（网络重试安全）
    //   跨回合重试 → NONCE_EXPIRED 显式失败——动作早已结算，静默 ok 会吞掉后续回合
    if (opts?.nonce !== undefined) {
      const rec = this.nonceOwners.get(opts.nonce);
      if (rec) {
        if (rec.seat !== seat) {
          return { ok: false, error: "NONCE_REUSED：该 nonce 已被其他座位使用", legal_actions: [] };
        }
        if (rec.turn === this.turnSeq) return { ok: true };
        return {
          ok: false,
          error: "NONCE_EXPIRED：该 nonce 属于已结束的回合，请基于最新 view 重新决策并换新 nonce",
          legal_actions: this.game.legalActions(this.state, seat),
        };
      }
    }

    if (!this.game.activeSeats(this.state).includes(seat)) {
      return { ok: false, error: "NOT_YOUR_TURN", legal_actions: [] };
    }
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
    this.submittedAt.set(seat, Date.now());
    if (opts?.nonce !== undefined) {
      this.nonceOwners.set(opts.nonce, { seat, turn: this.turnSeq });
    }
    if (typeof opts?.reasoning === "string" && opts.reasoning.length > 0) {
      this.reasons.set(seat, opts.reasoning.slice(0, 500));
    }
    return { ok: true };
  }
}
