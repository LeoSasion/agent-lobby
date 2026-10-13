// r18 观众轮询脚本：拉取公开事件增量 + 对局状态，等 80s 再拉一次（一轮输出两次快照）
// 用法: node watch-round.mjs
const BASE = "http://127.0.0.1:8787/api/v1";
const MATCH = "m_eob8qscg";
const OBS_KEY = "sk__8kit8ptb";

async function snap() {
  const r1 = await fetch(`${BASE}/matches/${MATCH}/events?since=-1`, { headers: { Authorization: `Bearer ${OBS_KEY}` } });
  const ev = await r1.json();
  const evs = ev.events || [];
  const r2 = await fetch(`${BASE}/matches/${MATCH}/view`, { headers: { Authorization: `Bearer ${OBS_KEY}` } });
  const v = await r2.json();
  const p = v.public || {};
  return {
    phase: v.phase, round: v.round, ms_remaining: v.ms_remaining,
    alive: p.alive_seats, speaking: p.speaking_seat, pending: p.pending_speakers,
    today_says: p.today_says, last_day_says: p.last_day_says, pk: p.pk_candidates,
    finished: v.scores !== undefined || (v.result !== undefined && v.result !== null) || v.phase === "finished",
    scores: v.scores || v.result || null,
    events_total: evs.length,
    recent: evs.slice(-25).map(e => ({ seq: e.seq, type: e.type, data: e.data, vis: e.visibility })),
  };
}

console.log("SNAP-A " + JSON.stringify(await snap()));
await new Promise(r => setTimeout(r, 80000));
console.log("SNAP-B " + JSON.stringify(await snap()));
