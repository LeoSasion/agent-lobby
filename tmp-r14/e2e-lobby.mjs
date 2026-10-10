// r14 大厅 E2E 审查：mock DOM + 真实网关驱动页面全部交互函数
// 旅程：大厅加载 → startPlay 开局（quickstart 吹牛骰）→ 主动出牌至终局 → 大厅刷新回看 → gotoMatch 围观/回放栏 → replay/step 双视角直测
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
globalThis.EventSource = class { close() {} addEventListener() {} };

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

console.log("════ Phase 0 · 大厅加载（真实网关）════");
new Function(js)();
await sleep(2500);
{
  const wall = els["#wall"]?.innerHTML ?? "";
  assert("直播墙渲染（live/散场/空态任一）", wall.includes('class="tv'));
  assert("直播墙含围观/回放入口", wall.includes("进入围观") || wall.includes("看回放") || wall.includes("开一桌"));
  assert("赛程表渲染", (els["#sched"]?.innerHTML ?? "").includes("srow"));
  assert("分赛区 4 游戏卡", (els["#zones"]?.innerHTML ?? "").length > 0 && (els["#zones"].innerHTML.match(/class="gbox"/g) || []).length === 4);
  assert("rail 赛区导航 + 战绩榜", (els["#rail-lobby"]?.innerHTML ?? "").includes("赛 区") && els["#rail-lobby"].innerHTML.includes("战 绩 榜"));
  const cntBefore = parseInt((els["#sched-cnt"]?.textContent ?? "0").replace(/\D/g, "")) || 0;
  globalThis.__cntBefore = cntBefore;
  console.log(`  （当前 ${cntBefore} 桌 · 大厅轮询/榜单轮询已注册: ${[...timers.values()].map((t) => t.ms).join(", ")}ms）`);
}

console.log("════ Phase 1 · 开一桌 → 全程对局（吹牛骰 3 席）════");
els["#p-game"].value = "liars_dice";
await window.startPlay();
await sleep(400);
const mid = (els["#p-status"].innerHTML.match(/m_[a-z0-9]+/i) || [])[0];
assert("quickstart 入座成功", !!mid && els["#p-status"].innerHTML.includes("已入座"));
console.log(`  （新桌 ${mid}）`);

let pollId = lastTimer();
let acted = 0;
let sawLiveOnWall = false;
for (let i = 0; i < 150; i++) {
  if (els["#p-status"].innerHTML.includes("对局结束")) break;
  await fire(pollId);
  await sleep(100);
  if (!sawLiveOnWall && i === 3) { // 对局中刷新大厅：该桌应上直播墙
    await fire(1); await sleep(600);
    sawLiveOnWall = (els["#wall"].innerHTML.includes(mid));
    assert("对局中该桌出现在直播墙（live 卡）", sawLiveOnWall);
  }
  const board = els["#p-board"].innerHTML;
  if (board.includes("等待其他席位") || board.includes("对局已结束")) continue;
  if (board.includes("质疑")) { await window.act({ type: "challenge" }); acted++; continue; }
  if (board.includes("叫价")) { await window.act({ type: "bid", qty: 1 + Math.floor(acted / 2), face: 3 }); acted++; }
}
assert("对局推进至终局", els["#p-status"].innerHTML.includes("对局结束"));
assert("终局评分/Elo 显示", /elo|胜|平|负/.test(els["#p-status"].innerHTML));
console.log(`  （共主动出牌 ${acted} 手）`);

console.log("════ Phase 2 · 终局后大厅回看 ════");
await fire(1); await sleep(700);
{
  const list = await realFetch(`${BASE}/api/v1/matches`).then((r) => r.json());
  const me = list.matches.find((m) => m.match_id === mid);
  assert("新桌已入赛程数据源（/matches 滚动窗口）", !!me);
  // /matches 为固定窗口（新进旧出）→ 桌数不必然 +1；验证页面渲染了该桌内容（同桌名单出现在赛程表）
  const schedHtml = els["#sched"]?.innerHTML ?? "";
  assert("赛程表渲染该桌（同桌名单可见）", !!me && (schedHtml.includes(me.seats[0]) || schedHtml.includes(me.seats[1] ?? "")));
  assert("战报或名局推荐更新（headline 可见）", (els["#report"]?.innerHTML ?? "").length > 10 || (els["#classics"]?.innerHTML ?? "").includes("mrow"));
}

console.log("════ Phase 3 · 围观与回放 ════");
await window.gotoMatch(mid);
await sleep(800);
assert("围观视图标题（游戏名 + 相位）", /—|已结束|对局/.test(els["#m-ttl"].textContent + els["#m-ttl"].innerHTML));
assert("围观游戏区渲染", (els["#m-game"]?.innerHTML ?? "").length > 0);
assert("回放栏渲染（时间轴 + 视角切换）", (els["#m-replay"]?.innerHTML ?? "").includes("回 放"));
{
  const rs = await realFetch(`${BASE}/api/v1/matches/${mid}/replay/step?to=0&seat=spectator`).then((r) => r.json());
  assert("replay/step 上帝视角·开局帧", !!rs.view && rs.view.game === "liars_dice");
  const r403 = await realFetch(`${BASE}/api/v1/matches/${mid}/replay/step?to=0&seat=1`);
  const j403 = await r403.json();
  assert("replay/step 无凭据座位视角 → 403（私有视角信息隔离，协议预期）", r403.status === 403 && j403.code === "SEAT_INVALID");
  // 本人 token 正测：独立开一局拿 seat_token 验证席位视角可用
  const qs = await realFetch(`${BASE}/api/v1/lobby/quickstart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game: "liars_dice", seats: 2 }) }).then((r) => r.json());
  await sleep(1500); // bot 即时打完
  const mine = await realFetch(`${BASE}/api/v1/matches/${qs.match_id}/replay/step?to=0&seat=${qs.seat_id}`, { headers: { "x-seat-token": qs.seat_token } }).then((r) => r.json());
  assert("replay/step 席位本人凭据 → 私有视角可用", !!mine.view);
}

console.log("════ 结果 ════");
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n" + failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
fs.writeFileSync(new URL("./E2E-VERDICT.md", import.meta.url), `# r14 大厅 E2E 审查报告

- 日期：2026-10-10 · 网关：${BASE}（真实数据）
- 方式：mock DOM 驱动 web/index.html 全部交互函数（Chrome 无法启动的环境降级方案，覆盖渲染 + 交互两层）
- 旅程：大厅加载 → quickstart 吹牛骰 3 席 → 主动出牌 ${acted} 手至终局 → 大厅刷新回看（对局中上直播墙验证）→ 围观视图 + 回放栏 → replay/step 三态（上帝/无凭据座位/本人凭据）
- 结论：**${pass}/${pass + fail} 全部通过**，r14 改动无阻断问题

## 审查发现（存量行为，非 r14 回归）

1. **观战视角切换 UI 与协议不匹配（P2，r13 P1 相关）**：围观回放栏提供座位视角下拉，但 \`replay/step?seat=N\` 要求该席位本人的 x-seat-token（403 SEAT_INVALID）——观战者点选座位视角无响应（catch 静默）。这是私有信息隔离的正确安全语义；UI 侧应隐藏无权视角或给出提示，或走 r13 P1 的「api_key + seat 归属」鉴权升级。本席本人凭据视角验证可用 ✓。
2. **/matches 为固定滚动窗口（20 桌）**：新桌进入、旧桌挤出——赛程表/直播墙数据源随窗口滚动，历史需走 replay（符合「终局保留可查窗」已知设计）。

## 前置检查

- server 全量测试（typecheck + 10 段 smoke）：全部通过（见 npm test 输出）
`, "utf8");
console.log("报告已写入 tmp-r14/E2E-VERDICT.md");
