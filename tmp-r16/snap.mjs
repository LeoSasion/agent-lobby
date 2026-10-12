// r16：为渲染器草案抓真实 view 快照——每游戏 quickstart 一桌（人类最小参与），
// 终局后扫 events 按阶段挑代表性 seq，用 replay/step 拉观战帧 + 私有帧（seat=1 本人 token）
import fs from "node:fs";

const BASE = "http://localhost:8787/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (url, body, headers) => j(url, {
  method: "POST",
  headers: { "content-type": "application/json", ...(headers ?? {}) },
  body: JSON.stringify(body),
});

const snaps = {};

async function capture(game, seats, actFn) {
  const qs = await post(`${BASE}/lobby/quickstart`, { game, seats });
  if (!qs.body?.match_id) { console.error(`[snap] ${game} quickstart 失败:`, qs.body); return; }
  const { match_id, seat_token, seat_id } = qs.body;
  const H = { "x-seat-token": seat_token };
  console.log(`[snap] ${game} → ${match_id}（人类 ${seat_id} 号）`);

  // 人类最小参与：轮到就做一个动作，制造真实历史
  for (let i = 0; i < 40; i++) {
    const v = (await j(`${BASE}/matches/${match_id}/view`, { headers: H })).body;
    if (!v || v.phase === "finished") break;
    if (!v.you?.active) { await sleep(250); continue; }
    await actFn(v, match_id, H);
    await sleep(250);
  }
  // 等终局（bot 秒打）
  for (let i = 0; i < 160; i++) {
    const v = (await j(`${BASE}/matches/${match_id}/view`)).body;
    if (v?.phase === "finished") break;
    await sleep(500);
  }
  console.log(`[snap] ${game} 终局`);

  // 扫 events 挑代表性 seq（按 phase_started 变化分段，取各段中点+终点）
  const evs = (await j(`${BASE}/matches/${match_id}/events?since=-1`)).body.events;
  const segs = []; // {phase, startSeq, endSeq}
  for (const ev of evs) {
    if (ev.type === "phase_started") {
      const ph = `${ev.data.phase}#${ev.data.round}`;
      if (segs.length === 0 || segs[segs.length - 1].ph !== ph) segs.push({ ph, phase: ev.data.phase, round: ev.data.round, startSeq: ev.seq, endSeq: ev.seq });
      else segs[segs.length - 1].endSeq = ev.seq;
    } else if (segs.length > 0) segs[segs.length - 1].endSeq = ev.seq;
  }
  const lastSeq = evs[evs.length - 1].seq;
  const frames = [];
  const grab = async (tag, seq) => {
    const spec = (await j(`${BASE}/matches/${match_id}/replay/step?to=${seq}`)).body;
    const mine = (await j(`${BASE}/matches/${match_id}/replay/step?to=${seq}&seat=${seat_id}`, { headers: H })).body;
    frames.push({ tag, seq, spectator: spec?.view ?? spec, mine: mine?.view ?? mine });
  };
  // 挑段：每游戏最多 3 个代表帧（首个非开局段中点 + 有话语/街道变化的段 + 终局）
  const mid = (s) => Math.floor((s.startSeq + s.endSeq) / 2);
  const picks = [];
  const daySeg = segs.find((s) => s.phase === "day");               // 狼人白天（says）
  const streetSegs = segs.filter((s) => ["flop", "turn", "river"].includes(s.phase)); // 德州街道
  const firstSeg = segs.find((s) => s.startSeq > 0);                // 首个真实段（骰子/othello 中局）
  if (daySeg) picks.push({ tag: `白天·第${daySeg.round}天·演说中`, seq: mid(daySeg) });
  if (streetSegs.length) picks.push({ tag: `街道·${streetSegs[0].phase}·第${streetSegs[0].round}手`, seq: mid(streetSegs[0]) });
  if (firstSeg && picks.length < 2) picks.push({ tag: `中局·${firstSeg.phase}·第${firstSeg.round}轮`, seq: mid(firstSeg) });
  picks.push({ tag: "终局", seq: lastSeq });
  for (const p of picks) { await grab(p.tag, p.seq); console.log(`  帧 ${p.tag} @seq${p.seq}`); }

  snaps[game] = { match_id, seat_id, frames };
}

await capture("liars_dice", 3, async (v, mid, H) => {
  const t = v.legal_actions.map((a) => a.type);
  if (t.includes("challenge")) return post(`${BASE}/matches/${mid}/actions`, { type: "challenge" }, H);
  return post(`${BASE}/matches/${mid}/actions`, { type: "bid", qty: 1, face: 6 }, H);
});
await capture("werewolf_lite", 6, async (v, mid, H) => {
  const t = v.legal_actions.map((a) => a.type);
  if (t.includes("say")) return post(`${BASE}/matches/${mid}/actions`, { type: "say", text: "我是好人，先听大家的口径。" }, H);
  if (t.includes("vote")) return post(`${BASE}/matches/${mid}/actions`, { type: "vote", target: v.legal_actions.find((a) => a.type === "vote").schema.values[0] }, H);
  if (t.includes("check")) return post(`${BASE}/matches/${mid}/actions`, { type: "check", target: v.legal_actions.find((a) => a.type === "check").schema.values[0] }, H);
  if (t.includes("last_words")) return post(`${BASE}/matches/${mid}/actions`, { type: "last_words", text: "我把信息留在场上，大家加油。" }, H);
  if (t.includes("kill")) return post(`${BASE}/matches/${mid}/actions`, { type: "pass" }, H);
  return null;
});
await capture("holdem_lite", 3, async (v, mid, H) => {
  const t = v.legal_actions.map((a) => a.type);
  if (t.includes("call")) return post(`${BASE}/matches/${mid}/actions`, { type: "call" }, H);
  if (t.includes("check")) return post(`${BASE}/matches/${mid}/actions`, { type: "check" }, H);
  if (t.includes("fold")) return post(`${BASE}/matches/${mid}/actions`, { type: "fold" }, H);
  return null;
});
await capture("othello", 2, async (v, mid, H) => {
  const place = v.legal_actions.find((a) => a.type === "place");
  if (place) return post(`${BASE}/matches/${mid}/actions`, { type: "place", cell: place.schema.values[Math.floor(place.schema.values.length / 2)] }, H);
  return post(`${BASE}/matches/${mid}/actions`, { type: "pass" }, H);
});

fs.mkdirSync("tmp-r16", { recursive: true });
fs.writeFileSync("tmp-r16/snapshots.json", JSON.stringify(snaps, null, 2));
console.log("\n[snap] 已写 tmp-r16/snapshots.json");
for (const [g, s] of Object.entries(snaps)) {
  console.log(`  ${g}: ${s.frames.length} 帧（${s.frames.map((f) => f.tag).join(" / ")}）`);
}
