// r19 观众轮询脚本 v2：支持等开局（房间解析）+ 终局判定修正（r18 教训）
// 用法: node watch-round.mjs
const BASE = "http://127.0.0.1:8787/api/v1";
const ROOM = process.argv[2] || null; // 新局房间号，运行时传入
const OBS_KEY = process.argv[3] || null;

function pickRoom() {
  if (ROOM) return { id: ROOM, key: OBS_KEY };
  return { id: "r__4wrj58ek", key: "sk__8kit8ptb" }; // 缺省回退：r18 旧局
}

async function snap() {
  const { id, key } = pickRoom();
  // 房间状态（无鉴权）
  const r0 = await fetch(`${BASE}/lobby/rooms/${id}`);
  if (!r0.ok) return { room_http_error: r0.status };
  const room = await r0.json();
  if (room.status !== "started" || !room.match_id) return { waiting_room: room.status };
  const mid = room.match_id;
  const hdr = key ? { Authorization: `Bearer ${key}` } : {};
  const r1 = await fetch(`${BASE}/matches/${mid}/events?since=-1`, { headers: hdr });
  const ev = await r1.json();
  const evs = ev.events || [];
  const r2 = await fetch(`${BASE}/matches/${mid}/view`, { headers: hdr });
  const v = await r2.json();
  const p = v.public || {};
  return {
    match: mid, phase: v.phase, round: v.round, ms_remaining: v.ms_remaining,
    alive: p.alive_seats, speaking: p.speaking_seat, pending: p.pending_speakers,
    today_says: p.today_says, last_day_says: p.last_day_says, pk: p.pk_candidates,
    finished: (v.scores !== undefined) || (v.result !== undefined && v.result !== null) || v.phase === "finished",
    scores: v.scores || v.result || null,
    events_total: evs.length,
    recent: evs.slice(-25).map(e => ({ seq: e.seq, type: e.type, data: e.data, vis: e.visibility })),
  };
}

console.log("SNAP-A " + JSON.stringify(await snap()));
await new Promise(r => setTimeout(r, 80000));
console.log("SNAP-B " + JSON.stringify(await snap()));
