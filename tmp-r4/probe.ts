/**
 * SDK DX 探针：全 API 走查 + 错误自纠 + nonce 幂等 + 边界
 * 运行：node --experimental-strip-types tmp-r4/probe.ts
 */
import { ArenaClient } from "../server/src/sdk/index.ts";

const BASE = "http://localhost:8787";
const client = new ArenaClient(BASE);
const log = (...a: unknown[]) => console.log(...a);
const hr = (s: string) => log(`\n===== ${s} =====`);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  return Promise.race([p, new Promise<{ __timeout: true }>((r) => setTimeout(() => r({ __timeout: true }), ms))]);
}

hr("A1. client.games() 输出");
const games = await client.games();
log(JSON.stringify(games, null, 2));
log("→ 注意：原始 /games 含 default_timeout_ms，SDK 映射后丢失该字段:", !("defaultTimeoutMs" in (games[0] as object) || "default_timeout_ms" in (games[0] as object)));

hr("A2. client.leaderboard('liars_dice')");
const lb = await client.leaderboard("liars_dice");
log(`条数=${lb.length}`);
log(JSON.stringify(lb.slice(0, 5), null, 2));

hr("A3. leaderboard 未知游戏");
log("leaderboard('nope') =", JSON.stringify(await client.leaderboard("nope")));

hr("A4. quickstart 未知游戏（错误清晰度）");
try {
  await client.quickstart({ game: "no_such_game" });
  log("！！未抛错（异常）");
} catch (e) {
  log("抛出:", (e as Error).message);
}

hr("A5. quickstart + view 结构");
const m = await client.quickstart({ game: "liars_dice", seats: 3, name: "tester-dice-r4" });
log(`match_id=${m.matchId} seatToken=${m.seatToken.slice(0, 10)}... apiKey=${m.apiKey.slice(0, 8)}... agentId=${m.agentId}`);
const v = await m.view();
log("view.prototype keys=", Object.keys(v));
log(`phase=${v.phase} round=${v.round} you=${JSON.stringify(v.you)} deadline_ms=${v.deadline_ms}`);
log(`public=${JSON.stringify(v.public)}`);
log(`private=${JSON.stringify(v.private)}`);
log(`legal_actions=${JSON.stringify(v.legal_actions)}`);
log(`history.len=${v.history?.length}`);

hr("A6. events(since) 增量语义");
const e0 = await m.events();
const maxSeq = e0.length ? Math.max(...e0.map((x) => x.seq)) : -1;
log(`首次 events()（默认 since=-1）条数=${e0.length} seq=[${e0.map((x) => x.seq).join(",")}]`);
const e1 = await m.events(maxSeq);
log(`增量 events(since=${maxSeq}) 条数=${e1.length} (期望 0 或仅新增)`);
log(`事件样例: ${JSON.stringify(e0[0] ?? null)}`);

hr("A7. 无效 seat_token 的 view()（错误处理）");
const bad = await client.api(`/matches/${m.matchId}/view`, { headers: { "x-seat-token": "st_invalid_token" } });
log("原始返回 =", JSON.stringify(bad));
log("→ SDK 的 m.view() 直接 `r as AgentView`，无 401 校验；此时 v.you / v.phase 均为 undefined");

// 等待轮到 seat1
async function waitActive(mm: typeof m, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const vv = await mm.view();
    if ((vv as any).phase === "finished") return "finished";
    if ((vv as any).you?.active) return "active";
    await new Promise((r) => setTimeout(r, 200));
  }
  return "timeout";
}

hr("C1. 非法动作 → 422 + code + legal_actions（自纠）");
const st = await waitActive(m);
log(`等待轮到我：${st}`);
if (st === "active") {
  const badAct = await m.act({ type: "bid", qty: 0, face: 99 } as any, { reasoning: "故意非法", nonce: "bad-1" });
  log("非法动作响应 =", JSON.stringify(badAct));
  log(`  ok=${badAct.ok} code=${badAct.code} error=${badAct.error}`);
  log(`  legal_actions=${JSON.stringify((badAct.view as any)?.legal_actions)}`);
  // 立即用合法动作自纠
  const legal = await m.act({ type: "bid", qty: 1, face: 1 }, { reasoning: "按 legal_actions 自纠", nonce: "fix-1" });
  log("自纠合法动作响应 =", `ok=${legal.ok} code=${legal.code ?? "-"}`);
}

hr("C2. nonce 幂等：同一 nonce 重发");
const st2 = await waitActive(m);
log(`等待轮到我：${st2}`);
if (st2 === "active") {
  const t0 = Date.now();
  const first = await withTimeout(m.act({ type: "bid", qty: 1, face: 2 }, { reasoning: "幂等测试", nonce: "dup-nonce-A" }), 5000);
  log(`第一次 nonce=dup-nonce-A 用时 ${Date.now() - t0}ms → ${JSON.stringify(first)}`);
  const t1 = Date.now();
  const second = await withTimeout(m.act({ type: "bid", qty: 1, face: 2 }, { reasoning: "幂等重发", nonce: "dup-nonce-A" }), 6000);
  const dt = Date.now() - t1;
  if ((second as any).__timeout) {
    log(`第二次重发（同 nonce）用时 ${dt}ms → 请求挂起未返回（超时 6s）`);
  } else {
    log(`第二次重发（同 nonce）用时 ${dt}ms → ${JSON.stringify(second)}`);
  }
}

hr("C3. 不同座位复用同一 nonce（跨座冲突）");
// 同座位重复已测；跨座位需另一个 seat token，SDK 未暴露，跳过（标注待验证）
log("SDK 无第二席位 token 获取途径，跨座位 nonce 冲突待验证（源码 match.ts:296 返回 NONCE_REUSED）");

hr("B. views() 终局干净退出 + result 是否就绪");
const m2 = await client.quickstart({ game: "liars_dice", seats: 3, name: "tester-dice-r4" });
let last: any = null;
let iterCount = 0;
const order: string[] = [];
for await (const vv of m2.views(1000)) {
  iterCount++;
  order.push(`iter${iterCount}:phase=${vv.phase},active=${vv.you.active},resultReady=${m2.result !== null}`);
  last = vv;
  if (vv.phase === "finished") break;
  if (vv.you.active) await m2.act({ type: "challenge" } as any).catch(() => {});
}
log(`迭代次数=${iterCount}`);
log("最后 6 条迭代记录:\n" + order.slice(-6).join("\n"));
log(`终局时 match.result = ${m2.result ? "已就绪" : "null"} | scores=${JSON.stringify(m2.result?.scores)} | events=${m2.result?.events?.length}`);
log(`终局视图 phase=${last?.phase}`);
// 再次调用 views() 应立刻结束
let againIter = 0;
for await (const _ of m2.views(1000)) againIter++;
log(`终局后再次调用 views() 迭代次数=${againIter}（期望 0）`);

hr("A8. SDK 导出面检查（index.ts）");
log("index 导出：ArenaClient / MatchHandle(type) / QuickstartOptions / ActOptions");
log("未导出：MatchResult / MatchHandleInit（match.result 的类型无法 import）");
log("无封装：agents 注册 / SSE stream / replay-step / 无自定义超时/中止（act 无 signal 透传）");

log("\n===== 探针结束 =====");
