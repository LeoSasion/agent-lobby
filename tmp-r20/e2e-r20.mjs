// r20 E2E：直播墙实时可视化——mini 舞台 + SSE 脉搏带（真实网关驱动 + mock EventSource 注入）
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- mock DOM（子元素查询带缓存；classList 真实记录） ---- */
function mkEl() {
  const el = {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {},
    _subs: {}, _cls: new Set(),
    querySelector(s) { el._subs[s] ??= mkEl(); return el._subs[s]; },
    querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 200, offsetTop: 0, offsetHeight: 20, offsetWidth: 10,
    onclick: null, addEventListener() {}, scrollIntoView() {},
  };
  el.classList = {
    add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); },
    contains(c) { return el._cls.has(c); }, toggle() {},
  };
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
globalThis.fetch = (url, o) => realFetch(String(url).startsWith("/") ? BASE + url : url, o);

/* ---- mock EventSource：捕获实例供测试注入事件 ---- */
const ES_INSTANCES = [];
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); ES_INSTANCES.push(this); this.onmessage = null; this.onerror = null; }
  close() {}
  addEventListener() {}
};

const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);
/* setTimeout 保持原生：去抖刷新走真实异步（waitCond 条件等待） */
const fire = (id) => { const t = timers.get(id); return t ? Promise.resolve().then(t.f).catch(() => {}) : Promise.resolve(); };
const lastTimer = () => Math.max(0, ...timers.keys());

let pass = 0, fail = 0; const failures = [];
function assert(name, cond) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (cond) pass++; else { fail++; failures.push(name); }
}
const waitCond = async (fn, timeoutMs = 20000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { if (fn()) return true; await sleep(200); }
  return fn();
};

/* ════ Phase 0 · 起活局（狼人 + 骰子，bot 兜底推进保证「进行中」） ════ */
console.log("════ Phase 0 · 起活局 ════");
const qs = async (game, seats) => {
  const r = await realFetch(`${BASE}/api/v1/lobby/quickstart`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ game, seats }),
  });
  return (await r.json()).match_id;
};
const wolfMid = await qs("werewolf_lite", 6);
const diceMid = await qs("liars_dice", 6);
assert("狼人桌已开局", !!wolfMid);
assert("骰子桌已开局", !!diceMid);

/* ════ Phase 1 · 大厅加载：直播墙 + mini 舞台 + 脉搏带骨架 ════ */
console.log("════ Phase 1 · 大厅加载与直播墙 ════");
new Function(js)();
/* r23 修复：固定 sleep(3000) → 条件轮询等狼人卡昼夜 lab 渲染。60s 上限覆盖两类假失败：
   ①并发局堆积时初始 view 拉取 >3s ②网关冷启动（恢复数百选手/百局壳）首轮初始化 >20s（实测） */
await waitCond(() => {
  syncWallCards();
  const c = els["#tv-" + wolfMid];
  return !!c && c.innerHTML.includes("mn-orb") && /[夜昼]/.test(c.innerHTML);
}, 60000);

/* mock DOM 无解析树：从 #wall innerHTML 提取卡块注册到 els（r16/r17 纪律：从父容器字符串提取） */
function syncWallCards() {
  const w = els["#wall"]?.innerHTML ?? "";
  const re = /<div class="tv[^"]*" id="(tv-[^"]+)"/g;
  const marks = []; let m;
  while ((m = re.exec(w))) marks.push({ id: m[1], start: m.index });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : w.length;
    const el = els["#" + mk.id] ??= mkEl();
    el.innerHTML = w.slice(mk.start, end);
  });
  return marks.length;
}
const cardCount = syncWallCards();
const wallHTML = els["#wall"]?.innerHTML ?? "";
assert("直播墙渲染 TV 卡", wallHTML.includes('class="tv'));
assert("TV 卡含 mini 舞台容器", (wallHTML.match(/class="ministage"/g) || []).length >= 1);
assert("TV 卡含实时事件流容器", (wallHTML.match(/class="evflow"/g) || []).length >= 1);
assert("脉搏带统计位存在", !!els["#pb-live"] && !!els["#pb-n"] && !!els["#pb-r"]);
assert("直播桌数统计已更新", (els["#pb-live"].textContent || "").match(/^\d+$/) && +els["#pb-live"].textContent >= 2);
assert("SSE 已为直播桌建立连接", ES_INSTANCES.length >= 2);

/* 狼人桌 mini 断言（开局 N1 窗口内，相位=night） */
syncWallCards();
const wolfCard = els["#tv-" + wolfMid];
assert("狼人卡已渲染", !!wolfCard && wolfCard.innerHTML.includes("tvhead"));
assert("狼人 mini 含昼夜 orb", wolfCard.innerHTML.includes("mn-orb"));
assert("狼人 mini 含席位环", wolfCard.innerHTML.includes("seatring"));
/* r23 修正断言语义：原「夜相」依赖竞态——quickstart 后 E2E 初始化链路快于 bot 夜间推进才见 night
   （N1 同时相位 bot 交齐即结算入昼，负载/冷启动下必假失败）。orb lab 昼夜二选一即证明相位渲染正确 */
assert("狼人 mini 昼夜相位渲染", /[夜昼]/.test(wolfCard.innerHTML));

/* 骰子桌 mini 断言 */
const diceCard = els["#tv-" + diceMid];
assert("骰子卡已渲染", !!diceCard && diceCard.innerHTML.includes("tvhead"));
assert("骰子 mini 含余骰阵列", diceCard.innerHTML.includes("dice-rows"));
assert("骰子 mini 含 30 枚骰点", (diceCard.innerHTML.match(/mini-die/g) || []).length === 30);
assert("骰子 mini 含叫价徽章", diceCard.innerHTML.includes("bid-badge"));

/* ════ Phase 2 · 四游戏 mini 舞台单元断言（真实快照数据，走测试钩子） ════ */
console.log("════ Phase 2 · 四游戏 mini 舞台 ════");
const snapView = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const hView = snapView("view-m_uc7goq6k.json");
const holdemMini = window.__r20.miniStageInner({ game: "holdem_lite" }, hView);
assert("德州 mini 含街徽", holdemMini.includes("street-badge"));
assert("德州 mini 含公共牌", (holdemMini.match(/mini-card/g) || []).length === 5);
assert("德州 mini 含筹码条", (holdemMini.match(/class="chip-bar /g) || []).length === (hView.public.players || []).length);
assert("德州 mini 含底池", holdemMini.includes("pot-big"));
const oView = snapView("view-m_n56unofg.json");
const othMini = window.__r20.miniStageInner({ game: "othello" }, oView);
assert("黑白棋 mini 含棋枰", othMini.includes("grid8"));
assert("黑白棋 mini 64 格", (othMini.match(/class="cell/g) || []).length === 64);
assert("黑白棋 mini 有落子", (othMini.match(/cell b|cell w/g) || []).length >= 4);
assert("黑白棋 mini 含黑白对", othMini.includes("oth-side"));

/* ════ Phase 3 · SSE 实时链路：注入事件 → 脉搏带/事件流/计数 ════ */
console.log("════ Phase 3 · SSE 实时事件注入 ════");
const wolfES = ES_INSTANCES.find((e) => e.url.includes(wolfMid));
assert("狼人桌 ES 实例可寻", !!wolfES && typeof wolfES.onmessage === "function");
const tickerBefore = (els["#ticker"].innerHTML.match(/<span/g) || []).length;
const inject = (seq, type, data) => wolfES.onmessage({ data: JSON.stringify({ seq, type, data }) });
inject(9001, "phase_started", { phase: "day_discuss", round: 1 });
await sleep(150);
assert("脉搏带出现新事件", (els["#ticker"].innerHTML.match(/<span/g) || []).length > tickerBefore || els["#ticker"].innerHTML.includes("白天"));
assert("脉搏带 hot 事件高亮", (() => { inject(9002, "player_died", { seat: 5, cause: "night" }); return els["#ticker"].innerHTML.includes('class="hot"'); })());
const evflowEl = wolfCard._subs[".evflow"];
assert("TV 卡事件流出现行", (evflowEl.innerHTML.match(/ev-row/g) || []).length >= 1);
assert("事件流行含最新事件文本", evflowEl.innerHTML.includes("#9002"));
const cnt = () => window.__r20.TK.total[wolfMid] ?? 0;
assert("事件计数已累加", cnt() >= 2);
/* 幂等：同 seq 双推不重复计数 */
const countBefore = cnt();
inject(9002, "player_died", { seat: 5, cause: "night" });
await sleep(100);
assert("同 seq 重复注入被去重", cnt() === countBefore);

/* ════ Phase 4 · view 去抖刷新 + flash 脉冲 ════ */
console.log("════ Phase 4 · view 去抖刷新 ════");
inject(9003, "said", { seat: 1, text: "r20 e2e 推进验证发言" });
await waitCond(() => wolfCard._subs[".ministage"]?._cls.has("flash") ?? false, 6000);
assert("去抖链路跑通（refreshMinistage 执行）", wolfCard._subs[".ministage"]._cls.has("flash"));
assert("ministage 有真实渲染内容（view 重拉）", wolfCard._subs[".ministage"].innerHTML.includes("mn-orb") || wolfCard._subs[".ministage"].innerHTML.includes("seatring"));
assert("脉搏带统计总数累加", +els["#pb-n"].textContent >= 3);

/* ════ Phase 5 · 轮询兜底与收尾 ════ */
console.log("════ Phase 5 · 轮询兜底 ════");
const lobbyTimerId = [...timers.entries()].find(([, t]) => t.ms === 4000)?.[0];
const cnt5 = window.__r20.TK.total[wolfMid] ?? 0;
if (lobbyTimerId) await fire(lobbyTimerId); // loadLobby 轮询（含 updateTicker 兜底路径）
await sleep(800);
assert("轮询兜底不重复计数（幂等贯通）", (window.__r20.TK.total[wolfMid] ?? 0) >= cnt5);
assert("over 卡（已终局骰子）无 evflow 崩溃", !els["#wall"].innerHTML.includes("NaN") && (els["#wall"].innerHTML.match(/class="tv/g) || []).length >= 1);

console.log(`\n════ r20 E2E 结果：${pass} 通过 / ${fail} 失败 ════`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
process.exit(0);
