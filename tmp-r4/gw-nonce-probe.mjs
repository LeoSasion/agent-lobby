/**
 * 探针：验证网关层的 nonce 幂等语义（MCP arena_act 每次调用重新生成 nonce）
 * 目的：判断 MCP 描述「nonce 自动生成（幂等重试安全）」在客户端重试场景下是否成立
 * 仅写 tmp-r4/，只读源码。
 */
const BASE = "http://localhost:8787/api/v1";

async function j(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-seat-token"] = token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const qs = await j("POST", "/lobby/quickstart", { body: { game: "othello", name: "probe-nonce-" + Math.floor(Math.random() * 1e6) } });
console.log("quickstart:", qs.status, JSON.stringify(qs.json).slice(0, 160));
const { match_id, seat_token } = qs.json;

const v0 = await j("GET", `/matches/${match_id}/view`, { token: seat_token });
const cell = v0.json.legal_actions[0].schema.values[0];
console.log(`开局 active=${v0.json.you.active} 首手 cell=${cell}`);

// A. 同 nonce 重试（模拟网络重试：第一次已成功但响应丢失）
const a1 = await j("POST", `/matches/${match_id}/actions`, { token: seat_token, body: { action: { type: "place", cell }, nonce: "fixed-A" } });
console.log("A1 首次提交:", a1.status, JSON.stringify(a1.json).slice(0, 120));
const a2 = await j("POST", `/matches/${match_id}/actions`, { token: seat_token, body: { action: { type: "place", cell }, nonce: "fixed-A" } });
console.log("A2 同 nonce 重试:", a2.status, JSON.stringify(a2.json).slice(0, 160));

// B. 不同 nonce 重试（正是 MCP 每次 arena_act 的实际行为）
const v1 = await j("GET", `/matches/${match_id}/view`, { token: seat_token });
console.log(`重试时局面 active=${v1.json.you.active} phase=${v1.json.phase} round=${v1.json.round}`);
if (v1.json.phase !== "finished" && v1.json.legal_actions[0]?.schema?.values?.length) {
  const c2 = v1.json.legal_actions[0].schema.values[0];
  const b1 = await j("POST", `/matches/${match_id}/actions`, { token: seat_token, body: { action: { type: "place", cell: c2 }, nonce: "fixed-B1" } });
  console.log("B1 提交:", b1.status, JSON.stringify(b1.json).slice(0, 120));
  const b2 = await j("POST", `/matches/${match_id}/actions`, { token: seat_token, body: { action: { type: "place", cell: c2 }, nonce: "fixed-B2" } });
  console.log("B2 换 nonce 重试:", b2.status, JSON.stringify(b2.json).slice(0, 160));
}
