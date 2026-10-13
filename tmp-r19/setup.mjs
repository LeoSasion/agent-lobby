// r19 编排：注册 7 agent → p1 建房（werewolf_lite 6 席 180s）→ p2-p5 join（5/6 满）
// 第 6 席（p6）故意不 join——等 subagents 全部就位后由主 agent join 触发自动开局
const BASE = "http://127.0.0.1:8787/api/v1";

const agents = [
  { key: "p1-deepseek-v41f", reg: { name: "p1-deepseek-v41f", description: "r19 seat1 deepseek-v4.1-flash" } },
  { key: "p2-glm53-flashX", reg: { name: "p2-glm53-flashX", description: "r19 seat2 glm5.3-flashX" } },
  { key: "p3-step5-a", reg: { name: "p3-step5-a", description: "r19 seat3 Step-5-preview" } },
  { key: "p4-step5-b", reg: { name: "p4-step5-b", description: "r19 seat4 Step-5-preview" } },
  { key: "p5-step5-c", reg: { name: "p5-step5-c", description: "r19 seat5 Step-5-preview" } },
  { key: "p6-step5-d", reg: { name: "p6-step5-d", description: "r19 seat6 Step-5-preview" } },
  { key: "obs-deepseek-v41f", reg: { name: "obs-deepseek-v41f", description: "r19 观众 deepseek-v4.1-flash" } },
];

const out = { base: BASE, game: "werewolf_lite", agents: {}, join_tokens: {} };

for (const a of agents) {
  const r = await fetch(`${BASE}/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(a.reg),
  });
  const j = await r.json();
  if (!r.ok) { console.error("REGISTER FAIL", a.key, r.status, JSON.stringify(j)); process.exit(1); }
  out.agents[a.key] = { agent_id: j.agent_id, api_key: j.api_key };
  console.log(`registered ${a.key} -> ${j.agent_id}`);
}

// p1 建房（房主占 seat1）
const host = out.agents["p1-deepseek-v41f"];
const rr = await fetch(`${BASE}/lobby/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${host.api_key}` },
  body: JSON.stringify({ game: "werewolf_lite", seats: 6, timeout_ms: 180000, name: "r19 多模型对照局" }),
});
const room = await rr.json();
if (!rr.ok) { console.error("CREATE ROOM FAIL", rr.status, JSON.stringify(room)); process.exit(1); }
out.room_id = room.room_id;
out.host_join_token = room.join_token;
console.log(`room ${room.room_id} created (seats=${room.seats}, host=p1)`);

// p2-p5 join（第 6 席留给开局触发）
for (const key of ["p2-glm53-flashX", "p3-step5-a", "p4-step5-b", "p5-step5-c"]) {
  const r = await fetch(`${BASE}/lobby/rooms/${room.room_id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${out.agents[key].api_key}` },
    body: JSON.stringify({}),
  });
  const j = await r.json();
  if (!r.ok) { console.error("JOIN FAIL", key, r.status, JSON.stringify(j)); process.exit(1); }
  out.join_tokens[key] = j.join_token;
  console.log(`joined ${key} (player_index=${j.player_index}, status=${j.status})`);
}

// 各席取 seat_token（5/6 满，开局前 seat_token 可取吗？——上次是开局后取的。先试）
for (const [key, tok] of Object.entries(out.join_tokens)) {
  const r = await fetch(`${BASE}/lobby/rooms/${room.room_id}?token=${tok}`, {
    headers: { Authorization: `Bearer ${out.agents[key].api_key}` },
  });
  const j = await r.json();
  if (r.ok && j.seat_token) {
    out.agents[key].seat_token = j.seat_token;
    out.agents[key].seat = j.seat_id;
    console.log(`seat_token ${key}: seat=${j.seat_id} token=${j.seat_token}`);
  } else {
    console.log(`seat_token ${key}: 未取到（r=${r.status}, ${JSON.stringify(j).slice(0, 120)}）——开局后需补取`);
  }
}
// 房主 seat_token（用 host join_token）
{
  const r = await fetch(`${BASE}/lobby/rooms/${room.room_id}?token=${out.host_join_token}`, {
    headers: { Authorization: `Bearer ${host.api_key}` },
  });
  const j = await r.json();
  if (r.ok && j.seat_token) {
    out.agents["p1-deepseek-v41f"].seat_token = j.seat_token;
    out.agents["p1-deepseek-v41f"].seat = j.seat_id;
    console.log(`seat_token p1: seat=${j.seat_id} token=${j.seat_token}`);
  } else {
    console.log(`seat_token p1: 未取到（r=${r.status}, ${JSON.stringify(j).slice(0, 120)}）——开局后需补取`);
  }
}

await (await import("node:fs/promises")).writeFile(
  new URL("./credentials.json", import.meta.url),
  JSON.stringify(out, null, 2),
);
console.log("\ncredentials.json written. 房间当前 5/6 满——等待 subagents 就位后再 join p6 触发开局。");
