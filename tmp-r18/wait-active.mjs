// r18 共用等待脚本（w2 修正版收编）：正确区分 ACTIVE / FINISHED / IDLE
// 用法: node wait-active.mjs <seat_token> [maxWaitSec=110]
// 退出码 0；输出三态：
//   ACTIVE <viewJSON>   —— 轮到你了，立即决策并 POST action
//   FINISHED <viewJSON> —— 对局已终局，写报告
//   IDLE <viewJSON>     —— 等待窗口内未轮到（输出最新 view 供观察）
// 注意：view 恒带 result:null（未终局时），必须同时判 !== null
const token = process.argv[2];
const maxWaitSec = Number(process.argv[3] || 110);
const BASE = "http://127.0.0.1:8787/api/v1";
const MATCH = "m_eob8qscg";

function slim(v) {
  const out = { ...v };
  if (Array.isArray(v.history)) out.history = v.history.slice(-20);
  return out;
}

const t0 = Date.now();
let last = null;
while (Date.now() - t0 < maxWaitSec * 1000) {
  try {
    const r = await fetch(`${BASE}/matches/${MATCH}/view`, { headers: { "x-seat-token": token } });
    if (r.ok) {
      const v = await r.json();
      last = v;
      const finished =
        v.phase === "finished" ||
        v.is_finished === true ||
        (v.result !== undefined && v.result !== null) ||
        v.scores !== undefined;
      if (finished) { console.log("FINISHED " + JSON.stringify(slim(v))); process.exit(0); }
      if (v.you && v.you.active) { console.log("ACTIVE " + JSON.stringify(slim(v))); process.exit(0); }
    } else {
      last = { http_error: r.status };
    }
  } catch (e) {
    last = { fetch_error: String(e) };
  }
  await new Promise(r => setTimeout(r, 3000));
}
console.log("IDLE " + JSON.stringify(last ? slim(last) : null));
