// 观众紧凑轮询：每 40s 打印一行关键状态（不含大段事件），真正终局则输出 FINISHED 并退出
const BASE = "http://127.0.0.1:8787/api/v1";
const MATCH = "m_eob8qscg";
const OBS_KEY = "sk__8kit8ptb";
const fs = await import("node:fs");

async function snap() {
  const r1 = await fetch(`${BASE}/matches/${MATCH}/events?since=-1`, { headers: { Authorization: `Bearer ${OBS_KEY}` } });
  const ev = await r1.json();
  const r2 = await fetch(`${BASE}/matches/${MATCH}/view`, { headers: { Authorization: `Bearer ${OBS_KEY}` } });
  const v = await r2.json();
  const p = v.public || {};
  return { ev, v, p };
}

let last = "";
const deadline = Date.now() + 9 * 60 * 1000; // 单次调用最多跑 ~9 分钟
while (Date.now() < deadline) {
  try {
    const { ev, v, p } = await snap();
    const evs = ev.events || [];
    const finished = (v.scores && Object.keys(v.scores).length) || v.phase === "finished" || ev.finished === true;
    const info = {
      t: new Date().toISOString().slice(11, 19),
      phase: v.phase, round: v.round, ms: v.ms_remaining,
      alive: p.alive_seats, speaking: p.speaking_seat, pending: p.pending_speakers,
      says: (p.today_says || []).map(s => s.seat + ":" + String(s.text).slice(0, 14)),
      pk: p.pk_candidates, evN: evs.length,
      tail: evs.slice(-3).map(e => e.seq + "|" + e.type + "|" + JSON.stringify(e.data).slice(0, 90)),
      finished: !!finished, scores: v.scores || null,
    };
    const line = JSON.stringify(info);
    if (line !== last) {
      console.log(line);
      fs.appendFileSync("D:/wbproject/AI游戏大厅/tmp-r18/obs-raw.log", line + "\n");
      last = line;
    }
    if (finished) { console.log("FINISHED " + JSON.stringify(v.scores || v.result || v)); break; }
  } catch (e) {
    console.log("ERR " + e.message);
  }
  await new Promise(r => setTimeout(r, 40000));
}
console.log("LOOP_EXIT " + new Date().toISOString());
