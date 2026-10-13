const BASE = "http://127.0.0.1:8787/api/v1";
const key = "sk__0qyhj940";
const room = "r__0bjzdkbm";
const rj = await fetch(`${BASE}/lobby/rooms/${room}/join`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
  body: "{}",
});
const jj = await rj.json();
if (!jj.join_token) { console.log("NO_JOIN_TOKEN " + JSON.stringify(jj)); process.exit(1); }
const r = await fetch(`${BASE}/lobby/rooms/${room}?token=${jj.join_token}`, {
  headers: { Authorization: `Bearer ${key}` },
});
const j = await r.json();
if (j.seat_token) console.log(j.seat_token);
else console.log("NO_SEAT_TOKEN " + JSON.stringify(j));
