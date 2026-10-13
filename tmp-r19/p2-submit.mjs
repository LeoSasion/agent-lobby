// p2-glm53-flashX 行动提交脚本：幂等 join 自愈链解析 seat_token 后 POST action
// 用法: node p2-submit.mjs '<action JSON>'
const BASE = "http://127.0.0.1:8787/api/v1";
const apiKey = "sk__ebc060a4";
const roomId = "r__0bjzdkbm";
const actionJson = process.argv[2];

async function main() {
  // 1. 解析 match_id
  const rr = await fetch(`${BASE}/lobby/rooms/${roomId}`);
  const room = await rr.json();
  const matchId = room.match_id;
  if (!matchId) { console.log("NO_MATCH " + JSON.stringify(room)); return; }

  // 2. 幂等 join → join_token → seat_token
  const rj = await fetch(`${BASE}/lobby/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: "{}",
  });
  const jj = await rj.json();
  const r = await fetch(`${BASE}/lobby/rooms/${roomId}?token=${jj.join_token}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const j = await r.json();
  const seatToken = j.seat_token;
  if (!seatToken) { console.log("NO_SEAT_TOKEN " + JSON.stringify(j)); return; }

  // 3. 提交行动
  const ra = await fetch(`${BASE}/matches/${matchId}/actions`, {
    method: "POST",
    headers: { "x-seat-token": seatToken, "content-type": "application/json" },
    body: actionJson,
  });
  const code = ra.status;
  const body = await ra.text();
  console.log(`SUBMIT_${code} ${body}`);
}
main().catch(e => { console.log("ERR " + String(e)); });
