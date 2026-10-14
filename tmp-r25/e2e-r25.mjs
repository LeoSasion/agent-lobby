// r25 E2E：谁是卧底全链路——引擎词典单元 + 后端集成（驱动快局/竞猜卧底语义/Elo）+ 前端渲染
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

/* ════ Part A · 解说词典单元（undercover 分支）════ */
console.log("════ Part A · 解说引擎词典（undercover）════");
{
  const m = js.match(/function commentate\(e\) \{[\s\S]*?\n\}/);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CM_PRIVATE = new Set(["night_kill_decided", "checked", "acted", "said", "match_started_private", "word_assigned"]);
  const commentate = new Function("esc", "CM_PRIVATE", m[0] + "; return commentate;")(esc, CM_PRIVATE);
  const cases = [
    // player_exiled 分档：卧底被揪出=hot2 / 平民被误逐=hot1
    ["player_exiled", { seat: 4, role: "undercover", was_undercover: true }, 2],
    ["player_exiled", { seat: 2, role: "civilian", was_undercover: false }, 1],
    // game_won：civilians/undercover 均 hot2（词对揭晓）
    ["game_won", { winner: "civilians", roles: {}, word_pair: { civilian: "苹果", undercover: "梨" }, reason: "卧底被揪出" }, 2],
    ["game_won", { winner: "undercover", roles: {}, word_pair: { civilian: "苹果", undercover: "梨" }, reason: "卧底存活到最后" }, 2],
    // described=克制（描述原文自展） / word_assigned=私有 / 狼人语义共存不回归
    ["described", { seat: 3, text: "跟吃的有关", round: 1 }, null],
    ["word_assigned", { seat: 3, word: "苹果", round: 1 }, null],
    ["game_won", { winner: "good" }, 2],
    ["game_won", { winner: "wolves" }, 2],
  ];
  let ok = 0;
  for (const [type, data, hot] of cases) {
    const r = commentate({ type, data });
    if (hot === null ? r === null : r && r.hot === hot && !/[A-Za-z]{3,}/.test(r.t.replace(/[（）：，。！？·—\s\d]/g, ""))) ok++;
    else console.log("    用例失败:", type, JSON.stringify(data), "→", JSON.stringify(r));
  }
  assert(`A1 词典用例 ${ok}/${cases.length}（分档正确+全中文）`, ok === cases.length);
  const t1 = commentate({ type: "player_exiled", data: { seat: 4, was_undercover: true } });
  assert("A2 揪出卧底解说含席位", t1.t.includes("4 号") && t1.t.includes("卧底"));
  const t2 = commentate({ type: "game_won", data: { winner: "civilians", word_pair: { civilian: "苹果", undercover: "梨" } } });
  assert("A3 终局解说含词对揭晓", t2.t.includes("苹果") && t2.t.includes("梨"));
}

/* ════ Part B · 后端集成：驱动快局 → 事件/竞猜/Elo ════ */
console.log("════ Part B · 后端集成 ════");
const j = async (r) => ({ status: r.status, body: await r.json() });

// B0 quickstart（我 1 席 + 5 house bot）
const qs = await fetch(`${BASE}/api/v1/lobby/quickstart`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ game: "undercover", seats: 6, name: "r25-e2e" }),
}).then((r) => r.json());
assert("B0 quickstart 成局（6 席）", !!qs.match_id && !!qs.seat_token);

// B1 进行中竞猜可投（卧底语义：猜卧底席位）
const gVote = await j(await fetch(`${BASE}/api/v1/matches/${qs.match_id}/guess`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ voter_id: "r25-v1", seat: qs.seat_id }),
}));
assert("B1 进行中竞猜可投（卧底席位语义）", gVote.status === 200 && gVote.body.ok === true && gVote.body.mine === qs.seat_id);

// B2 驱动至终局：describe 万金油句（不含词库任何词）+ vote 投池内首个非我目标 + 已投防重复
const DESC_POOL = ["这东西生活中常见", "大家应该都见过", "跟日常作息有关", "算是个常见的物件"];
let di = 0, finished = false;
for (let i = 0; i < 400 && !finished; i++) {
  await sleep(300);
  const v = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/view`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
  if (v.phase === "finished") { finished = true; break; }
  if (!(v.you && v.you.active)) continue;
  const types = (v.legal_actions ?? []).map((a) => a.type);
  if (types.includes("describe")) {
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "describe", text: DESC_POOL[di++ % DESC_POOL.length] } }),
    });
  } else if (types.includes("vote")) {
    const already = (v.public.votes_cast ?? []).includes(v.you.seat);
    if (already) continue;
    const vote = v.legal_actions.find((a) => a.type === "vote");
    const pool = vote.schema.values;
    const target = pool.find((t) => t !== v.you.seat) ?? pool[0];
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "vote", target } }),
    });
  }
}
assert("B2 快局驱动至终局", finished);

// B3 信息隔离：观战流零 word_assigned；带 token 恰 1 条（seat=我）
const evSpec = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`).then((r) => r.json());
assert("B3a 观战流零 word_assigned（词不泄）", evSpec.events.filter((e) => e.type === "word_assigned").length === 0);
const evMe = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
const myWa = evMe.events.filter((e) => e.type === "word_assigned");
assert("B3b 带本席 token 恰见自己的发词", myWa.length === 1 && myWa[0].data.seat === qs.seat_id && typeof myWa[0].data.word === "string");

const descs = evSpec.events.filter((e) => e.type === "described");
assert("B4 described 公开在场（含 bot 描述）", descs.length >= 12 && descs.every((e) => e.visibility === undefined || e.visibility === "all"));

const gw = evSpec.events.find((e) => e.type === "game_won");
assert("B5 game_won 含 roles/word_pair/winner", !!gw && !!gw.data.roles && !!gw.data.word_pair
  && (gw.data.winner === "civilians" || gw.data.winner === "undercover"));
// 卧底席位反查（B7 竞猜 targets 交叉验证用）
const ucSeat = Number(Object.entries(gw.data.roles).find(([, r]) => r === "undercover")?.[0] ?? -1);

// B6 放逐链一致性：平民胜 ⇒ 必有「揪出卧底」的 player_exiled；卧底胜 ⇒ 所有放逐者均平民（或无放逐）
const exiles = evSpec.events.filter((e) => e.type === "player_exiled");
assert("B6 放逐亮身份链一致",
  gw.data.winner === "civilians"
    ? exiles.some((e) => e.data.was_undercover === true)
    : exiles.every((e) => e.data.was_undercover === false));

// B7 竞猜 reveal：locked + targets=卧底席位 + mine_hit
const gRev = await j(await fetch(`${BASE}/api/v1/matches/${qs.match_id}/guess?voter_id=r25-v1`));
assert("B7 终局 reveal targets=卧底席位", gRev.body.locked === true && Array.isArray(gRev.body.targets)
  && gRev.body.targets.length === 1 && gRev.body.targets[0] === ucSeat && typeof gRev.body.mine_hit === "boolean");

// B8 Elo 榜单接线
const lb = await fetch(`${BASE}/api/v1/leaderboard/undercover`).then((r) => r.json());
assert("B8 undercover Elo 榜单已接线", (lb.leaderboard ?? []).length >= 2);

// B9 终局 legal_actions 空
const vNow = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/view`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
assert("B9 终局后 legal_actions 空", (vNow.legal_actions ?? []).length === 0 && vNow.phase === "finished");

// B10 match_ended scores 阵营口径（0/1，胜方阵营全员 1）
const me = evSpec.events.find((e) => e.type === "match_ended");
const scoreVals = Object.values(me.data.scores);
const winnersN = gw.data.winner === "civilians" ? 5 : 1;
assert("B10 scores 阵营口径（胜方阵营恰 N 人得 1）",
  scoreVals.every((x) => x === 0 || x === 1) && scoreVals.filter((x) => x === 1).length === winnersN);

/* ════ Part C · 前端渲染（mock DOM）════ */
console.log("════ Part C · 前端渲染 ════");
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
globalThis.localStorage = { getItem: () => null, setItem() {} };
const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);

new Function(js)();
await sleep(600);

const { renderUndercover, miniStageInner, viewStats, evText, GAME_DESC, SEATS_DEFAULT } = globalThis.__r24 || {};
const vView = {
  game: "undercover", phase: "vote", round: 2,
  public: {
    seats: [1, 2, 3, 4, 5, 6], alive_seats: [1, 2, 3, 5, 6], phase: "vote", round: 2, max_rounds: 3,
    today_describes: [
      { seat: 1, text: "这东西生活中常见" }, { seat: 2, text: "跟吃的有关" },
      { seat: 3, text: "我想想……树上长的" }, { seat: 5, text: "水果摊上常见" }, { seat: 6, text: "甜的" },
    ],
    exiled_log: [{ seat: 4, role: "civilian" }],
    pk_candidates: null, votes_cast: [1, 2], pending_voters: [3, 5, 6],
  },
  private: { word: "梨", is_undercover: true, alive: true },
  you: { seat: 1, active: true },
  legal_actions: [
    { type: "vote", schema: { target: "enum", values: [2, 3, 5, 6] }, hint: "" },
    { type: "pass", hint: "弃票" },
  ],
};
const box = mkEl();
renderUndercover(vView, box, false);
const uh = box.innerHTML;
assert("C1 词语圆桌：席位环 6 席 + 轮次 hub", (uh.match(/class="wseat/g) || []).length === 6 && uh.includes("第 2/3 轮") && uh.includes("存活 5 / 6"));
assert("C2 描述流渲染（5 条 today_describes）", uh.includes("本轮描述") && uh.includes("水果摊上常见") && (uh.match(/class="say"/g) || []).length === 5);
assert("C3 投票进度 ticks（2/5 已投）", uh.includes("放逐投票") && uh.includes("待投 3 人") && uh.includes('class="ticks"'));
assert("C4 放逐者 dead 类 + 亮身份平民标签", uh.includes("wseat dead") && uh.includes("· 平民"));
assert("C5 我的词卡：卧底红字提示", uh.includes("我的词") && uh.includes("梨") && uh.includes("你是卧底"));

// C6 平民视角词卡（is_undercover=false）
const vCiv = JSON.parse(JSON.stringify(vView));
vCiv.private = { word: "苹果", is_undercover: false, alive: true };
const box6 = mkEl();
renderUndercover(vCiv, box6, false);
assert("C6 平民词卡：「词与多数人相同」", box6.innerHTML.includes("苹果") && box6.innerHTML.includes("词与多数人相同") && !box6.innerHTML.includes("你是卧底"));

// C7 PK 候选行
const vPk = JSON.parse(JSON.stringify(vView));
vPk.public.pk_candidates = [2, 6];
const box7 = mkEl();
renderUndercover(vPk, box7, false);
assert("C7 平票 PK 候选行渲染", box7.innerHTML.includes("平票 PK") && box7.innerHTML.includes("候选 2、6 号"));

// C8 动作区：vote 按钮池 + 弃票（r16 纪律：act-area 从 _subs 缓存读）
const btnBox = mkEl();
renderUndercover(vView, btnBox, true);
const actHTML = btnBox._subs[".act-area"]?.innerHTML ?? "";
assert("C8 动作区放逐按钮池 + 弃票", actHTML.includes("act({type:'vote',target:2})") && actHTML.includes("act({type:'vote',target:6})") && actHTML.includes("act({type:'pass'})"));

// C9 describe 阶段动作区
const vDesc = JSON.parse(JSON.stringify(vView));
vDesc.phase = "describe";
vDesc.legal_actions = [{ type: "describe", schema: { text: "string 1-120" }, hint: "" }];
const box9 = mkEl();
renderUndercover(vDesc, box9, true);
const act9 = box9._subs[".act-area"]?.innerHTML ?? "";
assert("C9 描述动作区 textarea + 描述按钮", act9.includes('id="desc-text"') && act9.includes("act({type:'describe'"));

// C10 mini 舞台：词 orb + 席位环（放逐红点 ucx）+ 存活 hub
const mini = miniStageInner({ game: "undercover" }, vView);
assert("C10 mini 舞台：词字 orb + 放逐红点 + 轮次", mini.includes(">词</text>") && mini.includes("msd ucx") && mini.includes("存活 · 第 2/3 轮"));

// C11 直播墙卡 stats
const st = viewStats({ game: "undercover" }, vView);
assert("C11 直播墙卡 meta/stats（6 席 + 存活）", st.meta.includes("6 席") && st.stats.some(([lb]) => lb === "存活") && st.stats[0][1] === "5/6");

// C12 事件文本词典
const eT1 = evText({ type: "described", data: { seat: 3, text: "跟吃的有关" } });
assert("C12a evText：描述事件", eT1.includes("3号描述") && eT1.includes("跟吃的有关"));
const eT2 = evText({ type: "player_exiled", data: { seat: 4, was_undercover: false } });
assert("C12b evText：放逐亮身份", eT2.includes("4号被放逐") && eT2.includes("平民"));
const eT3 = evText({ type: "vote_pk", data: { candidates: [2, 6] } });
assert("C12c evText：平票 PK", eT3.includes("平票 PK") && eT3.includes("2、6"));
const eT4 = evText({ type: "word_assigned", data: { seat: 1, word: "苹果" } });
assert("C12d evText：发词私有化（不泄词）", eT4.includes("【发词】") && !eT4.includes("苹果"));

// C13 常量表接线
assert("C13 常量表接线（desc/seats）", GAME_DESC.undercover.includes("词语推理") && SEATS_DEFAULT.undercover === 6);

console.log(`\n════ r25 E2E 结果：${pass} 通过 · ${fail} 失败 ════`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
process.exit(0);
