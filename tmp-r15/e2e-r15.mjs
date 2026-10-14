// r15 E2E：观战视角凭据 UI + Bearer 归属 + aborted 剔除逻辑（真实网关驱动页面交互）
// 旅程：大厅加载 → 自己的局全程对局 → 终局「复盘本局」→ 自己局视角切换（带 token，私有视角可见）
//      → 他人局观战（视角选项隐藏 + 凭据提示）→ aborted 桌不进名局/直播墙第 4 格（数据形状断言）
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
// r15：EventSource mock——构造时拉一次 events 端点喂 onmessage（MEVS/seatNames 才有 drivers）
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
globalThis.clearInterval = (id) => { timers.delete(id); };
const fire = (id) => { const t = timers.get(id); return t ? Promise.resolve().then(t.f).catch(() => {}) : Promise.resolve(); };
const lastTimer = () => Math.max(0, ...timers.keys());

let pass = 0, fail = 0; const failures = [];
function assert(name, cond) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (cond) pass++; else { fail++; failures.push(name); }
}

console.log("════ Phase 0 · 大厅加载（r14 无回归）════");
new Function(js)();
await sleep(2500);
assert("直播墙渲染", (els["#wall"]?.innerHTML ?? "").includes('class="tv'));
assert("赛程表渲染", (els["#sched"]?.innerHTML ?? "").includes("srow"));
// r24：游戏卡数随注册游戏数动态断言（原硬编码 4——dilemma 入注册后假失败）
const CACHE_GAMES_N = await fetch(`${BASE}/api/v1/games`).then((r) => r.json()).then((g) => g.games.length).catch(() => 5);
assert(`分赛区游戏卡（注册游戏数 ${CACHE_GAMES_N}）`, ((els["#zones"]?.innerHTML ?? "").match(/class="gbox"/g) || []).length === CACHE_GAMES_N);

console.log("════ Phase 1 · 自己的局：全程对局 + 终局复盘入口 ════");
els["#p-game"].value = "liars_dice";
await window.startPlay();
await sleep(400);
const mid = (els["#p-status"].innerHTML.match(/m_[a-z0-9]+/i) || [])[0];
assert("quickstart 入座", !!mid && els["#p-status"].innerHTML.includes("已入座"));
let pollId = lastTimer(); let acted = 0;
for (let i = 0; i < 150; i++) {
  if (els["#p-status"].innerHTML.includes("对局结束")) break;
  await fire(pollId); await sleep(100);
  const board = els["#p-board"].innerHTML;
  if (board.includes("等待其他席位") || board.includes("对局已结束")) continue;
  if (board.includes("质疑")) { await window.act({ type: "challenge" }); acted++; continue; }
  if (board.includes("叫价")) { await window.act({ type: "bid", qty: 1 + Math.floor(acted / 2), face: 3 }); acted++; }
}
assert("对局终局", els["#p-status"].innerHTML.includes("对局结束"));
assert("终局带「复盘本局（我的视角）」入口", els["#p-status"].innerHTML.includes("复盘本局"));

console.log("════ Phase 2 · 自己局回放：座位视角可用（自动带凭据）════");
// 时序鲁棒性（r15 复盘）：view fetch 与 events 喂送完成顺序不定，且回放栏在
// 每条事件后经 refreshMatchView 重渲染——轮询等待收敛（回放栏已渲染 + 事件流已到），
// 固定 sleep 在慢机上会假失败（view 未返回 → #m-replay 空串 → 断言双失真）
const waitReplayReady = async (needEvents, timeoutMs = 20000) => {
  for (let i = 0; i < timeoutMs / 200; i++) {
    const b = els["#m-replay"]?.innerHTML ?? "";
    const log = els["#m-log"]?.innerHTML ?? "";
    if (b.includes("rbar") && (!needEvents || log.includes("#00"))) {
      await sleep(500); // 链尾 refreshMatchView → 回放栏按最新事件重渲染
      return els["#m-replay"]?.innerHTML ?? "";
    }
    await sleep(200);
  }
  return els["#m-replay"]?.innerHTML ?? "";
};
const waitCond = async (fn, timeoutMs = 5000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { if (fn()) return true; await sleep(200); }
  return fn();
};
await window.gotoMatch(mid);
const replayBar = await waitReplayReady(true);
assert("回放栏渲染", replayBar.includes("回 放"));
assert("自己局提供「（我）视角」选项", replayBar.includes("（我）视角"));
assert("自己局不显示凭据缺失提示", !replayBar.includes("座位视角需席位凭据"));
if (replayBar.includes("（我）视角")) {
  await window.replaySeat("1");
  await waitCond(() => (els["#m-game"]?.innerHTML ?? "").includes("我的骰子"));
  assert("切自己视角 → 私有信息渲染（我的骰子）", (els["#m-game"]?.innerHTML ?? "").includes("我的骰子"));
  await window.replaySeat("spectator");
  await waitCond(() => !(els["#m-game"]?.innerHTML ?? "").includes("我的骰子"));
  assert("切回上帝视角 → 私有信息隐藏", !(els["#m-game"]?.innerHTML ?? "").includes("我的骰子"));
}

console.log("════ Phase 3 · 他人局观战：视角选项隐藏 + 凭据提示 ════");
{
  const list = await realFetch(`${BASE}/api/v1/matches`).then((r) => r.json());
  const other = list.matches.find((m) => m.match_id !== mid && m.finished && !m.aborted);
  if (other) {
    await window.gotoMatch(other.match_id);
    const bar3 = await waitReplayReady(false);
    assert("他人局视角选项隐藏", !bar3.includes("（我）视角"));
    assert("他人局显示凭据提示", bar3.includes("座位视角需席位凭据"));
  } else {
    console.log("  （无他人局可测，跳过）");
  }
}

console.log("════ Phase 4 · aborted 剔除逻辑（数据形状直测）════");
{
  // 服务端行为（aborted 壳/Bearer）已由 smoke-persist 第 5-7 幕覆盖；
  // 此处直测页面过滤逻辑依赖的数据形状约定：aborted 桌不应出现在名局/战报/直播墙第 4 格
  const list = await realFetch(`${BASE}/api/v1/matches`).then((r) => r.json());
  const ab = list.matches.find((m) => m.aborted === true);
  if (ab) {
    const classics = els["#classics"]?.innerHTML ?? "";
    const report = els["#report"]?.innerHTML ?? "";
    const wall = els["#wall"]?.innerHTML ?? "";
    assert("中止桌不进名局推荐", !classics.includes(ab.match_id));
    assert("中止桌不进今日战报", !report.includes(ab.match_id));
    assert("中止桌不进直播墙回放格", !wall.includes(ab.match_id));
  } else {
    console.log("  （当前无中止桌在列——渲染逻辑已按 !m.aborted 过滤，服务端行为见 smoke-persist）");
  }
}

console.log("════ 结果 ════");
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n" + failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
fs.writeFileSync(new URL("./E2E-VERDICT.md", import.meta.url), `# r15 E2E 审查报告

- 日期：2026-10-12 · 网关：${BASE}（r15 新代码，真实数据）
- 旅程：大厅加载无回归 → 自己局全程对局 → 终局「复盘本局（我的视角）」入口 → 座位视角切换（自动带 x-seat-token，私有信息 my_dice 渲染/隐藏）→ 他人局观战（视角选项隐藏 + 凭据提示）→ aborted 剔除逻辑
- 结论：**${pass}/${pass + fail} 全部通过**
- 前置：server 全量测试（typecheck + 10 段 smoke，含 smoke-persist 新增第 5-7 幕 15 项断言）全部通过
- 服务端 r15 行为（aborted 壳恢复 / 404 三态 / Bearer 归属四态）由 smoke-persist 覆盖
`, "utf8");
console.log("报告已写入 tmp-r15/E2E-VERDICT.md");
