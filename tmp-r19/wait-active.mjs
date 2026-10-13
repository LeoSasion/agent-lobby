// r19 等待脚本 v4（终极版）：subagent 可在开局前启动，全程自动解析凭据与对局
//   凭据三模式（r13 幂等 join 自愈链 / r15 Bearer 归属的实战应用）：
//     key  —— 普通席位：Bearer api_key → 幂等 join → join_token → seat_token（开局前 waiting 则等待）
//     host —— 房主：建房响应的 join_token → GET room?token= → seat_token
//     seat —— 已有 seat_token 直连（兼容模式）
//   FINISHED 双重确认：view 判终局 + history 含 game_won/match_ended 才输出（r18 假信号教训）
// 用法: node wait-active.mjs <key|host|seat> <凭据> <room_id> [maxWaitSec=110]
// 输出：ACTIVE/FINISHED/IDLE——IDLE 里 waiting_room/http_error 均为开局前正常态，继续下一轮
const mode = process.argv[2];
const cred = process.argv[3];
const roomId = process.argv[4];
const maxWaitSec = Number(process.argv[5] || 110);
const BASE = "http://127.0.0.1:8787/api/v1";

let seatToken = mode === "seat" ? cred : null;
let apiKey = mode === "key" ? cred : null;
let hostJoin = mode === "host" ? cred : null;
let matchId = null;

function slim(v) {
  const out = { ...v };
  if (Array.isArray(v.history)) out.history = v.history.slice(-20);
  return out;
}

async function resolveRoom() {
  const r = await fetch(`${BASE}/lobby/rooms/${roomId}`);
  if (!r.ok) return { err: r.status };
  const room = await r.json();
  return room; // {status, match_id?, players, seats_remaining...}
}

async function resolveSeatToken() {
  if (seatToken) return seatToken;
  if (mode === "host" && hostJoin) {
    const r = await fetch(`${BASE}/lobby/rooms/${roomId}?token=${hostJoin}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.seat_token) { seatToken = j.seat_token; }
  } else if (mode === "key" && apiKey) {
    const rj = await fetch(`${BASE}/lobby/rooms/${roomId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: "{}",
    });
    if (!rj.ok) return null;
    const jj = await rj.json();
    if (!jj.join_token) return null;
    const r = await fetch(`${BASE}/lobby/rooms/${roomId}?token=${jj.join_token}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.seat_token) { seatToken = j.seat_token; }
  }
  return seatToken || null;
}

const t0 = Date.now();
let last = null;
while (Date.now() - t0 < maxWaitSec * 1000) {
  try {
    const room = await resolveRoom();
    if (room.err) { last = { room_http_error: room.err }; }
    else if (room.status === "started" && room.match_id) {
      matchId = room.match_id;
      const tok = await resolveSeatToken();
      if (!tok) { last = { started_but_no_seat_token: true }; }
      else {
        const r = await fetch(`${BASE}/matches/${matchId}/view`, { headers: { "x-seat-token": tok } });
        if (r.status === 404) { seatToken = null; matchId = null; last = { http_error: 404 }; }
        else if (r.ok) {
          const v = await r.json();
          last = v;
          const finished =
            v.phase === "finished" ||
            v.is_finished === true ||
            (v.result !== undefined && v.result !== null) ||
            v.scores !== undefined;
          if (finished) {
            const confirmed = (v.history || []).some(e => e.type === "game_won" || e.type === "match_ended");
            if (confirmed) { console.log("FINISHED " + JSON.stringify(slim(v))); process.exit(0); }
            last = { suspicious_finished_signal: true, phase: v.phase };
          }
          if (v.you && v.you.active) { console.log("ACTIVE " + JSON.stringify(slim(v))); process.exit(0); }
        } else { last = { http_error: r.status }; }
      }
    } else {
      last = { waiting_room: room.status, players: room.players, remaining: room.seats_remaining };
    }
  } catch (e) {
    last = { fetch_error: String(e) };
  }
  await new Promise(r => setTimeout(r, 4000));
}
console.log("IDLE " + JSON.stringify(last));
