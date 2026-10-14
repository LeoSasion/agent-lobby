// r26 E2E：词对库扩容（引擎级 smoke 已覆盖）+ 狼队密语（后端隔离+前端渲染）+ TV 卡解说位 + LLM 解说层
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
function assert(name, cond) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (cond) pass++; else { fail++; failures.push(name); }
}
const waitCond = async (fn, timeoutMs = 20000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { const v = fn(); if (v === true) return true; await sleep(200); }
  return fn() === true;
};

/* ════ Part A · 狼队密语（r26-b）════ */
console.log("════ Part A · 狼队密语 ════");
const j = async (r) => ({ status: r.status, body: await r.json() });

const qs = await fetch(`${BASE}/api/v1/lobby/quickstart`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ game: "werewolf_lite", seats: 6, name: "r26-e2e", timeout_ms: 15000 }),
}).then((r) => r.json());
assert("A0 quickstart 成局（6 席狼人杀）", !!qs.match_id && !!qs.seat_token);

// 驱动至终局：夜间 kill/check、白天 say/last_words、投票 vote（wolf_say 不提交——留 bot 演示）
let finished = false;
for (let i = 0; i < 400 && !finished; i++) {
  await sleep(300);
  const v = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/view`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
  if (v.phase === "finished") { finished = true; break; }
  if (!(v.you && v.you.active)) continue;
  const types = (v.legal_actions ?? []).map((a) => a.type);
  if (types.includes("kill")) {
    const kill = v.legal_actions.find((a) => a.type === "kill");
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "kill", target: kill.schema.values[0] } }),
    });
  } else if (types.includes("check")) {
    const check = v.legal_actions.find((a) => a.type === "check");
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "check", target: check.schema.values[0] } }),
    });
  } else if (types.includes("say") || types.includes("last_words")) {
    const t = types.includes("last_words") ? "last_words" : "say";
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: t, text: "我是好人，先听信息再投票。" } }),
    });
  } else if (types.includes("vote")) {
    const vote = v.legal_actions.find((a) => a.type === "vote");
    const target = vote.schema.values.find((t) => t !== v.you.seat) ?? vote.schema.values[0];
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "vote", target } }),
    });
  }
}
assert("A1 快局驱动至终局", finished);

const evSpec = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`).then((r) => r.json());
assert("A2 观战流零 wolf_said（密语不泄）", evSpec.events.filter((e) => e.type === "wolf_said").length === 0);
const gw = evSpec.events.find((e) => e.type === "game_won");
const myRole = (gw?.data?.roles ?? {})[String(qs.seat_id)];
const evMe = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
const myWolfSaid = evMe.events.filter((e) => e.type === "wolf_said");
assert("A3 狼视角见 bot 狼密语 / 好人视角零密语（按终局角色判）",
  myRole === "werewolf" ? myWolfSaid.length >= 1 : myWolfSaid.length === 0,
  `myRole=${myRole} · wolf_said×${myWolfSaid.length}`);

/* ════ Part B · 前端渲染（mock DOM：狼队密语 + TV 卡解说位 + LLM 层）════ */
console.log("════ Part B · 前端渲染 ════");
function mkEl() {
  const el = {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {}, _subs: {}, _cls: new Set(),
    querySelector(s) { el._subs[s] ??= mkEl(); return el._subs[s]; },
    querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 200, offsetTop: 0, offsetHeight: 20, offsetWidth: 10,
    onclick: null, addEventListener() {}, scrollIntoView() {},
  };
  el.classList = { add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); }, contains(c) { return el._cls.has(c); }, toggle() {} };
  return el;
}
const els = {};
globalThis.document = {
  querySelector: (s) => { els[s] ??= mkEl(); return els[s]; },
  querySelectorAll: () => [],
  getElementById: (id) => { els["#" + id] ??= mkEl(); return els["#" + id]; },
  addEventListener() {}, activeElement: { tagName: "BODY" },
};
globalThis.window = globalThis;
const realFetch = globalThis.fetch.bind(globalThis);
let llmCalls = 0;
globalThis.fetch = (u, o) => {
  const url = String(u);
  if (url.includes("/commentary/llm")) { llmCalls++; return Promise.resolve(new Response(JSON.stringify({ ok: true, text: "LLM 金句：刀光落定", cached: false }), { status: 200 })); }
  return realFetch(url.startsWith("/") ? BASE + url : url, o);
};
globalThis.EventSource = class { constructor() { this.onmessage = null; } close() {} addEventListener() {} };
globalThis.localStorage = { getItem: () => "1", setItem() {} };
const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);

new Function(js)();
await sleep(600);
const __r26 = globalThis.__r26 || {};
const { evText: evTextFn } = globalThis.__r24 || {};
const { pushCommentary, fireLLMCommentary, renderCommentary, LLM_CM, toggleLLMCM, commentate, WALL, ingestEvent, renderWall, renderWolf, renderActions } = __r26;

// B1 狼队密语面板：狼视角 priv.wolf_chat 渲染
const vWolfView = {
  game: "werewolf_lite", phase: "night", round: 2,
  public: { round: 2, phase: "night", seats: [1, 2, 3, 4, 5, 6], alive_seats: [1, 2, 3, 4, 5], today_says: [], last_day_says: [], pk_candidates: null },
  private: { role: "werewolf", alive: true, teammates: [5], wolf_chat: [{ seat: 5, text: "刀口示意：走 3 号——他跳了预言家" }] },
  you: { seat: 2, active: true },
  legal_actions: [
    { type: "kill", schema: { target: "enum", values: [3, 4] } },
    { type: "pass", hint: "空刀" },
    { type: "wolf_say", schema: { text: "string 1-500" }, hint: "狼队密语（仅狼可见，协调刀口）" },
  ],
};
const wBox = mkEl();
renderWolf(vWolfView, wBox, false);
assert("B1 狼视角夜间密语面板渲染", wBox.innerHTML.includes("狼队密语 · 本夜") && wBox.innerHTML.includes("刀口示意：走 3 号"));

// B2 密语动作区：wolf_say textarea（act-area 从 _subs 读）
const wBtn = mkEl();
renderWolf(vWolfView, wBtn, true);
const wAct = wBtn._subs[".act-area"]?.innerHTML ?? "";
assert("B2 动作区狼队密语输入（不占行动名额提示）", wAct.includes('id="wsay-text"') && wAct.includes("act({type:'wolf_say'"));

// B3 evText wolf_said（不泄密语正文给观战——但狼视角流里可见文本格式）
const eWs = evTextFn({ type: "wolf_said", data: { seat: 5, text: "刀口示意" } });
assert("B3 evText 狼队密语文本", eWs.includes("狼队密语") && eWs.includes("5号") && eWs.includes("仅狼可见"));

// B4 TV 卡解说位：renderWall 卡骨架含 .tvcm
WALL.live = [{ match_id: "m_t1", game: "werewolf_lite", seats: [1, 2, 3, 4, 5, 6] }];
WALL.views = {}; WALL.evs = {}; WALL.cm = {};
renderWall();
const wallHtml = els["#wall"].innerHTML;
assert("B4 TV 卡含解说位骨架（解说席就位）", wallHtml.includes('class="tvcm"') && wallHtml.includes("解说席就位"));

// B5 高光事件刷解说位（hot2 → ★ 琥珀）——mock getElementById 键带 # 前缀
els["#tv-m_t1"] = mkEl();
ingestEvent("m_t1", { seq: 9, type: "game_won", data: { winner: "good", roles: {} } });
const cmHtml = els["#tv-m_t1"]._subs[".tvcm"]?.innerHTML ?? "";
assert("B5 高光事件刷 TV 解说词（★ 琥珀）", cmHtml.includes("star h2") && /终局|阵营|狼/.test(cmHtml), cmHtml.slice(0, 80));

// B6 低热度事件不刷解说位
WALL.cm = {};
els["#tv-m_t1"]._subs[".tvcm"].innerHTML = "";
ingestEvent("m_t1", { seq: 10, type: "phase_started", data: { phase: "day_discuss", round: 2 } });
const cmHtml2 = els["#tv-m_t1"]._subs[".tvcm"]?.innerHTML ?? "";
assert("B6 低热度事件不刷解说位", !cmHtml2.includes("star h2"));

// B7 LLM 层：开关默认开（localStorage mock=1）、高光 fire → 金句替换
assert("B7a LLM 开关默认读 localStorage", LLM_CM.on === true);
LLM_CM.hits = 0;
globalThis.CM = globalThis.CM || {};
const CMRef = globalThis.__r26; // pushCommentary 内部引用模块级 CM（闭包不可达）——经 fireLLM 后从渲染结果验证
// 构造解说流：pushCommentary 走规则词
pushCommentary({ seq: 100, type: "game_won", data: { winner: "good" } }, true);
await sleep(400);
const cmPanel = els["#m-cm"].innerHTML;
assert("B7b LLM 金句替换规则词（AI 缀）", cmPanel.includes("LLM 金句：刀光落定") && llmCalls >= 1, `llmCalls=${llmCalls}`);
assert("B7c 开关钮渲染（AI 解说 · 开）", cmPanel.includes("AI 解说 · 开"));

// B8 toggle 开关翻转
toggleLLMCM();
assert("B8 toggle 翻转关", LLM_CM.on === false);
toggleLLMCM();

// B9 hot<2 不触发 LLM（fireLLM 早退）
const before = llmCalls;
await fireLLMCommentary({ seq: 101, type: "phase_started", data: { phase: "night" } }, 0);
await sleep(200);
assert("B9 hot<2 不触发 LLM 调用", llmCalls === before);

// B10 非高光事件 commentate null——pushCommentary 不入流也不 fire
const evNBefore = llmCalls;
pushCommentary({ seq: 102, type: "acted", data: { seat: 1, action: { type: "pass" } } }, true);
await sleep(200);
assert("B10 私有/哑事件不触发 LLM", llmCalls === evNBefore);

/* ════ Part C · LLM 网关契约（未配置回退）════ */
console.log("════ Part C · LLM 网关契约 ════");
const rC1 = await j(await realFetch(`${BASE}/api/v1/commentary/llm`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ mid: "m_x", seq: 1, type: "game_won", data: {}, rule_text: "x" }),
}));
assert("C1 未配置 → 503 错误体规范", rC1.status === 503 && rC1.body.error === "LLM_NOT_CONFIGURED" && typeof rC1.body.message === "string");
const rC2 = await j(await realFetch(`${BASE}/api/v1/commentary/llm`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ seq: 1, type: "x" }),
}));
assert("C2 缺 mid → 422 BAD_INPUT", rC2.status === 422 && rC2.body.code === "LLM_BAD_INPUT");

console.log(`\n════ r26 E2E 结果：${pass} 通过 · ${fail} 失败 ════`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
process.exit(0);
