// r27 E2E：undercover PK 两轮制渲染 + 大厅级金句轮播带 + r27-e 幻影遗言 live 回归 + 狼队密语 5 条上限（live）
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
function assert(name, cond, detail = "") {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (detail ? ` — ${detail}` : ""));
  if (cond) pass++; else { fail++; failures.push(name); }
}
const waitCond = async (fn, timeoutMs = 20000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { const v = fn(); if (v === true) return true; await sleep(200); }
  return fn() === true;
};

/* ════ Part A · r27-e 幻影遗言 live 回归（新网关 · 真实 bot 局）════ */
console.log("════ Part A · r27-e 幻影遗言 live 回归 ════");
const qs = await fetch(`${BASE}/api/v1/lobby/quickstart`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ game: "werewolf_lite", seats: 6, name: "r27-e2e", timeout_ms: 15000 }),
}).then((r) => r.json());
assert("A0 quickstart 成局", !!qs.match_id && !!qs.seat_token);

// 驱动至终局（与 r26 A 同法；r27-e 后已交夜间行动者法表清空——driver 靠 you.active 门控自然跳过）
let finished = false;
for (let i = 0; i < 500 && !finished; i++) {
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
const evs = evSpec.events ?? [];
// A2 幻影指纹①：last_words 恒非空文本（幻影=陈旧动作无 text 字段）
const emptyLw = evs.filter((e) => e.type === "last_words" && String(e.data?.text ?? "").length === 0);
assert("A2 遗言恒非空文本（幻影遗言零出现）", emptyLw.length === 0, `last_words×${evs.filter((e) => e.type === "last_words").length} · 空×${emptyLw.length}`);
// A3 幻影指纹②：夜亡者（对局继续时）遗言不被吞
let silenced = 0, nightVictims = 0;
for (let i = 0; i < evs.length; i++) {
  const e = evs[i];
  if (e.type !== "player_died" || e.data?.cause !== "night") continue;
  nightVictims++;
  const dayFollows = evs.slice(i).some((x) => x.type === "phase_started" && x.data?.phase === "day_discuss");
  if (!dayFollows) continue; // 当夜终局（狼达平价）——遗言可合法缺席
  if (!evs.some((x) => x.type === "last_words" && x.data?.seat === e.data.seat)) silenced++;
}
assert("A3 夜亡者遗言不被吞", silenced === 0, `夜亡 ${nightVictims} 人 · 被吞 ${silenced}`);
// A4 幻影指纹③：验人动作不泄露（我的流里 check acted 只能是我自己的）
const evMe = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
const badCheck = (evMe.events ?? []).filter((e) => e.type === "acted" && e.data?.action?.type === "check" && e.data.seat !== qs.seat_id);
assert("A4 验人动作零泄露（可见性批次快照）", badCheck.length === 0, `泄露 ×${badCheck.length}`);

/* ════ Part B · undercover PK 两轮制渲染（mock DOM）════ */
console.log("════ Part B · undercover PK 两轮制渲染 ════");
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
globalThis.fetch = (u, o) => realFetch(String(u).startsWith("/") ? BASE + String(u) : u, o);
globalThis.EventSource = class { constructor() { this.onmessage = null; } close() {} addEventListener() {} };
globalThis.localStorage = { getItem: () => "0", setItem() {} };
const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);

new Function(js)();
await sleep(600);
const __r27 = globalThis.__r27 || {};
const { pushQuote, renderQuote, startQuoteLoop, CMQ, commentate, evText, renderUndercover } = __r27;
const { WALL, ingestEvent } = globalThis.__r26 || {};

// B1 evText：vote_pk 带 pk_round → 「第 N 轮」；不带（狼人杀旧形状）→ 无轮次缀
const tPk2 = evText({ type: "vote_pk", data: { pk_round: 2, candidates: [2, 6] } });
assert("B1a evText vote_pk 第 2 轮", tPk2.includes("第 2 轮") && tPk2.includes("2、6"));
const tPkW = evText({ type: "vote_pk", data: { candidates: [2, 6] } });
assert("B1b evText vote_pk 无 pk_round 不显轮次（狼人杀兼容）", tPkW.includes("平票 PK！") && !tPkW.includes("第"));

// B2 解说词典：pk_round 2 → hot2 终极 PK；pk_round 1 → hot1 重投
const cm2 = commentate({ type: "vote_pk", data: { pk_round: 2, candidates: [2, 6] } });
const cm1 = commentate({ type: "vote_pk", data: { pk_round: 1, candidates: [2, 6] } });
assert("B2a 解说 PK2 升 hot2", cm2 && cm2.hot === 2 && cm2.t.includes("终极 PK"));
assert("B2b 解说 PK1 保持 hot1", cm1 && cm1.hot === 1 && cm1.t.includes("重投"));

// B3 renderUndercover：pk_round=2 显「再平无人出局」警示；=1 旧形状纯候选行
const mkUCView = (pkRound) => ({
  game: "undercover", phase: "vote", round: 1,
  public: {
    round: 1, phase: "vote", seats: [1, 2, 3, 4, 5, 6], alive_seats: [1, 2, 3, 4, 5, 6],
    today_describes: [], exiled_log: [], pk_candidates: [2, 6], pk_round: pkRound, max_rounds: 3,
    votes_cast: [3], pending_voters: [1, 2, 4, 5, 6],
  },
  private: { word: "苹果", is_undercover: false, alive: true },
  you: { seat: 1, active: true },
  legal_actions: [{ type: "vote", schema: { target: "enum", values: [2, 6] } }, { type: "pass", hint: "弃票" }],
});
const ucBox2 = mkEl();
renderUndercover(mkUCView(2), ucBox2, false);
assert("B3a PK2 渲染警示「再平无人出局」", ucBox2.innerHTML.includes("再平无人出局") && ucBox2.innerHTML.includes("候选 2、6 号"));
const ucBox1 = mkEl();
renderUndercover(mkUCView(1), ucBox1, false);
assert("B3b PK1 纯候选行（无警示）", ucBox1.innerHTML.includes("候选 2、6 号") && !ucBox1.innerHTML.includes("再平无人出局"));

/* ════ Part C · r27-b 金句频道轮播带（mock DOM）════ */
console.log("════ Part C · 金句频道轮播带 ════");
// 复位：boot 期 loadLobby→updateTicker 会摄取真实直播桌的历史高光（game_won 等）——先清场
CMQ.items.length = 0;
CMQ.cursor = 0;
// C1 空队列渲染暖场文案
renderQuote();
assert("C1 空队列渲染暖场文案（等待高光）", els["#cmq-body"].innerHTML.includes("等待今夜第一句高光"));
// C2 pushQuote → .qrow 渲染（★ + 金句 + 出处 + 跳桌 onclick）
WALL.live = [{ match_id: "m_t1", game: "werewolf_lite", seats: [1, 2, 3, 4, 5, 6] }];
pushQuote("m_t1", "计票落定——6 号被放逐出局，身份揭晓");
const q1 = els["#cmq-body"].innerHTML;
assert("C2 金句行渲染（★ 金句 + 出处 + 跳桌）",
  q1.includes('class="qrow') && q1.includes("★") && q1.includes("计票落定") && q1.includes("狼人杀") && q1.includes("gotoMatch('m_t1')"), q1.slice(0, 90));
assert("C2b 单句不显序号", els["#cmq-n"].textContent === "");
// C3 同桌同句去抖
pushQuote("m_t1", "计票落定——6 号被放逐出局，身份揭晓");
assert("C3 同句去抖", CMQ.items.length === 1);
// C4 三句 → cursor 置顶最新；序号 1/3
pushQuote("m_t2", "开盒对质！实际只有 2 个——3 号一击致命");
pushQuote("m_t3", "二次平票！2、6 号终极 PK");
assert("C4 新句插队置顶 + 序号 1/3", CMQ.items.length === 3 && CMQ.cursor === 0 && els["#cmq-n"].textContent === "1/3");
// C5 轮播推进（手动驱动 4200ms 定时器 ×2 → 2/3 → 3/3）
startQuoteLoop();
const qTimer = [...timers.values()].find((t) => t.ms === 4200);
assert("C5a 轮播定时器注册（4.2s）", !!qTimer);
if (qTimer) { qTimer.f(); qTimer.f(); }
assert("C5b 轮播环回推进 3/3", CMQ.cursor === 2 && els["#cmq-n"].textContent === "3/3");
// C6 环回：再推进 → 回到 1/3
if (qTimer) qTimer.f();
assert("C6 环回到顶 1/3", CMQ.cursor === 0 && els["#cmq-n"].textContent === "1/3");
// C7 容量上限 12
for (let i = 0; i < 15; i++) pushQuote("m_cap" + i, "金句容量压测第 " + i + " 句");
assert("C7 容量上限 12", CMQ.items.length === 12);
// C8 ingestEvent 集成：hot≥2 事件自动入频道（先清场——C7 已顶到容量上限）
CMQ.items.length = 0;
const lenBefore = CMQ.items.length;
ingestEvent("m_t1", { seq: 99, type: "challenge_resolved", data: { bid_was_true: false, actual_count: 2, challenger: 4, challenged_bid: { seat: 2, qty: 5, face: 3 } } });
assert("C8 高光事件自动入频道（hot≥2）", CMQ.items.length === lenBefore + 1 && CMQ.items[0].txt.includes("一击致命"));
// C9 hot1 事件不入频道
const lenB2 = CMQ.items.length;
ingestEvent("m_t1", { seq: 100, type: "last_words", data: { seat: 3, text: "遗言" } });
assert("C9 hot1 不入频道（金句线 hot≥2）", CMQ.items.length === lenB2);

/* ════ Part D · 狼队密语 5 条上限（live · 我是狼）════ */
console.log("════ Part D · 狼队密语 5 条上限（live）════");
let qsW = null;
for (let i = 0; i < 10 && !qsW; i++) {
  const q = await fetch(`${BASE}/api/v1/lobby/quickstart`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ game: "werewolf_lite", seats: 6, name: "r27-e2e-wolf", timeout_ms: 60000 }),
  }).then((r) => r.json());
  const v = await fetch(`${BASE}/api/v1/matches/${q.match_id}/view`, { headers: { "x-seat-token": q.seat_token } }).then((r) => r.json());
  if (v.private?.role === "werewolf") qsW = { ...q, role: v.private.role };
}
assert("D0 抽到狼席位", !!qsW);
if (qsW) {
  // 夜间逐条发密语：每条占一个 step（minPhaseMs=4s 间隙后 received 清空才能发下一条）
  const post = (action) => fetch(`${BASE}/api/v1/matches/${qsW.match_id}/actions`, {
    method: "POST", headers: { "content-type": "application/json", "x-seat-token": qsW.seat_token },
    body: JSON.stringify({ action }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  let accepted = 0;
  for (let i = 1; i <= 5; i++) {
    let ok = false;
    for (let t = 0; t < 12 && !ok; t++) {
      const r = await post({ type: "wolf_say", text: `密语上限测试第 ${i} 条——刀口听队友的。` });
      if (r.status === 200 && r.body.ok === true) { ok = true; accepted++; }
      else if (r.status === 422 && String(r.body.code ?? "") === "DUPLICATE_ACTION") await sleep(4600); // 同 turn 未结算——等间隙
      else break; // 永久拒绝（非法/上限）——不重试
    }
    if (!ok) break;
    await sleep(4600); // 等本条入账、received 清空
  }
  assert("D1 前 5 条密语全部入账", accepted >= 5, `accepted=${accepted}`);
  const r6 = await post({ type: "wolf_say", text: "第 6 条应该被上限拒绝" });
  assert("D2 第 6 条被拒（ILLEGAL_ACTION 上限）",
    r6.status === 422 && String(r6.body.code ?? "") === "ILLEGAL_ACTION" && String(r6.body.message ?? "").includes("上限"),
    `status=${r6.status} code=${String(r6.body?.code ?? "")} msg=${String(r6.body?.message ?? "").slice(0, 40)}`);
}

console.log(`\n════ r27 E2E 结果：${pass} 通过 · ${fail} 失败 ════`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
process.exit(0);
