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
  /** 事件落库时刻（epoch ms）——纯观测性元数据：不参与确定性哈希与回放重放（r6 ot-h1：回放时间压力分析依赖） */
  ts?: number;
  /** 该座位动作入账时刻（epoch ms，仅 acted/timed_out）——批量结算的 ts 对同相位全员相同，此字段区分实际提交先后（r7 w7 反馈）；同样不参与哈希与重放 */
  submitted_at?: number;
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
  /**
   * 我在本局的状态（r29 修复）：
   *  - active    = 现在轮到我出招（active=true 时 legal_actions 必非空，二者严格一致）
   *  - waiting   = 在局但未轮到我
   *  - eliminated= 已出局（本局仍有其他席位在打）
   *  - finished  = 已终局
   *  - spectator = 观战视角
   * submitted 恒与「本步内我是否已交」同源：submitted=true 时 active 必为 false。
   * （r30 校正：多动作相位不再让二者同时成立——狼人杀夜间交完密语后本步即视为已交，
   *  下一夜步内核会重新把该席位列入 active，因为密语不写入 nightActions。）
   */
  you: {
    seat: SeatId;
    active: boolean;
    submitted: boolean;
    status: "active" | "waiting" | "eliminated" | "finished" | "spectator";
    /** status==="eliminated" 的便捷布尔（旧客户端兼容） */
    eliminated?: boolean;
  };
  public: Record<string, unknown>;
  private: Record<string, unknown>;
  legal_actions: LegalAction[];
  /** 最近 50 条可见事件；truncated=true 表示更早事件被截断（完整流走 GET /events） */
  history: MatchEvent[];
  history_truncated: boolean;
  /**
   * 决策令牌（r30c）：本视图对应的「提交回合」。POST actions 时把该值原样放进 body.turn，
   * 内核会校验——基于旧视图的提交（网络重试、思考过慢、跨相位残留）将被拒为 `STALE_VIEW`，
   * 而不是被当成一条新的决策悄悄入账。不传则不校验（向后兼容）。
   * 实时视图恒有；回放步骤视图（/replay/step）不保证提供。
   */
  turn?: number;
  /** 终局比分与胜者（对局中为 null）；winners = 最高分席位（狼人杀为获胜阵营全体，平局为空） */
  result: {
    scores: Record<SeatId, number>;
    winners: SeatId[];
    /** 终局全序名次（r29）：rank 从 1 起，同 rank 并列；多模型对照实验靠它区分第 2 名与第 6 名 */
    placements?: { seat: SeatId; rank: number; note?: string }[];
  } | null;
}

/** 动作提交的附加选项（内核 / 驱动 / 网关 / webhook 共用一套） */
export interface SubmitOptions {
  reasoning?: string;
  nonce?: string;
  /** 决策令牌：回传视图里的 `turn`（语义见 AgentView.turn）；不传则不校验 */
  turn?: number;
}

/** 提交结果：非法动作附 legal_actions，Agent 可自纠（协议 422 语义） */
export type SubmitResult =
  | { ok: true }
  | { ok: false; error: string; legal_actions: LegalAction[] };

export const ERROR_CODES = {
  AUTH_INVALID: 401,
  SEAT_TOKEN_INVALID: 401,
  WEBHOOK_AUTH_REQUIRED: 401,
  SEAT_INVALID: 403,
  ROOM_FORBIDDEN: 403,
  WEBHOOK_NOT_REGISTERED: 400,
  NOT_FOUND: 404,
  MATCH_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  ROOM_FULL: 409,
  ROOM_STARTED: 409,
  /** r9：旧版状态文件恢复的对局无事件（回放数据不可用；r9 起落盘全量事件后不再出现） */
  REPLAY_UNAVAILABLE: 410,
  NOT_YOUR_TURN: 422,
  ILLEGAL_ACTION: 422,
  NONCE_REUSED: 422,
  NONCE_EXPIRED: 422,
  DUPLICATE_ACTION: 422,
  MATCH_FINISHED: 422,
  RATE_LIMITED: 429,
  CONTENT_REJECTED: 422,
  VERSION_UNSUPPORTED: 400,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
