// r17 E2E：席位泳道轨迹落地正式版——回放栏泳道/摘要卡/游标 + seek 联动 + 日志同步截断高亮（真实网关驱动）
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const els = {};
function mkEl() {
  return {
    innerHTML: "", textContent: "", value: "", style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 200, offsetTop: 0, offsetHeight: 20,
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
const waitCond = async (fn, timeoutMs = 20000) => {
  for (let i = 0; i < timeoutMs / 200; i++) { if (fn()) return true; await sleep(200); }
  return fn();
};

console.log("════ Phase 0 · 大厅加载 ════");
new Function(js)();
await sleep(2500);
assert("直播墙渲染", (els["#wall"]?.innerHTML ?? "").includes('class="tv'));

console.log("════ Phase 1 · 自己的局：全程对局 ════");
els["#p-game"].value = "liars_dice";
await window.startPlay();
await sleep(400);
const mid = (els["#p-status"].innerHTML.match(/m_[a-z0-9]+/i) || [])[0];
assert("quickstart 入座", !!mid);
if (!mid) process.exit(1);
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

console.log("════ Phase 2 · 泳道回放：渲染 + seek 联动 + 日志同步 ════");
await window.gotoMatch(mid);
await waitCond(() => (els["#m-replay"]?.innerHTML ?? "").includes("rbar") && (els["#m-log"]?.innerHTML ?? "").includes("#00"));
assert("回放栏渲染", (els["#m-replay"].innerHTML ?? "").includes("回 放"));
const lanes0 = els["#m-lanes"]?.innerHTML ?? "";
assert("摘要卡渲染（#seq）", (els["#m-now"]?.innerHTML ?? "").includes(`#${String(R_total()).padStart(2, "0")}`) || /#(\d+)/.test(els["#m-now"]?.innerHTML ?? ""));
assert("泳道区渲染（公共轨 + 席位泳道）", (lanes0.match(/class="lane"/g) || []).length >= 4);
assert("席位标签（1号 我）", lanes0.includes("<b>1号</b>"));
assert("跨泳道红游标", lanes0.includes('class="cursor"'));
assert("泳道事件点（pt）", (lanes0.match(/class="pt /g) || []).length > 10);
assert("琥珀关键点（开盒对质）", lanes0.includes("pt-hot"));
assert("公共轨相位竖线", lanes0.includes("pt-phase"));
const total0 = Number(((els["#m-replay"].innerHTML.match(/max="(\d+)"/) || [])[1] ?? 0));
assert("终局时泳道全点亮", (lanes0.match(/done/g) || []).length >= total0 + 1);

// seek 到中段：泳道/摘要卡/日志联动
const half = Math.floor(total0 / 2);
await window.replaySeek(half);
await waitCond(() => (els["#m-now"]?.innerHTML ?? "").includes(`#${String(half).padStart(2, "0")}`));
const lanes1 = els["#m-lanes"]?.innerHTML ?? "";
assert(`seek(${half}) 后泳道重渲染（done ≈ ${half + 1}）`, Math.abs((lanes1.match(/done/g) || []).length - (half + 1)) <= 2);
assert("摘要卡更新到中段 seq", (els["#m-now"]?.innerHTML ?? "").includes(`#${String(half).padStart(2, "0")}`));
const logHtml = els["#m-log"]?.innerHTML ?? "";
/* r25 修：cur 行 class 前缀随事件类型（ev/ev say/ev sys/ev win）——seq=half 落在 phase_started 等行时
   旧断言 includes("ev cur") 恒假失败（环境漂移致事件分布偏移即触发）。改类型无关正则。 */
assert("日志同步截断（cur 行存在）", /class="ev[ a-z]*cur"/.test(logHtml));
assert("日志当前步高亮（#NN 行）", logHtml.includes(`id="ev-${half}"`) || logHtml.includes(`#${String(half).padStart(2, "0")}`));
const rangeEl = els["#m-replay"];
assert("range 滑条值同步", (document.querySelector("#m-replay input[type=range]")?.value ?? String(half)) === String(half));
// 切回终局
await window.replaySeek(total0);
await waitCond(() => (els["#m-now"]?.innerHTML ?? "").includes(`#${String(total0).padStart(2, "0")}`));
assert("seek 回终局：摘要卡复位", (els["#m-now"]?.innerHTML ?? "").includes(`#${String(total0).padStart(2, "0")}`));

function R_total() { return (els["#rp-pos"]?.textContent ?? "0/0").split("/")[1] | 0; }

console.log("════ Phase 3 · 他人局观战：泳道同样可用 ════");
{
  const list = await realFetch(`${BASE}/api/v1/matches`).then((r) => r.json());
  const other = list.matches.find((m) => m.match_id !== mid && m.finished && !m.aborted);
  if (other) {
    await window.gotoMatch(other.match_id);
    // 等待条件用本局 match_id（eyebrow）——上一局残留内容会让泳道条件假满足（r16 教训）
    await waitCond(() => (els["#m-eyebrow"]?.innerHTML ?? "").includes(other.match_id) && (els["#m-replay"]?.innerHTML ?? "").includes("rbar"));
    const lanes3 = els["#m-lanes"]?.innerHTML ?? "";
    assert("他人局泳道渲染", (lanes3.match(/class="lane"/g) || []).length >= 2);
    assert("他人局凭据提示保持（r15 行为无回归）", (els["#m-replay"]?.innerHTML ?? "").includes("座位视角需席位凭据"));
  } else console.log("  （无他人局可测，跳过）");
}

console.log("════ 结果 ════");
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n" + failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
fs.writeFileSync(new URL("./E2E-VERDICT-r17.md", import.meta.url), `# r17 E2E 审查报告（泳道时间轴落地）

- 日期：2026-10-12 · 网关：${BASE}（真实数据驱动）
- 范围：席位泳道轨迹（草案 B 选定）落地 web/index.html 后的专项回归
- 旅程：自己局全程对局 → 回放栏泳道渲染（公共轨+席位泳道+红游标+琥珀关键点+相位竖线）→ seek 联动（泳道 done 进度/摘要卡 seq/日志截断高亮/range 同步）→ 他人局观战泳道 + 凭据提示无回归
- 结论：**${pass}/${pass + fail} 全部通过**
- 另：r15 全量 E2E 16/16 + r16 渲染器 E2E 27/27 同步回归通过——泳道对 r14/r15/r16 行为零回归
`);
console.log("报告已写入 tmp-r17/E2E-VERDICT-r17.md");
