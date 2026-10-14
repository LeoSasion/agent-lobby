// r24 E2E：囚徒困境·迭代赛全链路——引擎词典单元 + 后端集成（驱动快局/竞猜/Elo）+ 前端渲染
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

/* ════ Part A · 解说词典单元（dilemma 分支）════ */
console.log("════ Part A · 解说引擎词典（dilemma）════");
{
  const m = js.match(/function commentate\(e\) \{[\s\S]*?\n\}/);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CM_PRIVATE = new Set(["night_kill_decided", "checked", "acted", "said", "match_started_private"]);
  const commentate = new Function("esc", "CM_PRIVATE", m[0] + "; return commentate;")(esc, CM_PRIVATE);
  const cases = [
    // round_resolved 分档：CC=hot0 / DD=hot1 / CD/DC=hot2 / is_final=hot2
    ["round_resolved", { round: 3, pattern: "CC", choices: { 1: "cooperate", 2: "cooperate" }, payoff: { 1: 3, 2: 3 } }, 0],
    ["round_resolved", { round: 4, pattern: "DD", choices: { 1: "betray", 2: "betray" }, payoff: { 1: 1, 2: 1 } }, 1],
    ["round_resolved", { round: 5, pattern: "CD", choices: { 1: "cooperate", 2: "betray" }, payoff: { 1: 0, 2: 5 } }, 2],
    ["round_resolved", { round: 6, pattern: "DC", choices: { 1: "betray", 2: "cooperate" }, payoff: { 1: 5, 2: 0 } }, 2],
    ["round_resolved", { round: 10, pattern: "CC", choices: { 1: "cooperate", 2: "cooperate" }, payoff: { 1: 3, 2: 3 }, is_final: true }, 2],
    // game_won：席位号胜=hot2 / draw=hot1 / 狼人语义共存=hot2
    ["game_won", { winner: 1, totals: { 1: 28, 2: 23 } }, 2],
    ["game_won", { winner: "draw", totals: { 1: 30, 2: 30 } }, 1],
    ["game_won", { winner: "good" }, 2],
    ["game_won", { winner: "wolves" }, 2],
    // 私有防御
    ["acted", { seat: 1, action: { type: "move", choice: "betray" } }, null],
  ];
  let ok = 0;
  for (const [type, data, hot] of cases) {
    const r = commentate({ type, data });
    if (hot === null ? r === null : r && r.hot === hot && !/[A-Za-z]{3,}/.test(r.t.replace(/[（）：，。！？·—\s\d]/g, ""))) ok++;
    else console.log("    用例失败:", type, JSON.stringify(data), "→", JSON.stringify(r));
  }
  assert(`A1 词典用例 ${ok}/${cases.length}（分档正确+全中文）`, ok === cases.length);
  const t1 = commentate({ type: "round_resolved", data: { round: 5, pattern: "CD", choices: { 1: "cooperate", 2: "betray" } } });
  assert("A2 背叛解说含背叛者席位", t1.t.includes("2 号突然背叛"));
  const t2 = commentate({ type: "game_won", data: { winner: 1, totals: { 1: 28, 2: 23 } } });
  assert("A3 终局解说含总收益", t2.t.includes("28") && t2.t.includes("23"));
}

/* ════ Part B · 后端集成：驱动快局 → 事件/竞猜/Elo ════ */
console.log("════ Part B · 后端集成 ════");
const j = async (r) => ({ status: r.status, body: await r.json() });

// B0 驱动快局（guest 交替 C/D 制造叙事，bot TFT 回敬）
const qs = await fetch(`${BASE}/api/v1/lobby/quickstart`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ game: "dilemma", seats: 2, name: "r24-e2e" }),
}).then((r) => r.json());
assert("B0 quickstart 成局", !!qs.match_id && !!qs.seat_token);

// 竞猜须在进行中投（r21 语义：changed 仅表示改票——首次投 changed:false）
const gVote = await j(await fetch(`${BASE}/api/v1/matches/${qs.match_id}/guess`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ voter_id: "r24-v1", seat: qs.seat_id }),
}));
assert("B1 进行中竞猜可投（通用胜者语义）", gVote.status === 200 && gVote.body.ok === true && gVote.body.mine === qs.seat_id);

// 驱动至终局
let finished = false;
for (let i = 0; i < 150 && !finished; i++) {
  await sleep(300);
  const v = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/view`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
  if (v.phase === "finished") { finished = true; break; }
  if (v.you && v.you.active) {
    const choice = ((v.public.history ?? []).length) % 2 === 0 ? "cooperate" : "betray";
    await fetch(`${BASE}/api/v1/matches/${qs.match_id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-seat-token": qs.seat_token },
      body: JSON.stringify({ action: { type: "move", choice } }),
    });
  }
}
assert("B2 快局驱动至终局", finished);

const ev = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`).then((r) => r.json());
const rr = ev.events.filter((e) => e.type === "round_resolved");
assert("B3 恰 10 个 round_resolved", rr.length === 10);
assert("B4 首轮 round_started 入流（initialEvents 钩子）", ev.events.some((e) => e.type === "round_started" && e.data.round === 1));
assert("B5 观战流零 acted（私有可见性）", ev.events.filter((e) => e.type === "acted").length === 0);
const gw = ev.events.find((e) => e.type === "game_won");
assert("B6 game_won 含 totals 与 rounds_played", gw.data.rounds_played === 10 && typeof gw.data.totals === "object");
const me = ev.events.find((e) => e.type === "match_ended");
assert("B7 match_ended scores 胜负口径（1/0 或 0.5 平局）", Object.values(me.data.scores).every((x) => x === 1 || x === 0 || x === 0.5));
assert("B8 round_resolved 事件含 pattern/choices/payoff/totals", ["pattern", "choices", "payoff", "totals"].every((k) => k in rr[0].data));

// 竞猜 reveal
const gRev = await j(await fetch(`${BASE}/api/v1/matches/${qs.match_id}/guess?voter_id=r24-v1`));
assert("B9 终局 reveal targets=胜者（或平局双中）", gRev.body.locked === true && Array.isArray(gRev.body.targets) && gRev.body.targets.length >= 1);
assert("B10 reveal 含 mine_hit", typeof gRev.body.mine_hit === "boolean");

// 榜单
const lb = await fetch(`${BASE}/api/v1/leaderboard/dilemma`).then((r) => r.json());
assert("B11 dilemma Elo 榜单已接线", (lb.leaderboard ?? []).length >= 2);

// 重复提交防线
const vNow = await fetch(`${BASE}/api/v1/matches/${qs.match_id}/view`).then((r) => r.json());
assert("B12 终局后 legal_actions 空", (vNow.legal_actions ?? []).length === 0 && vNow.phase === "finished");

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

const { renderDilemma, miniStageInner, viewStats, evText, GAME_DESC, SEATS_DEFAULT } = globalThis.__r24 || {};
const vView = {
  game: "dilemma", phase: "playing", round: 4,
  public: {
    seats: [1, 2], round: 4, total_rounds: 10, phase: "playing",
    totals: { 1: 12, 2: 9 },
    history: [
      { round: 1, choices: { 1: "cooperate", 2: "cooperate" }, payoff: { 1: 3, 2: 3 }, totals: { 1: 3, 2: 3 } },
      { round: 2, choices: { 1: "betray", 2: "cooperate" }, payoff: { 1: 5, 2: 0 }, totals: { 1: 8, 2: 3 } },
      { round: 3, choices: { 1: "cooperate", 2: "betray" }, payoff: { 1: 0, 2: 5 }, totals: { 1: 8, 2: 8 } },
      { round: 4, choices: { 1: "cooperate", 2: "cooperate" }, payoff: { 1: 4, 2: 1 }, totals: { 1: 12, 2: 9 } },
    ],
    submitted_seats: [2], payoff_matrix: { T: 5, R: 3, P: 1, S: 0 },
  },
  private: { my_choice_this_round: "cooperate" },
  you: { seat: 1, active: true },
  legal_actions: [{ type: "move", schema: { choice: "enum", values: ["cooperate", "betray"] }, hint: "" }],
};
const box = mkEl();
renderDilemma(vView, box, false);
const dh = box.innerHTML;
assert("C1 对峙长桌：双方总分渲染", dh.includes("12") && dh.includes("9") && dh.includes("dm-duel"));
assert("C2 收益矩阵在场且含 T/R 值", dh.includes("dm-matrix") && dh.includes(">5<") && dh.includes(">3<"));
assert("C3 上轮格子琥珀高亮（CC）", dh.includes("mx hot"));
assert("C4 轮次轨迹带渲染 4 轮", (dh.match(/class="dm-r /g) || []).length === 4);
assert("C5 背叛徽章琥珀红类", dh.includes("dm-b bt"));
assert("C6 私有回显（本轮已提交·合作）", dh.includes("本轮已提交") && dh.includes("合 作"));

const mini = miniStageInner({ game: "dilemma" }, vView);
assert("C7 mini 舞台：双列轮次标记", (mini.match(/dm-mini/g) || []).length === 8);
assert("C8 mini 舞台：总收益对", mini.includes("12") && mini.includes("9"));
const st = viewStats({ game: "dilemma" }, vView);
assert("C9 直播墙卡 meta/stats", st.meta.includes("2 席") && st.stats.some(([lb]) => lb === "总收益"));

const btnBox = mkEl();
renderDilemma(vView, btnBox, true);
// r16 纪律：子元素内容不随父容器 innerHTML 字符串更新——从 _subs 缓存读 renderActions 写入的 act-area
const actAreaHTML = btnBox._subs[".act-area"]?.innerHTML ?? "";
assert("C10 动作区合作/背叛双钮", actAreaHTML.includes("act({type:'move',choice:'cooperate'})") && actAreaHTML.includes("act({type:'move',choice:'betray'})"));

const evT1 = evText({ type: "round_resolved", data: { round: 2, choices: { 1: "betray", 2: "cooperate" }, payoff: { 1: 5, 2: 0 } } });
assert("C11 事件文本：轮次揭晓双语", evT1.includes("背叛") && evT1.includes("合作") && evT1.includes("5 : 0"));
const evT2 = evText({ type: "game_won", data: { winner: 1, totals: { 1: 28, 2: 23 } } });
assert("C12 事件文本：席位号胜（非狼人语义误报）", evT2.includes("1 号胜"));
assert("C13 常量表接线（desc/seats/phases）", GAME_DESC.dilemma.includes("博弈论") && SEATS_DEFAULT.dilemma === 2);

console.log(`\n════ r24 E2E 结果：${pass} 通过 · ${fail} 失败 ════`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
process.exit(0);
