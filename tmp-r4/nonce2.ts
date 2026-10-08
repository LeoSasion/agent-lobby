/**
 * nonce 幂等专项：保证第一次动作为合法，再重发同 nonce，观察是否立即返回 ok / 挂起
 * 运行：node --experimental-strip-types tmp-r4/nonce2.ts
 */
import { ArenaClient } from "../server/src/sdk/index.ts";
import { decide, type LDView } from "./strategy.ts";

const client = new ArenaClient("http://localhost:8787");
const m = await client.quickstart({ game: "liars_dice", seats: 3, name: "tester-dice-r4" });
console.log(`match_id=${m.matchId}`);

async function waitActive(ms = 20000): Promise<LDView | "finished" | "timeout"> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = (await m.view()) as unknown as LDView;
    if (v.phase === "finished") return "finished";
    if (v.you?.active) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return "timeout";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  return Promise.race([p, new Promise<{ __timeout: true }>((r) => setTimeout(() => r({ __timeout: true }), ms))]);
}

const v = await waitActive();
if (v === "timeout" || v === "finished") {
  console.log(`等待失败：${v}`);
  process.exit(1);
}
const { action, reasoning } = decide(v);
console.log(`当前叫价=${JSON.stringify((v as LDView).public.current_bid)}，我选合法动作=${JSON.stringify(action)}`);
const nonce = "idem-fixed-1";

// 第一次（应成功）
const t1 = Date.now();
const r1 = await withTimeout(m.act(action, { reasoning, nonce }), 5000);
console.log(`\n[第 1 次] 用时 ${Date.now() - t1}ms → ${JSON.stringify(r1)}`);

// 立即用同 nonce 重发同一动作
const t2 = Date.now();
const r2 = await withTimeout(m.act(action, { reasoning: "同 nonce 重发", nonce }), 6000);
const dt2 = Date.now() - t2;
if ((r2 as any).__timeout) {
  console.log(`[第 2 次] 同 nonce 重发 → 挂起未返回（等待 6000ms 超时）`);
} else {
  console.log(`[第 2 次] 同 nonce 重发 用时 ${dt2}ms → ${JSON.stringify(r2)}`);
}

// 继续走完本局，观察是否有"回合被跳过/默认动作"（若第2次请求落入 early 缓冲会顶替后续回合）
console.log(`\n继续对局观察后续回合……`);
let acts = 0;
for await (const raw of m.views(1000)) {
  const vv = raw as unknown as LDView;
  if (vv.phase === "finished") break;
  if (!vv.you.active) continue;
  const d = decide(vv);
  const rr = await m.act(d.action, { reasoning: d.reasoning, nonce: `${m.matchId}-cont-${acts}` });
  acts++;
  if (!rr.ok) console.log(`  后续提交失败: ${rr.code} ${rr.error}`);
}
console.log(`后续出招 ${acts} 次，result.scores=${JSON.stringify(m.result?.scores)}`);
