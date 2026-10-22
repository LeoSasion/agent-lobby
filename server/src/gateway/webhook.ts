/**
 * Webhook Push 座位驱动（arena/v0 · 通道 B，协议 docs/02 §4）
 * 回合开始时把 AgentView POST 到 Agent 注册的 callback URL（HMAC-SHA256 签名）：
 *   - 200 + {action}：同步出招（v0 唯一支持的模式）
 *   - 202：异步模式 v0 暂不支持，直接返回交由超时默认兜底
 *   - 5xx：最多重试 3 次
 * 非法动作：平台推送 action.rejected（附 error + legal_actions），Agent 可自纠
 */

import { createHmac } from "node:crypto";
import type { Action, AgentView, SubmitOptions, SubmitResult } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { withTimeout } from "../util.ts";

/** Agent 回调体：动作 + 可选的提交注解（nonce/turn 与 HTTP 通道同义） */
interface AgentReply {
  action?: Action;
  reasoning?: string;
  nonce?: string;
  turn?: number;
}

export interface WebhookDriverOptions {
  name: string;
  url: string;
  secret: string;
  timeoutMs: number;
  /** r9 backlog：slim 推送——turn.start 不带 history（与 HTTP 通道 view?slim=1 同语义；历史走 /events?since= 补拉） */
  slim?: boolean;
}

export class WebhookSeatDriver implements SeatDriver {
  readonly name: string;
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly slim: boolean;

  constructor(opts: WebhookDriverOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs;
    this.slim = opts.slim === true;
  }

  async act(view: AgentView, submit: (a: Action, opts?: SubmitOptions) => SubmitResult): Promise<void> {
    // slim 席位：推送帧省略 history（wh9-h1 实测全量 14.9KB/推送；完整历史由 Agent 凭 seat_token 走 /events?since= 增量补拉）
    const pushView: AgentView = this.slim ? { ...view, history: [], history_truncated: true } : view;
    let payload: Record<string, unknown> = { event: "turn.start", view: pushView };
    // r9 wh9-h2【高】修复：delivery id 必须在 attempt 循环外生成——重试时 id 不变（文档 §4 去重承诺），
    // 原实现写在循环体内导致每次重试换 id，去重键失效。
    // r30 校正：id 稳定只针对**同一条推送的重试**。转成 action.rejected 时 payload 已是新事件，
    // 若继续复用旧 id，按 delivery id 去重的 Agent 会把它当成重复投递丢弃 → 收不到错误与合法动作，
    // 只能干等到超时兜底。故换 payload 即换 id。
    const newDeliveryId = (): string => "d-" + Math.random().toString(36).slice(2, 12);
    let deliveryId = newDeliveryId();
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = JSON.stringify(payload);
      const sig = createHmac("sha256", this.secret).update(body).digest("hex");
      let json: AgentReply | null = null;
      try {
        const res = await withTimeout(
          fetch(this.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-arena-event": String(payload.event),
              "x-arena-delivery": deliveryId,
              "x-arena-signature": "sha256=" + sig,
            },
            body,
          }),
          this.timeoutMs,
        );
        if (res.status === 200) {
          json = (await res.json()) as AgentReply;
        } else if (res.status === 202) {
          return;
        } else if (res.status < 500) {
          return; // Agent 明确拒绝（4xx）：不重试
        } else {
          // r9 wh9-h2【高】修复：5xx 重试——原实现落到循环末尾 return，"最多重试 3 次"
          // 的文档承诺从未生效（实测 500 后仅 1 次投递即兜底弃票）
          continue;
        }
      } catch {
        return; // 网络错误/超时：交由超时默认动作兜底
      }
      if (json && json.action) {
        // r30c：此前只转发 reasoning——Agent 即便在回调体里带 nonce / turn 也被丢掉了。
        // 结果是 webhook 通道既拿不到幂等重试保护，也无法启用陈旧视图保护（与 HTTP 通道能力不对等）。
        const opts: SubmitOptions = {};
        if (typeof json.reasoning === "string") opts.reasoning = json.reasoning.slice(0, 500);
        if (typeof json.nonce === "string") opts.nonce = json.nonce.slice(0, 64);
        if (typeof json.turn === "number" && Number.isInteger(json.turn)) opts.turn = json.turn;
        const r = submit(json.action, opts);
        if (r.ok) return;
        payload = { event: "action.rejected", error: r.error, legal_actions: r.legal_actions, view };
        deliveryId = newDeliveryId(); // 新事件 → 新 id（同 id 重投会被去重逻辑吞掉）
        continue;
      }
      return;
    }
  }
}
