/**
 * 冒烟测试：LLM 解说引擎（r26-d）——commentate 规则词典的异步替换位
 * 覆盖：未配置回退 / mock LLM 金句 / 事件粒度缓存（同事件不重发）/ 超时 / 上游错误 / 空 content /
 *   env 每请求动态读（不重启切供应商）/ BAD_INPUT
 * 运行：node --experimental-strip-types src/smoke-commentary-llm.ts
 */

import { callLLMCommentary, clearLLMCache, readLLMCfg } from "./commentary/llm.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

console.log("=== Agent 游戏大厅 · LLM 解说引擎 冒烟测试 ===\n");

const EV = { mid: "m_test", seq: 42, type: "game_won", data: { winner: "civilians", word_pair: { civilian: "苹果", undercover: "梨" } }, ruleText: "真相大白——卧底被揪出" };

// —— 场景 A：未配置回退 ——
console.log("[场景 A] 未配置 → LLM_NOT_CONFIGURED（前端回退规则词典）");
delete process.env.LLM_BASE_URL;
delete process.env.LLM_API_KEY;
delete process.env.LLM_MODEL;
clearLLMCache();
check("readLLMCfg 未配置返回 null", readLLMCfg() === null);
const rA = await callLLMCommentary(EV);
check("未配置返回 LLM_NOT_CONFIGURED", rA.ok === false && rA.code === "LLM_NOT_CONFIGURED", rA.ok ? "" : rA.code);

// —— 场景 B：配置 + mock LLM 金句 ——
console.log("\n[场景 B] mock LLM 金句（OpenAI 兼容协议）");
let fetchCalls = 0;
let lastBody = "";
const mockFetch = (async (url: unknown, init?: { body?: string }) => {
  fetchCalls++;
  lastBody = init?.body ?? "";
  return new Response(JSON.stringify({
    choices: [{ message: { content: "  苹果落地，伪装成梨的那位先走一步  " } }],
  }), { status: 200 });
}) as typeof fetch;
process.env.LLM_BASE_URL = "https://llm.test/v1";
process.env.LLM_API_KEY = "sk-test";
process.env.LLM_MODEL = "test-model";
clearLLMCache();
const rB = await callLLMCommentary(EV, mockFetch);
check("金句成功且 trim", rB.ok === true && rB.text === "苹果落地，伪装成梨的那位先走一步", rB.ok ? `${rB.cached ? "cached" : "fresh"}: ${rB.text}` : "");
check("prompt 含事件类型与规则词（超越参考不复读）", lastBody.includes("game_won") && lastBody.includes("真相大白") && lastBody.includes("25 字以内"));

// —— 场景 C：事件粒度缓存 ——
console.log("\n[场景 C] 缓存（同 match:seq 不重发）");
const rC = await callLLMCommentary(EV, mockFetch);
check("缓存命中 cached:true", rC.ok === true && rC.cached === true);
check("fetch 只被调一次", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
const rC2 = await callLLMCommentary({ ...EV, seq: 43 }, mockFetch);
check("不同 seq 不吃缓存（新调用）", rC2.ok === true && rC2.cached === false && fetchCalls === 2);

// —— 场景 D：env 每请求动态读 ——
console.log("\n[场景 D] env 动态读（不重启切供应商）");
delete process.env.LLM_BASE_URL;
clearLLMCache();
const rD = await callLLMCommentary({ ...EV, seq: 44 }, mockFetch);
check("运行时撤销配置立即生效（NOT_CONFIGURED）", rD.ok === false && rD.code === "LLM_NOT_CONFIGURED");
process.env.LLM_BASE_URL = "https://llm2.test/v1";
const rD2 = await callLLMCommentary({ ...EV, seq: 45 }, mockFetch);
check("运行时换供应商立即生效（新 baseUrl 被调）", rD2.ok === true && fetchCalls === 3);

// —— 场景 E：超时与上游错误 ——
console.log("\n[场景 E] 超时 / 上游 500 / 空 content");
clearLLMCache();
// mock 须响应 AbortSignal——真实 fetch 收到 abort 会抛 AbortError，mock 不理 signal 就测不出超时路径
const hangFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 3000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
  return new Response("{}", { status: 200 });
}) as typeof fetch;
const rE = await callLLMCommentary({ ...EV, seq: 50 }, hangFetch, 150);
check("挂起上游 → LLM_TIMEOUT", rE.ok === false && rE.code === "LLM_TIMEOUT");
const errFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
const rE2 = await callLLMCommentary({ ...EV, seq: 51 }, errFetch);
check("上游 500 → LLM_UPSTREAM（带状态码）", rE2.ok === false && rE2.code === "LLM_UPSTREAM" && rE2.message.includes("500"));
const emptyFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as typeof fetch;
const rE3 = await callLLMCommentary({ ...EV, seq: 52 }, emptyFetch);
check("空 content → LLM_UPSTREAM", rE3.ok === false && rE3.code === "LLM_UPSTREAM");

// —— 场景 F：入参校验 ——
console.log("\n[场景 F] BAD_INPUT");
const rF = await callLLMCommentary({ mid: "", seq: 1, type: "x", data: {}, ruleText: "" }, mockFetch);
check("缺 mid → BAD_INPUT", rF.ok === false && rF.code === "LLM_BAD_INPUT");

// 清理 env（防泄漏到同进程其他测试）
delete process.env.LLM_BASE_URL;
delete process.env.LLM_API_KEY;
delete process.env.LLM_MODEL;
clearLLMCache();

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
