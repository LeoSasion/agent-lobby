/**
 * 收尾验证：终局后再次调用 views() 是否立即结束；act() 成功返回的 view 是否陈旧
 * 运行：node --experimental-strip-types tmp-r4/verify.ts
 */
import { ArenaClient } from "../server/src/sdk/index.ts";
import { decide, type LDView } from "./strategy.ts";

const client = new ArenaClient("http://localhost:8787");
const m = await client.quickstart({ game: "liars_dice", seats: 3, name: "tester-dice-r4" });
console.log(`match_id=${m.matchId}`);

let staleChecked = false;
for await (const raw of m.views(1000)) {
  const v = raw as unknown as LDView;
  if (v.phase === "finished") break;
  if (!v.you.active) continue;
  const { action, reasoning } = decide(v);
  const r = await m.act(action, { reasoning, nonce: `${m.matchId}-${Math.random().toString(36).slice(2)}` });
  if (r.ok && !staleChecked) {
    staleChecked = true;
    const inResp = (r.view as any)?.public?.current_bid ?? null;
    const fresh = ((await m.view()) as unknown as LDView).public.current_bid ?? null;
    console.log(`\n[陈旧视图检查] 我提交 ${JSON.stringify(action)}`);
    console.log(`  act() 返回的 view.current_bid = ${JSON.stringify(inResp)}`);
    console.log(`  紧接着 view() 拉取的 current_bid = ${JSON.stringify(fresh)}`);
    console.log(`  → ${JSON.stringify(inResp) === JSON.stringify(fresh) ? "一致" : "不一致（act 返回视图未包含刚提交的动作）"}`);
  }
}

console.log(`\n[终局] result.scores=${JSON.stringify(m.result?.scores)} events=${m.result?.events?.length}`);
let again = 0;
for await (const _ of m.views(1000)) again++;
console.log(`[终局后再次调用 views()] 迭代次数=${again}（源码 _finished 置位，期望 0）`);
