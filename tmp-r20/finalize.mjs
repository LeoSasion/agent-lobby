// r20 草案 finalize：把真实对局快照注入两份草案 HTML（幂等：标记区间整体替换）
// 用法: node finalize.mjs
import { readFileSync, writeFileSync } from "node:fs";

const DIR = decodeURIComponent(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function load(mid) {
  const view = JSON.parse(readFileSync(DIR + `view-${mid}.json`, "utf8"));
  const events = JSON.parse(readFileSync(DIR + `events-${mid}.json`, "utf8")).events || [];
  return {
    view: { game: view.game, phase: view.phase, round: view.round, public: view.public },
    events: events.map(e => ({ seq: e.seq, type: e.type, data: e.data ?? {}, visibility: e.visibility })),
  };
}

const DATA = {
  wolf: load("m_hvi4lg44"),
  dice: load("m_gn9wsl21"),
  holdem: load("m_uc7goq6k"),
  othello: load("m_n56unofg"),
};
const payload = `window.__DATA__ = ${JSON.stringify(DATA)};`;

for (const f of ["r20-A-ministage.html", "r20-B-pulse.html"]) {
  const p = DIR + f;
  let html = readFileSync(p, "utf8");
  const re = /\/\*__DATA__\*\/|\/\*__DATA_START__\*\/[\s\S]*?\/\*__DATA_END__\*\//;
  if (!re.test(html)) { console.error(`FAIL: ${f} 无注入占位符`); process.exit(1); }
  html = html.replace(re, `/*__DATA_START__*/\n${payload}\n/*__DATA_END__*/`);
  writeFileSync(p, html);
  console.log(`injected ${f}: ${(payload.length/1024).toFixed(1)}KB 数据`);
}
console.log("done.");
