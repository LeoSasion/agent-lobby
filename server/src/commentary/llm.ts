/**
 * LLM 解说引擎（r26-d）——commentate 规则词典的异步替换位
 * 设计原则（零 LLM 依赖铁律的唯二例外之一：AI 解说）：
 *   - 未配置环境变量 → 路由层 503 LLM_NOT_CONFIGURED，前端静默回退规则词典（现状零变化）
 *   - 每请求时读 env（非启动快照）——运维可不重启切供应商
 *   - 金句按 match:seq 事件粒度缓存（同一事件多客户端/刷新不重发）
 *   - OpenAI 兼容协议（/chat/completions）——deepseek/glm/openai/本地 ollama 皆可接
 *   - 8s 超时；LLM 失败回错误码，绝不抛异常阻塞调用方
 */

export interface LLMCfg {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function readLLMCfg(): LLMCfg | null {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "") ?? "";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const model = process.env.LLM_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

/** 事件粒度金句缓存（key = `${mid}:${seq}`）——上限 2000 条后整体清空（观战会话级够了） */
const cache = new Map<string, string>();
function cacheKey(mid: string, seq: number): string {
  return `${mid}:${seq}`;
}

const SYSTEM_PROMPT = [
  "你是「磷光公报」的赛场解说——一个冷峻、克制、有画面感的中文解说人。",
  "收到一条多智能体博弈游戏的对局事件后，写一句中文金句解说。",
  "纪律：25 字以内；可用「——」破折号与「，」；绝不出现英文单词、代码、JSON、表情符号；",
  "不解说规则本身，只给情绪与画面；可以超越参考解说的水准，但不要复读它。",
  "只输出解说句本身，不要任何前后缀。",
].join("");

export interface LLMCommentaryInput {
  mid: string;
  seq: number;
  type: string;
  data: unknown;
  ruleText: string;
}

export type LLMResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; code: "LLM_NOT_CONFIGURED" | "LLM_TIMEOUT" | "LLM_UPSTREAM" | "LLM_BAD_INPUT"; message: string };

/** fetch 注入位（smoke 用 mock fetch 测全链路；生产用全局 fetch） */
export async function callLLMCommentary(
  input: LLMCommentaryInput,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<LLMResult> {
  if (!input.mid || typeof input.seq !== "number" || !input.type) {
    return { ok: false, code: "LLM_BAD_INPUT", message: "body 须含 {mid, seq, type, data?, rule_text?}" };
  }
  const hit = cache.get(cacheKey(input.mid, input.seq));
  if (hit !== undefined) return { ok: true, text: hit, cached: true };

  const cfg = readLLMCfg();
  if (!cfg) {
    return {
      ok: false,
      code: "LLM_NOT_CONFIGURED",
      message: "LLM 解说未配置——需环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（OpenAI 兼容协议）；前端将回退规则解说引擎",
    };
  }

  const userPrompt = [
    `事件：${input.type}`,
    `事件数据：${JSON.stringify(input.data ?? {}).slice(0, 400)}`,
    input.ruleText ? `规则引擎解说（参考）：${input.ruleText}` : "",
  ].filter(Boolean).join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 80,
        temperature: 0.8,
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      return { ok: false, code: "LLM_UPSTREAM", message: `LLM 上游 ${r.status}（${cfg.baseUrl}）` };
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      return { ok: false, code: "LLM_UPSTREAM", message: "LLM 返回空 content" };
    }
    if (cache.size > 2000) cache.clear();
    cache.set(cacheKey(input.mid, input.seq), text);
    return { ok: true, text, cached: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.includes("abort") || (err as { name?: string }).name === "AbortError";
    return {
      ok: false,
      code: timedOut ? "LLM_TIMEOUT" : "LLM_UPSTREAM",
      message: timedOut ? `LLM 调用超时（${timeoutMs}ms）` : `LLM 调用失败：${msg.slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 测试钩子：清缓存 */
export function clearLLMCache(): void {
  cache.clear();
}
