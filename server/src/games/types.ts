/**
 * 统一 Game 接口："一套协议玩所有游戏"的技术根基（规划 §3）
 * 实现这组方法的游戏自动获得：房间、匹配、计时执法、信息隔离、回放、Elo、观战
 */

import type { Action, EventVisibility, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { Rng } from "../rng.ts";

export interface GameMeta {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  /** 每回合默认超时（毫秒） */
  defaultTimeoutMs: number;
}

/** 游戏产生的语义事件（seq 由内核分配） */
export interface GameEvent {
  type: string;
  data?: Record<string, unknown>;
  visibility?: EventVisibility;
}

export interface GameSnapshot {
  public: Record<string, unknown>;
  private: Record<string, unknown>;
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

export interface GameModule<S> {
  meta: GameMeta;
  /** 初始局面（一切随机性经 rng，保证同 seed 同局面） */
  init(seats: SeatId[], rng: Rng): S;
  phase(state: S): string;
  round(state: S): number;
  /** 当前应行动的席位（同时相位返回多个） */
  activeSeats(state: S): SeatId[];
  legalActions(state: S, seat: SeatId): LegalAction[];
  /** 动作合法性（纯检查，不改变状态）。apply 仅接受 validate 通过的动作 */
  validate(state: S, seat: SeatId, action: Action): ValidateResult;
  /** 应用已验证的动作；原地或返回新状态均可，事件追加返回 */
  apply(state: S, seat: SeatId, action: Action, rng: Rng): { state: S; events: GameEvent[] };
  /** 信息隔离唯一出口：按 viewer 过滤局面 */
  viewOf(state: S, viewer: Viewer): GameSnapshot;
  /** 超时默认动作：必须返回 validate 会通过的动作 */
  timeoutAction(state: S, seat: SeatId): Action;
  /**
   * 内核事件脱敏钩子（P0 级隔离契约）：内核为该动作写 acted/timed_out 事件前调用，
   * 返回可见性（未实现默认 "all"）。在动作应用之前、以动作发生时的状态调用。
   * 例：狼人杀夜间 kill 仅狼可见、check 仅预言家可见。
   */
  actionVisibility?(state: S, seat: SeatId, action: Action): EventVisibility;
  isTerminal(state: S): boolean;
  scores(state: S): Record<SeatId, number>;
}
