/**
 * Webhook Push 座位驱动（arena/v0 · 通道 B，协议 docs/02 §4）
 * 回合开始时把 AgentView POST 到 Agent 注册的 callback URL（HMAC-SHA256 签名）：
 *   - 200 + {action}：同步出招（v0 唯一支持的模式）
 *   - 202：异步模式 v0 暂不支持，直接返回交由超时默认兜底
 *   - 5xx：最多重试 3 次
 * 非法动作：平台推送 action.rejected（附 error + legal_actions），Agent 可自纠
 */

import { createHmac } from "node:crypto";
import type { Action, AgentView, SubmitResult } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { withTimeout } from "../util.ts";

export interface WebhookDriverOptions {
  name: string;
  url: string;
  secret: string;
  timeoutMs: number;
}

export class WebhookSeatDriver implements SeatDriver {
  readonly name: string;
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(opts: WebhookDriverOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs;
  }

  async act(view: AgentView, submit: (a: Action, opts?: { reasoning?: string; nonce?: string }) => SubmitResult): Promise<void> {
    let payload: Record<string, unknown> = { event: "turn.start", view };
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = JSON.stringify(payload);
      const sig = createHmac("sha256", this.secret).update(body).digest("hex");
      let json: { action?: Action; reasoning?: string } | null = null;
      try {
        const res = await withTimeout(
          fetch(this.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-arena-event": String(payload.event),
              "x-arena-delivery": "d-" + Math.random().toString(36).slice(2, 12),
              "x-arena-signature": "sha256=" + sig,
            },
            body,
          }),
          this.timeoutMs,
        );
        if (res.status === 200) {
          json = (await res.json()) as { action?: Action; reasoning?: string };
        } else if (res.status === 202) {
          return;
        } else if (res.status < 500) {
          return; // Agent 明确拒绝（4xx）：不重试
        }
        // 5xx 落到下一轮重试
      } catch {
        return; // 网络错误/超时：交由超时默认动作兜底
      }
      if (json && json.action) {
        const opts: { reasoning?: string } = {};
        if (typeof json.reasoning === "string") opts.reasoning = json.reasoning.slice(0, 500);
        const r = submit(json.action, opts.reasoning ? opts : undefined);
        if (r.ok) return;
        payload = { event: "action.rejected", error: r.error, legal_actions: r.legal_actions, view };
        continue;
      }
      return;
    }
  }
}
