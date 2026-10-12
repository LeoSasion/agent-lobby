// r16：向两份草案注入真实快照数据 + 无头验证渲染（mock DOM 断言关键视觉元素）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const slim = fs.readFileSync(path.join(root, "tmp-r16/snapshots-slim.json"), "utf8");

const targets = [
  { file: "web/drafts/r16-A-scene.html", marks: { die: "die back", hub: "dice-hub", table: "table-disc", quote: 'class="say"', felt: 'class="felt"', card: 'class="pcard', disc: 'class="disc' } },
  { file: "web/drafts/r16-B-layout.html", marks: { die: "dstat q", hub: "bid-block", table: "alive-col", quote: 'class="quote"', felt: "pot-big", card: "hcard", disc: 'class="disc' } },
];

const mkEl = () => ({
  innerHTML: "", textContent: "", className: "", style: {},
  classList: { add() {}, remove() {}, contains: () => false },
  appendChild() {}, querySelector: () => mkEl(), querySelectorAll: () => [],
  onclick: null,
});

let failed = 0;
for (const t of targets) {
  const p = path.join(root, t.file);
  let html = fs.readFileSync(p, "utf8");
  if (!html.includes("__SNAPS__")) { console.log(`[skip] ${t.file} 已注入`); }
  else {
    html = html.replace("__SNAPS__", slim.replace(/<\/script/gi, "<\\/script"));
    fs.writeFileSync(p, html);
    console.log(`[注入] ${t.file} ← ${slim.length}B 快照`);
  }

  // 无头验证：提取逻辑 <script>（最后一个）执行
  const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1] ?? html.match(/<script>\s*const SNAPS[\s\S]*?<\/script>/)?.[1];
  const els = {};
  globalThis.document = {
    querySelector: (s) => { els[s] ??= mkEl(); return els[s]; },
    querySelectorAll: () => [],
    getElementById: (id) => { els["#" + id] ??= mkEl(); return els["#" + id]; },
    createElement: () => mkEl(),
  };
  globalThis.document.getElementById("snap-data").textContent = slim;
  try {
    new Function(js + "\n;globalThis.__renders = { renderDice, renderWolf, renderHoldem, renderOth };")();
  } catch (e) {
    console.error(`  ✗ ${t.file} 脚本执行异常：${e.message}`);
    failed++; continue;
  }
  // frameBar 默认渲染每游戏第一帧（观战）——断言关键元素
  const checks = [
    ["骰子·暗骰/叫价区", (els["#st-dice"]?.innerHTML ?? "").includes(t.marks.die) || (els["#st-dice"]?.innerHTML ?? "").includes(t.marks.hub)],
    ["狼人·圆桌/引语", (els["#st-wolf"]?.innerHTML ?? "").includes(t.marks.table) || (els["#st-wolf"]?.innerHTML ?? "").includes(t.marks.quote)],
    ["德州·牌面/底池", (els["#st-holdem"]?.innerHTML ?? "").includes(t.marks.card) || (els["#st-holdem"]?.innerHTML ?? "").includes(t.marks.felt)],
    ["黑白棋·棋子", (els["#st-oth"]?.innerHTML ?? "").includes(t.marks.disc)],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) bad++;
  }
  // 本人视角帧实渲染（私有区路径）：直接调用渲染函数喂 mine 帧
  const snaps = JSON.parse(slim);
  const R = globalThis.__renders;
  const mineChecks = [
    ["骰子 mine → 我的骰", () => { const f = snaps.liars_dice.frames.find((x) => x.mine?.private?.my_dice?.length); if (f) R.renderDice(f.mine, els["#st-dice"], true); return (els["#st-dice"].innerHTML ?? "").includes("我 的 骰"); }],
    ["狼人 mine → 我的身份", () => { const f = snaps.werewolf_lite.frames.find((x) => x.mine?.private?.role); if (f) R.renderWolf(f.mine, els["#st-wolf"], true); return (els["#st-wolf"].innerHTML ?? "").includes("我 的 身 份"); }],
    ["德州 mine → 我的底牌", () => { const f = snaps.holdem_lite.frames.find((x) => x.mine?.private?.hole_cards); if (f) R.renderHoldem(f.mine, els["#st-holdem"], true); return (els["#st-holdem"].innerHTML ?? "").includes("我 的 底 牌"); }],
  ];
  for (const [name, fn] of mineChecks) {
    let ok = false;
    try { ok = fn(); } catch (e) { console.log(`  ✗ ${name}（异常 ${e.message}）`); bad++; continue; }
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) bad++;
  }
  const mineOk = Object.entries(snaps).filter(([g]) => g !== "othello").every(([g, s]) => s.frames.some((f) => f.mine && f.mine.private && Object.keys(f.mine.private).length > 0));
  console.log(`  ${mineOk ? "✓" : "✗"} 私有帧数据可达（非完全信息游戏 mine.private 非空；othello 无私有区属正常）`);
  if (!mineOk) bad++;
  if (bad) failed++;
}
console.log(failed === 0 ? "\n=== 两草案注入+验证通过 ===" : `\n=== ${failed} 份草案验证失败 ===`);
process.exit(failed === 0 ? 0 : 1);
