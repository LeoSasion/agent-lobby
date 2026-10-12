// r17：向草案注入事件流数据 + 无头验证（刻度数/类型着色/摘要卡/日志同步/seek 联动）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = fs.readFileSync(path.join(root, "tmp-r17/events.json"), "utf8");
const draft = path.join(root, "web/drafts/r17-timeline.html");
let html = fs.readFileSync(draft, "utf8");
if (html.includes("__EVENTS__")) {
  html = html.replace("__EVENTS__", data.replace(/<\/script/gi, "<\\/script"));
  fs.writeFileSync(draft, html);
  console.log(`[注入] r17-timeline.html ← ${data.length}B 事件流`);
} else console.log("[skip] 已注入");

// 无头验证
const js = html.match(/<script>\s*(const DATA[\s\S]*?)<\/script>/)[1];
const els = {};
const mkEl = () => ({ innerHTML: "", textContent: "", style: {}, scrollTop: 0, clientHeight: 200, offsetTop: 0, offsetHeight: 20, classList: { add() {}, remove() {}, toggle() {} } });
const evEls = {};
globalThis.document = {
  querySelector: (s) => { els[s] ??= mkEl(); return els[s]; },
  querySelectorAll: () => [],
  getElementById: (id) => evEls[id] ??= mkEl(),
  createElement: () => mkEl(),
};
globalThis.window = globalThis;
globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};

let failed = 0;
const assert = (name, cond) => { console.log(`  ${cond ? "✓" : "✗"} ${name}`); if (!cond) failed++; };

try { globalThis.document.getElementById("ev-data").textContent = data; new Function(js)(); } catch (e) { console.error("脚本异常:", e.message); process.exit(1); }

const DATA = JSON.parse(data);
// 默认渲染在终局（cur.pos = total）
const tkbar = els["#tkbar"].innerHTML;
const diceEvs = DATA.liars_dice.events;
assert("骰子局刻度数 = 事件数", (tkbar.match(/class="tk/g) || []).length === diceEvs.length);
assert("存在琥珀关键刻度（开盒对质）", tkbar.includes("tk-hot"));
assert("存在相位竖线刻度", tkbar.includes("tk-phase"));
assert("终局时全部刻度已点亮（done）", (tkbar.match(/done/g) || []).length === diceEvs.length);
assert("摘要卡显示终局 #seq", els["#nowcard"].innerHTML.includes(`#${String(diceEvs.length - 1).padStart(2, "0")}`));
assert("日志渲染全部事件", (els["#log"].innerHTML.match(/class="ev/g) || []).length === diceEvs.length);

// seek 联动：跳到中段
window.seek(10);
const tkbar2 = els["#tkbar"].innerHTML;
assert("seek 后已点亮刻度 = 11（0..10）", (tkbar2.match(/done/g) || []).length === 11);
assert("seek 后当前刻度红框标记（cur）", tkbar2.includes("cur"));
assert("日志截断到当前步（11 行）", (els["#log"].innerHTML.match(/class="ev/g) || []).length === 11);
assert("日志当前行高亮（cur）", els["#log"].innerHTML.includes("ev cur"));
assert("摘要卡更新到 #10", els["#nowcard"].innerHTML.includes("#10"));

// 切游戏验证密集局
window.switchGame("holdem_lite");
const holdemEvs = DATA.holdem_lite.events;
assert("德州局（610 事件）刻度渲染", (els["#tkbar"].innerHTML.match(/class="tk/g) || []).length === holdemEvs.length);
assert("德州存在发牌关键刻度", els["#tkbar"].innerHTML.includes("tk-hot"));

// 狼人局：said 绿刻度 + 无私有刀口事件
window.switchGame("werewolf_lite");
assert("狼人局话语绿刻度", els["#tkbar"].innerHTML.includes("tk-say"));
assert("狼人局观战流无 night_kill_decided（信息差）", !DATA.werewolf_lite.events.some((e) => e.type === "night_kill_decided"));

console.log(failed === 0 ? "\n=== r17 草案 A 验证通过 ===" : `\n=== ${failed} 项失败 ===`);

/* ── 草案 B：席位泳道 ── */
const draftB = path.join(root, "web/drafts/r17-B-lanes.html");
let htmlB = fs.readFileSync(draftB, "utf8");
if (htmlB.includes("__EVENTS__")) {
  htmlB = htmlB.replace("__EVENTS__", data.replace(/<\/script/gi, "<\\/script"));
  fs.writeFileSync(draftB, htmlB);
  console.log(`[注入] r17-B-lanes.html ← ${data.length}B 事件流`);
} else console.log("[skip] B 已注入");
const jsB = htmlB.match(/<script>\s*(const DATA[\s\S]*?)<\/script>/)[1];
globalThis.document = {
  querySelector: (s) => { els[s] ??= mkEl(); return els[s]; },
  querySelectorAll: () => [],
  getElementById: (id) => evEls[id] ??= mkEl(),
  createElement: () => mkEl(),
};
let failedB = 0;
const assertB = (name, cond) => { console.log(`  ${cond ? "✓" : "✗"} ${name}`); if (!cond) failedB++; };
try { globalThis.document.getElementById("ev-data").textContent = data; new Function(jsB)(); } catch (e) { console.error("B 脚本异常:", e.message); process.exit(1); }

const diceEvs2 = DATA.liars_dice.events;
const lanesHtml = els["#lanewrap"].innerHTML;
assertB("骰子局泳道 = 公共轨 + 3 席位", (lanesHtml.match(/class="lane"/g) || []).length === 4);
assertB("泳道事件点总数 = 事件数", (lanesHtml.match(/class="pt /g) || []).length === diceEvs2.length);
assertB("存在席位标签（1号）", lanesHtml.includes("<b>1号</b>"));
assertB("存在跨泳道红游标", lanesHtml.includes('class="cursor"'));
assertB("存在琥珀关键点", lanesHtml.includes("pt-hot"));
assertB("存在公共轨相位竖线", lanesHtml.includes("pt-phase"));
window.seek(10);
assertB("seek 后泳道重渲染（done 点点亮）", (els["#lanewrap"].innerHTML.match(/done/g) || []).length >= 11);
assertB("摘要卡更新到 #10", els["#nowcard"].innerHTML.includes("#10"));
assertB("日志截断同步（11 行）", (els["#log"].innerHTML.match(/class="ev/g) || []).length === 11);
window.switchGame("werewolf_lite");
assertB("狼人局泳道 = 公共轨 + 6 席位", (els["#lanewrap"].innerHTML.match(/class="lane"/g) || []).length === 7);
window.switchGame("holdem_lite");
assertB("德州局泳道事件点总数 = 610", (els["#lanewrap"].innerHTML.match(/class="pt /g) || []).length === DATA.holdem_lite.events.length);

const totalFailed = failed + failedB;
console.log(totalFailed === 0 ? "\n=== r17 两草案验证全部通过 ===" : `\n=== 共 ${totalFailed} 项失败 ===`);
process.exit(totalFailed === 0 ? 0 : 1);
