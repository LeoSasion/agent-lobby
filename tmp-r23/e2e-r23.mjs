// r23 E2E：赛事解说席——解说引擎单元（四游戏词典+私有防御+克制策略）+ 集成（SSE 喂流渲染/热度档/回放截断联动）
// 运行前：npm run dev（8787）；需一场多事件已终局骰子局（probe 局在数据中）
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

/* ════ Part A · 解说引擎单元（从产品 html 提取函数独立执行） ════ */
console.log("════ Part A · 解说引擎单元 ════");
{
  const m = html.match(/function commentate\(e\) \{[\s\S]*?\n\}/);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CM_PRIVATE = new Set(["night_kill_decided", "checked", "acted", "said", "match_started_private"]);
  const commentate = new Function("esc", "CM_PRIVATE", m[0] + "; return commentate;")(esc, CM_PRIVATE);
  const cases = [
    ["match_started", { drivers: [1, 2, 3, 4, 5, 6] }, 0],
    // 骰子：克制分档
    ["bid_placed", { seat: 2, qty: 9, face: 6 }, 1],
    ["bid_placed", { seat: 2, qty: 6, face: 4 }, 0],
    ["bid_placed", { seat: 2, qty: 3, face: 4 }, null],
    ["challenge_resolved", { bid_was_true: false, challenger: 4, actual_count: 1, challenged_bid: { seat: 2, qty: 3, face: 5 } }, 2],
    ["challenge_resolved", { bid_was_true: true, challenger: 4, actual_count: 4 }, 1],
    // 狼人杀
    ["phase_started", { phase: "night", round: 2 }, 0],
    ["phase_started", { phase: "day_discuss", round: 2 }, 0],
    ["phase_started", { phase: "day_vote", round: 2 }, null],
    ["last_words", { seat: 3 }, 1],
    ["vote_pk", { candidates: [2, 4] }, 1],
    ["vote_result", { exiled: 4 }, 2],
    ["vote_result", { exiled: null }, 0],
    ["player_died", { seat: 5, cause: "night" }, 1],
    ["game_won", { winner: "good" }, 2],
    ["game_won", { winner: "wolves" }, 2],
    // 德州
    ["hand_started", { hand_no: 1, small_blind: 10, big_blind: 20 }, 0],
    ["hand_started", { hand_no: 9 }, null],
    ["street_dealt", { street: "flop", cards: ["Qs", "7d", "2h"] }, 0],
    ["street_dealt", { street: "river", cards: ["Ah"] }, 1],
    ["street_dealt", { street: "turn", cards: ["Kc"] }, null],
    ["street_dealt", { street: "preflop", cards: [] }, null],
    ["action", { seat: 1, action: "allin" }, 2],
    ["action", { seat: 1, action: "raise" }, 0],
    ["action", { seat: 1, action: "call" }, null],
    ["showdown", {}, 1],
    ["pot_split", {}, 1],
    // 黑白棋
    ["placed", { seat: 1, cell: 20, flipped: [1, 2, 3, 4, 5, 6, 7] }, 1],
    ["placed", { seat: 1, cell: 0, flipped: [1, 2] }, 1],
    ["placed", { seat: 1, cell: 20, flipped: [1, 2] }, null],
    ["board_full", { black: 34, white: 30 }, 2],
    // 通用
    ["player_eliminated", { seat: 3 }, 1],
    ["timed_out", { seat: 2 }, 1],
    ["round_stalled", { consecutive: 2 }, 1],
    ["match_ended", { scores: {} }, 2],
    // 私有事件防御纵深 + 常规不解
    ["night_kill_decided", { target: 3 }, null],
    ["checked", { target: 3, is_wolf: true }, null],
    ["acted", { seat: 1 }, null],
    ["said", { seat: 1 }, null],
  ];
  let ok = 0, bad = 0;
  for (const [type, data, expHot] of cases) {
    const r = commentate({ type, data, seq: 1, ts: Date.now() });
    const got = r ? r.hot : null;
    if (got === expHot) ok++; else { bad++; console.log("    ✗", type, "→ hot:", got, "期望:", expHot, r ? "| " + r.t.slice(0, 40) : ""); }
  }
  assert(`引擎词典 ${ok}/${cases.length} 用例（分档/克制/私有防御）`, bad === 0);
  const allText = cases.map(([type, data]) => commentate({ type, data, seq: 1, ts: Date.now() })).filter(Boolean).map((r) => r.t).join("|");
  assert("解说词全中文（无 ASCII 夹杂）", !/[a-zA-Z]{4,}/.test(allText.replace(/hot/g, "")));
}

/* ════ Part B · 集成：SSE 喂流 → 解说面板 → 回放截断 ════ */
console.log("════ Part B · 解说席集成 ════");
function mkEl() {
  const el = {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {},
    _subs: {}, _cls: new Set(),
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
  addEventListener() {},
  activeElement: { tagName: "BODY" },
};
globalThis.window = globalThis;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (u, o) => realFetch(String(u).startsWith("/") ? BASE + String(u) : u, o);
globalThis.EventSource = class {
  constructor(url) {
    this.onmessage = null; this.onerror = null;
    const m = String(url).match(/\/api\/v1\/matches\/([^/]+)\/stream/);
    if (m) {
      realFetch(`${BASE}/api/v1/matches/${m[1]}/events`).then((r) => r.json()).then((j) => {
        for (const ev of (j.events ?? [])) { if (this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
      }).catch(() => {});
    }
  }
  close() {} addEventListener() {}
};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);

// 找多事件的已终局骰子局（排除恢复壳：view.game==="restored" 无游戏态，渲染链会降级——r23 修复的判别条件）
const ml = await realFetch(`${BASE}/api/v1/matches?limit=30`).then((r) => r.json());
let target = null;
for (const m of (ml.matches ?? [])) {
  if (m.finished && !m.aborted && m.game === "liars_dice") {
    const v = await realFetch(`${BASE}/api/v1/matches/${m.match_id}/view?slim=1`).then((r) => r.json());
    if (v.game !== "liars_dice") continue; // 恢复壳
    const ev = await realFetch(`${BASE}/api/v1/matches/${m.match_id}/events?since=-1`).then((r) => r.json());
    if (ev.events.length > 30) { target = { id: m.match_id, n: ev.events.length }; break; }
  }
}
console.log(`B0 现成非壳局：${target ? target.id : "无（重启后窗口内全是恢复壳——现场兜底）"}`);
if (!target) {
  // 重启后窗口内可能全是恢复壳——现场打一局 2 席快局（叫价轮次少、收敛快）
  console.log("  （无现成局——现场开 2 席骰子局）");
  const qs = await realFetch(`${BASE}/api/v1/lobby/quickstart`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ game: "liars_dice", seats: 2, name: "r23-e2e" }),
  }).then((r) => r.json());
  let fin = false;
  for (let i = 0; i < 240; i++) {
    await sleep(2000);
    const v = await realFetch(`${BASE}/api/v1/matches/${qs.match_id}/view?slim=1`).then((r) => r.json());
    if (v.phase === "finished") { fin = true; break; }
  }
  if (fin) {
    const ev = await realFetch(`${BASE}/api/v1/matches/${qs.match_id}/events?since=-1`).then((r) => r.json());
    target = { id: qs.match_id, n: ev.events.length };
    console.log(`  （现场局 ${qs.match_id} 终局 · ${target.n} 事件）`);
  }
}
assert("B0 局就绪（现成或现场）", !!target && target.n > 8);
if (!target) process.exit(1);

new Function(js)();
await sleep(300);
globalThis.gotoMatch(target.id);
// 等解说渲染（SSE mock 喂流是解说引擎的真实驱动路径）
let rendered = false;
for (let i = 0; i < 40; i++) { await sleep(300); if ((els["#m-cm"]?.innerHTML ?? "").includes("data-cseq")) { rendered = true; break; } }
const cmHTML = els["#m-cm"]?.innerHTML ?? "";
assert("B1 解说面板渲染（事件驱动）", rendered);
assert("B1 开局解说在场", cmHTML.includes("解说席就位"));
const nLines = (cmHTML.match(/data-cseq/g) || []).length;
// 克制语义：解说严格少于事件总数（acted/said/低叫价/preflop/turn 等常规流不解说——引擎单元已验证分档）
assert(`B1 解说行数克制（${nLines}/${target.n}，严格子集）`, nLines > 0 && nLines < target.n);
assert("B1 热度档 hot1 渲染", cmHTML.includes("hot1"));
assert("B1 终局解说在场（骰子局含 game_won/match_ended → hot2）", cmHTML.includes("hot2"));

// B2 回放联动：seek 中段 → 解说历史截断（等 rbar 且 max 已被 SSE 喂流更新——首版 max=0 是 finished 分支先于喂流完成的时序）
for (let i = 0; i < 60; i++) {
  await sleep(300);
  const r = els["#m-replay"]?.innerHTML ?? "";
  const mx = Number((r.match(/max="(\d+)"/) || [])[1] ?? 0);
  if (r.includes("rbar") && mx > 5) break;
}
const total = Number(((els["#m-replay"].innerHTML.match(/max="(\d+)"/) || [])[1] ?? 0));
const half = Math.floor(total / 2);
const fullCount = (els["#m-cm"].innerHTML.match(/data-cseq/g) || []).length;
await globalThis.replaySeek(half);
await sleep(1500);
const cutHTML = els["#m-cm"]?.innerHTML ?? "";
const cutCount = (cutHTML.match(/data-cseq/g) || []).length;
const maxSeqInCut = Math.max(0, ...[...cutHTML.matchAll(/data-cseq="(\d+)"/g)].map((m) => +m[1]));
assert(`B2 回放截断：${fullCount} 条 → seek(${half}) 后 ${cutCount} 条`, cutCount < fullCount && maxSeqInCut <= half);

// B3 终局解说与事件流交叉：解说行数与引擎对全量事件的输出一致
const evs = await realFetch(`${BASE}/api/v1/matches/${target.id}/events?since=-1`).then((r) => r.json());
const expected = evs.events.filter((e) => globalThis.__r23.commentate(e)).length;
assert(`B3 解说条数 ≡ 引擎对全量事件输出（${expected} 条）`, fullCount === expected);

console.log(`\n════ r23 E2E 结果：${pass} 通过 · ${fail} 失败 ════`);
if (fail > 0) { console.log("失败项：\n  - " + failures.join("\n  - ")); process.exit(1); }
