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

/**
 * 内核 → 游戏的视图组装上下文（r7：公开相位进度所需）。
 * submittedSeats = 本相位已提交动作的座位（含超时默认入账者，按提交顺序）。
 * 契约：仅可用于公开进度类派生信息（如 day_vote 的 votes_cast）；
 * 隐藏同时相位（如夜间）暴露提交进度会泄露行动者身份——游戏模块自行负责不越界。
 */
export interface ViewContext {
  submittedSeats: SeatId[];
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

export interface GameModule<S> {
  meta: GameMeta;
  /** 初始局面（一切随机性经 rng，保证同 seed 同局面） */
  init(seats: SeatId[], rng: Rng): S;
  /**
   * 初始事件钩子（r13 修复：首手事件缺失）：init 产生的开局事件（发牌/盲注等）
   * 由游戏暂存于 state，Match.run 在 match_started 后调用本钩子取出入账——
   * 纯事件流重建首手账本不再缺手（P1：首手 30 筹码账本误差）。可选实现。
   */
  initialEvents?(state: S): GameEvent[];
  phase(state: S): string;
  round(state: S): number;
  /** 当前应行动的席位（同时相位返回多个） */
  activeSeats(state: S): SeatId[];
  legalActions(state: S, seat: SeatId): LegalAction[];
  /** 动作合法性（纯检查，不改变状态）。apply 仅接受 validate 通过的动作 */
  validate(state: S, seat: SeatId, action: Action): ValidateResult;
  /** 应用已验证的动作；原地或返回新状态均可，事件追加返回 */
  apply(state: S, seat: SeatId, action: Action, rng: Rng): { state: S; events: GameEvent[] };
  /** 信息隔离唯一出口：按 viewer 过滤局面；ctx 携带内核侧派生信息（如相位提交进度，可选） */
  viewOf(state: S, viewer: Viewer, ctx?: ViewContext): GameSnapshot;
  /** 超时默认动作：必须返回 validate 会通过的动作 */
  timeoutAction(state: S, seat: SeatId): Action;
  /**
   * 内核事件脱敏钩子（P0 级隔离契约）：内核为该动作写 acted/timed_out 事件前调用，
   * 返回可见性（未实现默认 "all"）。在动作应用之前、以动作发生时的状态调用。
   * 例：狼人杀夜间 kill 仅狼可见、check 仅预言家可见。
   */
  actionVisibility?(state: S, seat: SeatId, action: Action): EventVisibility;
  /**
   * 终局名次（r29 P1 修复）：多模型对照实验的最小可观测单元。
   * scores 只有冠军 1 分、其余 0，第 2 名与第 6 名在数据上等价；placements 补全序。
   * 未实现时内核按 scores 降序 + 座位号升序生成兜底名次——
   * 注意兜底对「单一冠军制」只能区分冠军与并列末位，多席位赛制（holdem 筹码）须自实现。
   */
  placements?(state: S): { seat: SeatId; rank: number; note?: string }[];
  /**
   * 席位存活态（r29 P2 修复）：此前 "没轮到我 / 我已出局 / 已终局" 在视图上完全同形
   * （都是 active:false + legal_actions:[]），Agent 只能靠 dice_count==0 之类的间接信号反推。
   * 未实现时视图省略 you.status（不臆造）。
   */
  seatAlive?(state: S, seat: SeatId): boolean;
  isTerminal(state: S): boolean;
  scores(state: S): Record<SeatId, number>;
}
