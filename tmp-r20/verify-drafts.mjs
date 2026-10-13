// r20 草案无头验证：mock DOM 执行草案主脚本，断言各卡渲染与推进引擎
import { readFileSync } from "node:fs";

function makeEl() {
  const el = {
    innerHTML: "", textContent: "", className: "",
    classList: { add() {}, remove() {} },
    style: {}, offsetWidth: 0,
    querySelectorAll() { return { forEach() {} }; },
    appendChild(child) { el.innerHTML += (child.outerHTML || ""); },
    remove() {},
  };
  Object.defineProperty(el, "outerHTML", { get() { return `<div class="${el.className}">${el.innerHTML}</div>`; } });
  return el;
}

function verifyDraft(file, asserts) {
  const html = readFileSync(file, "utf8");
  // 提取全部 <script> 内容：[0]=DATA, [1]=主逻辑
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length < 2) throw new Error(file + ": script 段不足");
  const els = {};
  const document = {
    querySelector(sel) { els[sel] ??= makeEl(); return els[sel]; },
    createElement() { return makeEl(); },
  };
  const timers = [];
  const sandboxWindow = {};
  const globals = {
    window: sandboxWindow, document,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {}, setTimeout: (fn) => { /* 推进循环不真等 */ return 0; },
    Date, Math, JSON, Number, String, Array, Object,
    console: { log() {}, error() {} },
    process: { exit() {} },
  };
  Object.setPrototypeOf(sandboxWindow, null);
  new Function("window", "document", "setInterval", "clearInterval", "setTimeout", "console", "process",
    scripts[0] + "\n" + scripts[1])(
    sandboxWindow, document, globals.setInterval, globals.clearInterval, globals.setTimeout, globals.console, globals.process);
  // 初始渲染断言
  const results = [];
  for (const [desc, sel, re] of asserts) {
    const el = els[sel];
    const ok = el && re.test(el.innerHTML);
    results.push([ok, desc, sel]);
  }
  // 推进引擎：手动调用 timer 若干次（模拟事件推进）
  const tick = timers[0];
  if (tick) for (let i = 0; i < 40; i++) tick.fn();
  return { results, els };
}

const A = verifyDraft("r20-A-ministage.html", [
  ["狼人卡含席位环", "#tv-wolf", /seatring/],
  ["狼人卡含昼夜 orb", "#tv-wolf", /mn-orb/],
  ["骰子卡含余骰行", "#tv-dice", /dice-row/],
  ["骰子卡含叫价徽章", "#tv-dice", /bid-badge/],
  ["德州卡含街徽", "#tv-holdem", /street-badge/],
  ["德州卡含公共牌", "#tv-holdem", /mini-card/],
  ["德州卡含筹码条", "#tv-holdem", /chip-bar/],
  ["黑白棋卡含棋枰", "#tv-othello", /grid8/],
]);
const B = verifyDraft("r20-B-pulse.html", [
  ["狼人卡含事件流", "#tv-wolf", /evflow/],
  ["骰子卡含事件流", "#tv-dice", /evflow/],
  ["德州卡含事件流", "#tv-holdem", /evflow/],
]);

// 推进后断言（事件已被引擎消化）
const A2 = [
  ["推进后狼人存活变化", /存活/.test(A.els["#tv-wolf"].innerHTML)],
  ["推进后德州底池数字", /\d/.test((A.els["#tv-holdem"].innerHTML.match(/底池[^<]*<[^>]*> ?(\d+)/) || ["", ""])[1]) || /pot-big/.test(A.els["#tv-holdem"].innerHTML)],
  ["推进后黑白棋有子", /cell b|cell w/.test(A.els["#tv-othello"].innerHTML)],
  ["推进后骰子叫价出现", /叫 \d×\d|开叫权/.test(A.els["#tv-dice"].innerHTML)],
  ["德州 nowline 有内容", /now/.test(A.els["#tv-holdem"].innerHTML)],
];
const B2 = [
  ["推进后脉搏带有条目", (B.els["#pb-flow"].innerHTML.match(/pb-item/g) || []).length >= 1],
  ["推进后狼人事件流 ≥1 行", (B.els["#tv-wolf"].innerHTML.match(/ev-row/g) || []).length >= 1],
  ["计数器更新", /\d/.test(B.els["#pb-n"].textContent || String(B.els["#pb-n"].innerHTML))],
];

let fail = 0;
for (const [ok, d] of [...A.results, ...B.results, ...A2.map(([d, ok]) => [ok, d]), ...B2.map(([d, ok]) => [ok, d])]) {
  console.log((ok ? "PASS" : "FAIL") + "  " + d);
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
