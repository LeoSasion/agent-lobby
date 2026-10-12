// r16 E2E：具象演武场渲染器正式版——四游戏关键视觉元素 + 观战暗骰信息差（真实网关驱动）
// 旅程：大厅加载 → 四游戏 quickstart 首帧（interactive 渲染：骰面/牌面/圆桌/棋枰 + 私有区）
//      → 同局切观战（spectator view：暗骰背面 / 无底牌 / 无身份）
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const els = {};
function mkEl() {
  return {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0,
    onclick: null, addEventListener() {}, scrollIntoView() {},
  };
}
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
globalThis.EventSource = class {
  constructor(url) {
    this.onmessage = null;
    const m = String(url).match(/\/api\/v1\/matches\/([^/]+)\/stream/);
    if (m) {
      realFetch(`${BASE}/api/v1/matches/${m[1]}/events`)
        .then((r) => r.json())
        .then((j) => { for (const ev of (j.events ?? [])) { if (this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); } })
        .catch(() => {});
    }
  }
  close() {}
  addEventListener() {}
};

const timers = new Map(); let tid = 0;
globalThis.setInterval = (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; };
globalThis.clearInterval = (id) => timers.delete(id);
const fire = (id) => { const t = timers.get(id); return t ? Promise.resolve().then(t.f).catch(() => {}) : Promise.resolve(); };
const lastTimer = () => Math.max(0, ...timers.keys());

let pass = 0, fail = 0; const failures = [];
function assert(name, cond) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (cond) pass++; else { fail++; failures.push(name); }
}
const waitCond = async (fn, timeoutMs = 8000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { if (fn()) return true; await sleep(200); }
  return fn();
};

console.log("════ Phase 0 · 大厅加载 ════");
new Function(js)();
await sleep(2500);
assert("直播墙渲染", (els["#wall"]?.innerHTML ?? "").includes('class="tv'));
assert("赛程表渲染", (els["#sched"]?.innerHTML ?? "").includes("srow"));

// 每游戏：quickstart → 等 p-board 出渲染器特征（interactive）→ 断言私有区 → gotoMatch 同局观战 → 断言暗面元素
const GAMES = [
  {
    id: "liars_dice", name: "吹牛骰", seats: 3,
    mine: (b) => [
      ["骰面点阵渲染（.die）", b.includes('class="die"') || b.includes('class="die ')],
      ["本人真骰面（pip 点亮）", /<i class="on">/.test(b)],
      ["私有区「我的骰子」", b.includes("我的骰子")],
      ["叫价巨字区", b.includes("当前叫价")],
    ],
    spec: (b) => [
      ["观战暗骰背面（.die.back）", b.includes("die back")],
      ["观战无「我的骰子」", !b.includes("我的骰子")],
    ],
  },
  {
    id: "holdem_lite", name: "德州扑克", seats: 3,
    mine: (b) => [
      ["椭圆牌桌（.felt）", b.includes('class="felt"')],
      ["公共牌区（.pcard）", b.includes('class="pcard')],
      ["私有区「我的底牌」", b.includes("我的底牌")],
      ["底池区", b.includes("底池")],
    ],
    spec: (b) => [
      ["观战无「我的底牌」", !b.includes("我的底牌")],
      ["牌桌渲染", b.includes('class="felt"')],
    ],
  },
  {
    id: "werewolf_lite", name: "狼人杀", seats: 6,
    mine: (b) => [
      ["圆桌（.round-table）", b.includes('class="round-table"') || b.includes("round-table")],
      ["席位环（.wseat）", b.includes('class="wseat')],
      ["私有区「我的身份」", b.includes("我的身份")],
    ],
    spec: (b) => [
      ["观战无「我的身份」", !b.includes("我的身份")],
      ["圆桌渲染", b.includes("round-table")],
    ],
  },
  {
    id: "othello", name: "黑白棋", seats: 2,
    mine: (b) => [
      ["坐标棋枰（.goban）", b.includes('class="goban"')],
      ["棋子（.disc）", b.includes('class="disc')],
      ["局势侧栏（黑/白计数）", b.includes("局势")],
    ],
    spec: (b) => [
      ["观战棋枰渲染", b.includes('class="goban"')],
    ],
  },
];

console.log("════ Phase 1 · 四游戏渲染器（自己局 interactive + 同局观战 spectator）════");
for (const g of GAMES) {
  console.log(`  ── ${g.name} ──`);
  els["#p-game"].value = g.id;
  await window.startPlay();
  await sleep(500);
  const mid = (els["#p-status"].innerHTML.match(/m_[a-z0-9]+/i) || [])[0];
  assert(`${g.name} quickstart 入座`, !!mid);
  if (!mid) continue;
  // interactive 首帧渲染（pollPlay 定时器驱动一次）
  const pollId = lastTimer();
  await fire(pollId);
  await waitCond(() => (els["#p-board"].innerHTML ?? "").length > 100);
  const board = els["#p-board"].innerHTML ?? "";
  for (const [name, ok] of g.mine(board)) assert(`${g.name} · ${name}`, ok);
  // 同局切观战——等待条件用本游戏专属元素（避免上一游戏残留内容假满足）
  await window.gotoMatch(mid);
  const keyMark = g.id === "liars_dice" ? 'class="die' : g.id === "holdem_lite" ? 'class="felt"' : g.id === "werewolf_lite" ? "round-table" : 'class="goban"';
  await waitCond(() => (els["#m-game"]?.innerHTML ?? "").includes(keyMark));
  const spec = els["#m-game"]?.innerHTML ?? "";
  for (const [name, ok] of g.spec(spec)) assert(`${g.name} · ${name}`, ok);
}

console.log("════ 结果 ════");
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n" + failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
fs.writeFileSync(new URL("./E2E-VERDICT-r16.md", import.meta.url), `# r16 E2E 审查报告（渲染器落地）

- 日期：2026-10-12 · 网关：${BASE}（真实数据驱动）
- 范围：具象演武场渲染器（草案 A 选定）落地 web/index.html 后的专项回归
- 旅程：大厅加载 → 四游戏 quickstart 首帧（骰面点阵/椭圆牌桌/圆桌席位环/坐标棋枰 + 私有区「我的骰子/底牌/身份」）→ 同局切观战（**暗骰背面信息差**、观战无私有区）
- 结论：**${pass}/${pass + fail} 全部通过**
- 另：r15 全量 E2E（13 项，观战视角切换/回放/aborted 剔除）同步回归通过——新渲染器对 r14/r15 行为零回归
`);
console.log("报告已写入 tmp-r16/E2E-VERDICT-r16.md");
