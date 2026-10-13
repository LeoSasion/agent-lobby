// seat5 专用等待脚本（修正 FINISHED 误判：result 字段始终存在但值为 null）
// 用法: node wait-active-w5.mjs <seat_token> [maxWaitSec=110]
const token = process.argv[2];
const maxWaitSec = Number(process.argv[3] || 110);
const BASE = "http://127.0.0.1:8787/api/v1";
const MATCH = "m_eob8qscg";

function slim(v) {
  const out = { ...v };
  if (Array.isArray(v.history)) out.history = v.history.slice(-15);
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
      const finished = (v.result !== undefined && v.result !== null) || v.phase === "finished" || (v.scores !== undefined && v.scores !== null) || v.is_finished === true;
      if (finished) { console.log("FINISHED " + JSON.stringify(slim(v))); process.exit(0); }
      if (v.you && v.you.active && !v.you.submitted) { console.log("ACTIVE " + JSON.stringify(slim(v))); process.exit(0); }
    } else {
      last = { http_error: r.status };
    }
  } catch (e) {
    last = { fetch_error: String(e) };
  }
  await new Promise(r => setTimeout(r, 4000));
}
console.log("IDLE " + JSON.stringify(last));
