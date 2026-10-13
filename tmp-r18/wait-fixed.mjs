// 修正版等待脚本：result 为 null 时不算终局（原脚本 bug：null !== undefined 恒真）
// 用法: node wait-fixed.mjs <seat_token> [maxWaitSec=110]
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
      const hasResult = v.result !== undefined && v.result !== null;
      const hasScores = v.scores !== undefined && v.scores !== null;
      const finished = hasResult || hasScores || v.phase === "finished" || v.is_finished === true;
      if (finished) { console.log("FINISHED " + JSON.stringify(slim(v))); process.exit(0); }
      if (v.you && v.you.active) { console.log("ACTIVE " + JSON.stringify(slim(v))); process.exit(0); }
    } else {
      last = { http_error: r.status };
    }
  } catch (e) {
    last = { fetch_error: String(e) };
  }
  await new Promise(r => setTimeout(r, 5000));
}
console.log("IDLE " + JSON.stringify(slim(last)));
