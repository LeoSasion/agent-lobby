// r17：为回放时间轴草案抓四游戏完整观战事件流（选最近已终局的各游戏对局）
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = "http://localhost:8787/api/v1";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function j(url) { const r = await fetch(url); return r.json(); }

const list = await j(`${BASE}/matches`);
const byGame = {};
for (const m of (list.matches ?? [])) {
  if (m.finished && !m.aborted && !byGame[m.game]) byGame[m.game] = m.match_id;
}
console.log("选中对局：", byGame);

const out = {};
for (const [game, mid] of Object.entries(byGame)) {
  const evs = (await j(`${BASE}/matches/${mid}/events?since=-1`)).events ?? [];
  out[game] = { match_id: mid, events: evs.map((e) => ({ seq: e.seq, type: e.type, data: e.data })) };
  console.log(`  ${game}: ${evs.length} 事件（${evs.filter((e) => e.type === "phase_started").length} 相位）`);
}
fs.mkdirSync(path.join(root, "tmp-r17"), { recursive: true });
fs.writeFileSync(path.join(root, "tmp-r17/events.json"), JSON.stringify(out));
console.log("已写 tmp-r17/events.json");
