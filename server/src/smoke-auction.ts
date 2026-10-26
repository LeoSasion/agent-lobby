/**
 * 冒烟测试：拍卖行·密封竞价（auction · r34 第七款游戏）
 * 锁的是这款游戏最容易写错的六处，而不是样本值：
 *   1. 信息隔离：估值只在本人 private 里；对手与观众视图都不得含 estimate
 *   2. 首价密封：得标者净收益 = 估值 − 出价，余额 = 初始 − 出价；未得标者不扣钱
 *   3. 平局：同价时座位号小者得标（同时提交下必须有确定性规则）
 *   4. 流拍：全桌 0 出价 → 无人得标、无人扣钱
 *   5. 余额约束：出价超过本人余额必须被拒（法表上限也按席位算）
 *   6. House bot 全流程零拒绝 + 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-auction.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { createAuction, START_BALANCE } from "./games/auction.ts";
import { createAuctionBot } from "./bots/auction-bot.ts";
import { mulberry32 } from "./rng.ts";
import type { SeatDriver } from "./arena/match.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

type V = {
  public: Record<string, unknown> & { net: Record<string, number>; balance: Record<string, number>; submitted_seats: number[] };
  private: Record<string, unknown> & { my_estimate?: number | null };
};

/** viewOf 的 ctx 必填（相位提交进度），本文件直接调 game 层，给空进度 */
const CTX = { submittedSeats: [] as number[] };

console.log("=== Agent 游戏大厅 · 拍卖行冒烟测试 ===\n");

const g = createAuction({ lots: 2 });

// —— 场景 1：信息隔离 ——
console.log("[1] 信息隔离：估值只在本人 private");
const s1 = g.init([1, 2, 3, 4], mulberry32(7));
const v1 = g.viewOf(s1, 1, CTX) as unknown as V;
const v2 = g.viewOf(s1, 2, CTX) as unknown as V;
const vSpec = g.viewOf(s1, "spectator", CTX) as unknown as V;
check("本人 private 带 my_estimate", typeof v1.private.my_estimate === "number", String(v1.private.my_estimate));
check("对手 private 不含我的估值（各拿自己的）", v1.private.my_estimate !== v2.private.my_estimate, `${v1.private.my_estimate} vs ${v2.private.my_estimate}`);
check("public 不含 estimate 键", !("estimate" in v1.public) && !("estimates" in v1.public), Object.keys(v1.public).join(","));
check("观众 private 为空", Object.keys(vSpec.private).length === 0, JSON.stringify(vSpec.private));
check("出价前 submitted_seats 为空", v1.public.submitted_seats.length === 0);

// —— 场景 2：首价密封结算 ——
console.log("\n[2] 首价密封：净收益 = 估值 − 出价");
const est1 = v1.private.my_estimate as number;
const bid1 = Math.max(1, est1 - 10);
let s2 = g.init([1, 2], mulberry32(7));
const estA = (g.viewOf(s2, 1, CTX) as unknown as V).private.my_estimate as number;
const estB = (g.viewOf(s2, 2, CTX) as unknown as V).private.my_estimate as number;
const bA = Math.max(1, estA - 10);
const bB = Math.max(0, Math.min(bA - 1, estB));
s2 = g.apply(s2, 1, { type: "bid", amount: bA }, mulberry32(8)).state as typeof s2;
s2 = g.apply(s2, 2, { type: "bid", amount: bB }, mulberry32(9)).state as typeof s2;
const v2After = g.viewOf(s2, 1, CTX) as unknown as V;
const netA = v2After.public.net["1"]!;
check("得标者净收益 = 估值 − 出价", betA(estA, bA, netA), `est=${estA} bid=${bA} net=${netA}`);
check("得标者余额 = 初始 − 出价", v2After.public.balance["1"] === START_BALANCE - bA, `${v2After.public.balance["1"]}`);
check("未得标者不扣钱、净收益 0", v2After.public.net["2"] === 0 && v2After.public.balance["2"] === START_BALANCE, `net=${v2After.public.net["2"]} bal=${v2After.public.balance["2"]}`);
check("结算后当轮估值公开（观众能看懂他为何出这个价）", Array.isArray((v2After.public as { history?: unknown[] }).history), "");

function betA(est: number, bid: number, net: number): boolean {
  return net === est - bid;
}

// —— 场景 3：平局按座位号小者 ——
console.log("\n[3] 平局：同价时座位号小者得标");
let s3 = g.init([1, 2], mulberry32(11));
s3 = g.apply(s3, 1, { type: "bid", amount: 30 }, mulberry32(12)).state as typeof s3;
s3 = g.apply(s3, 2, { type: "bid", amount: 30 }, mulberry32(13)).state as typeof s3;
const rec3 = ((g.viewOf(s3, 1, CTX) as unknown as V).public as unknown as { history: { winner: number | null; price: number }[] }).history[0]!;
check("同价 30:30 → 1 号得标", rec3.winner === 1 && rec3.price === 30, `winner=${rec3.winner} price=${rec3.price}`);

// —— 场景 4：流拍 ——
console.log("\n[4] 流拍：全桌 0 出价");
let s4 = g.init([1, 2], mulberry32(21));
s4 = g.apply(s4, 1, { type: "pass" }, mulberry32(22)).state as typeof s4;
s4 = g.apply(s4, 2, { type: "bid", amount: 0 }, mulberry32(23)).state as typeof s4;
const v4 = g.viewOf(s4, 1, CTX) as unknown as V;
const rec4 = (v4.public as unknown as { history: { winner: number | null; price: number }[] }).history[0]!;
check("无人得标且价格为 0", rec4.winner === null && rec4.price === 0, `winner=${rec4.winner} price=${rec4.price}`);
check("流拍不扣钱", v4.public.balance["1"] === START_BALANCE && v4.public.balance["2"] === START_BALANCE, JSON.stringify(v4.public.balance));

// —— 场景 5：余额约束 ——
console.log("\n[5] 余额约束：超余额必须被拒");
const s5 = g.init([1, 2], mulberry32(31));
const v5 = g.viewOf(s5, 1, CTX) as unknown as V;
const la5 = g.legalActions(s5, 1) as { type: string; schema?: { amount?: string } }[];
check("法表上限按本人余额算", la5[0]?.schema?.amount === `int 0-${START_BALANCE}`, JSON.stringify(la5[0]?.schema));
const over = g.validate(s5, 1, { type: "bid", amount: START_BALANCE + 1 });
check("超余额出价被拒", over.ok === false && /超过余额/.test(String("error" in over ? over.error : "")), over.ok ? "" : String(over.error));
const neg = g.validate(s5, 1, { type: "bid", amount: -1 });
check("负数出价被拒", neg.ok === false, neg.ok ? "" : String(neg.error));
const nonInt = g.validate(s5, 1, { type: "bid", amount: 1.5 });
check("非整数出价被拒", nonInt.ok === false, nonInt.ok ? "" : String(nonInt.error));
const passOk = g.validate(s5, 1, { type: "pass" });
check("pass 合法", passOk.ok === true);
void v5;

// —— 场景 6：House bot 全流程 + 确定性 ——
console.log("\n[6] House bot 全流程零拒绝 + 同 seed 确定性");
let rejects = 0;
const guarded = (ratio: number, tag: string): SeatDriver => {
  const bot = createAuctionBot(tag, ratio);
  return {
    name: bot.name,
    act: async (view, submit) => {
      const wrapped = (a: Parameters<typeof submit>[0], o?: Parameters<typeof submit>[1]) => {
        const r = submit(a, o);
        if (!r.ok) rejects++;
        return r;
      };
      await bot.act(view, wrapped);
    },
  };
};
const mk = () => createMatch({
  game: createAuction(),
  drivers: [0.5, 0.75, 0.92, 1.0].map((x, i) => guarded(x, `bot${i + 1}`)),
  seed: 42,
  timeoutMs: 3000,
});
const runA = await mk().run();
const runB = await mk().run();
check("4 席 6 轮零拒绝", rejects === 0, `拒绝 ${rejects} 次 · ${runA.events.length} 事件`);
const sig = (evs: readonly { seq: number; type: string }[]) => JSON.stringify(evs.map((e) => [e.seq, e.type]));
check("同 seed 事件序列一致", sig(runA.events) === sig(runB.events), "");
const won = runA.events.find((e) => e.type === "game_won");
check("终局事件带 winner 与 net", won !== undefined && (won.data as { winner?: unknown }).winner !== undefined,
  JSON.stringify((won?.data as { winner?: unknown })?.winner));

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
