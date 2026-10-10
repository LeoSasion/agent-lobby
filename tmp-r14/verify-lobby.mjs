// r14 大厅无头验证：mock DOM + 真实网关（:8787）跑完整 loadLobby 渲染管线
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

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
const timers = [];
globalThis.setInterval = (f, ms) => { timers.push(ms); return timers.length; };
globalThis.clearInterval = () => {};
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, o) => realFetch(String(url).startsWith("/") ? "http://localhost:8787" + url : url, o);
globalThis.EventSource = class { close() {} addEventListener() {} };

try {
  new Function(js)(); // 执行整页脚本（末尾自动 showView("lobby") → loadLobby）
} catch (e) {
  console.error("SCRIPT EXECUTION ERROR:", e.message);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 2500)); // 等 loadLobby/updateTicker/loadWallViews 的 fetch 链完成

let fail = 0;
function assert(name, cond) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (!cond) fail++;
}

console.log("大厅渲染断言（真实网关数据）：");
const wall = els["#wall"]?.innerHTML ?? "";
assert("直播墙含直播卡 .tv", wall.includes('class="tv"'));
assert("直播墙含直播中徽标", wall.includes("直播中"));
assert("直播墙含频道号 CH-01", wall.includes("CH-01"));
assert("直播墙含进入围观入口", wall.includes("进入围观"));
assert("直播墙含散场回放格", wall.includes("已散场") || wall.includes("看回放"));
assert("直播卡含席位灯", wall.includes('class="sd '));
assert("直播卡含 now 最新动作行", wall.includes('class="nowline"'));

const sched = els["#sched"]?.innerHTML ?? "";
assert("赛程表含表头", sched.includes("时间") && sched.includes("同桌"));
assert("赛程表含已结束行", sched.includes('srow done'));
assert("赛程表含看回放入口", sched.includes("看回放"));
assert("赛程表含同桌名字", /<b>[^<]+<\/b> \/ /.test(sched));

const zones = els["#zones"]?.innerHTML ?? "";
assert("分赛区 4 个游戏卡", (zones.match(/class="gbox"/g) || []).length === 4);
assert("分赛区含开一桌按钮", (zones.match(/>开一桌</g) || []).length >= 4);
assert("分赛区含今日桌数", zones.includes("今日"));

const classics = els["#classics"]?.innerHTML ?? "";
assert("名局推荐非空", classics.includes("mrow") || classics.includes("暂无名局"));

assert("战报非空", (els["#report"]?.innerHTML ?? "").length > 0);
assert("rail 含赛区导航", (els["#rail-lobby"]?.innerHTML ?? "").includes("赛 区"));
assert("rail 含战绩榜", (els["#rail-lobby"]?.innerHTML ?? "").includes("战 绩 榜"));
assert("masthead 含直播计数", (els["#mast-meta"]?.innerHTML ?? "").includes("场直播"));
assert("轮询已注册(4s大厅+60s榜单)", timers.includes(4000) && timers.includes(60000));
assert("战绩榜渲染非空", (els["#znav"]?.innerHTML ?? "").includes("桌"));

console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
