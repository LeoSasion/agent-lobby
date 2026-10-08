/**
 * Agent 游戏大厅 · 协议核心类型（arena/v0）
 * 对应文档：docs/02-Agent接入协议草案-v0.md
 * 约束：仅可擦除语法（Node 22.18+ 原生类型剥离运行，零依赖）
 */

export type SeatId = number;
export type Viewer = SeatId | "spectator";

/** 动作：结构化、可校验。say 类文本只是 payload，不是指令 */
export interface Action {
  type: string;
  [key: string]: unknown;
}

/** 合法动作描述：有限集可枚举，参数化动作用 schema 描述 */
export interface LegalAction {
  type: string;
  schema?: Record<string, unknown>;
  hint?: string;
}

export type EventVisibility = "all" | { seats: SeatId[] };

/** 追加式事件：回放 = seed + acted 序列重放 */
export interface MatchEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  visibility: EventVisibility;
}

/** 按席位过滤后的局面视图：信息隔离的唯一出口 */
export interface AgentView {
  protocol: "arena/v0";
  match_id: string;
  game: string;
  phase: string;
  round: number;
  /** 绝对 epoch 毫秒（倒计时请优先读 ms_remaining）；null = 当前无执法时限 */
  deadline_ms: number | null;
  /** 距截止的毫秒数（视图生成时刻计算）；null = 当前无执法时限 */
  ms_remaining: number | null;
  you: { seat: SeatId; active: boolean; submitted: boolean };
  public: Record<string, unknown>;
  private: Record<string, unknown>;
  legal_actions: LegalAction[];
  history: MatchEvent[];
  /** 终局比分（对局中为 null）——一次性判定出口，无需再拉 replay */
  result: { scores: Record<SeatId, number> } | null;
}

/** 提交结果：非法动作附 legal_actions，Agent 可自纠（协议 422 语义） */
export type SubmitResult =
  | { ok: true }
  | { ok: false; error: string; legal_actions: LegalAction[] };

export const ERROR_CODES = {
  AUTH_INVALID: 401,
  SEAT_INVALID: 403,
  NOT_YOUR_TURN: 422,
  ILLEGAL_ACTION: 422,
  NONCE_REUSED: 422,
  NONCE_EXPIRED: 422,
  DUPLICATE_ACTION: 422,
  MATCH_FINISHED: 422,
  RATE_LIMITED: 429,
  CONTENT_REJECTED: 422,
  VERSION_UNSUPPORTED: 400,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
