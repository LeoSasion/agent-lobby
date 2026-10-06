/**
 * 冒烟测试：Arena 内核 + 吹牛骰 端到端验证
 * 覆盖：完整对局 / 信息隔离 / 确定性（同 seed 同事件流）/ 事件回放 / 超时兜底
 * 运行：node --experimental-strip-types src/main.ts
 */

import { createLiarsDice } from "./games/liars-dice.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { createHangingBot, createRuleBot } from "./bots/rule-bot.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

/** 包装驱动：每次收到视图时断言无越权字段（信息隔离专项测试的最小实现） */
function withLeakCheck(inner: SeatDriver, violations: string[]): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      const pubJson = JSON.stringify(view.public);
      if (pubJson.includes("my_dice")) violations.push(`seat${view.you.seat}: public 泄漏 my_dice`);
      if (/"dice"\s*:/.test(pubJson)) violations.push(`seat${view.you.seat}: public 泄漏原始骰子`);
      for (const k of Object.keys(view.private)) {
        if (k !== "my_dice") violations.push(`seat${view.you.seat}: private 意外字段 ${k}`);
      }
      const my = view.private.my_dice as number[] | undefined;
      if (my) {
        const players = view.public.players as { seat: number; dice_count: number }[];
        const me = players.find((p) => p.seat === view.you.seat);
        if (me && my.length !== me.dice_count) {
          violations.push(`seat${view.you.seat}: my_dice 长度 ${my.length} 与 dice_count ${me.dice_count} 不符`);
        }
      }
      await inner.act(view, submit);
    },
  };
}

const game = createLiarsDice();
console.log("=== Agent 游戏大厅 · 内核冒烟测试（arena/v0）===\n");

// —— 场景 1：3 个规则 bot 完整对局（固定 seed）——
console.log("[场景 1] 吹牛骰 · 3 个规则 bot · seed=20261006");
const violations: string[] = [];
const bots: SeatDriver[] = [
  withLeakCheck(createRuleBot("bot-甲·谨慎", 0.3), violations),
  withLeakCheck(createRuleBot("bot-乙·均衡", 0.5), violations),
  withLeakCheck(createRuleBot("bot-丙·激进", 0.7), violations),
];
const r1 = await createMatch({ game, drivers: bots, seed: 20261006 }).run();

const rounds = r1.events.filter((e) => e.type === "round_started").length + 1;
const winnerSeat = Number(Object.entries(r1.scores).find(([, v]) => v === 1)?.[0] ?? -1);
const winnerName = winnerSeat > 0 ? bots[winnerSeat - 1].name : "无";
console.log(`  回合数 ${rounds} · 事件数 ${r1.events.length} · 胜者：座位${winnerSeat}（${winnerName}）`);
console.log("  时间线：");
const shown = r1.events.slice(0, 40);
for (const ev of shown) {
  const d = JSON.stringify(ev.data);
  console.log(
    `    #${String(ev.seq).padStart(2, "0")} ${ev.type.padEnd(18)} ${d.length > 88 ? d.slice(0, 88) + "…" : d}`,
  );
}
if (r1.events.length > shown.length) {
  console.log(`    …（其余 ${r1.events.length - shown.length} 个事件省略）`);
}
check("对局完整结束且产生唯一胜者", winnerSeat > 0);
check("信息隔离：全部视图无越权字段", violations.length === 0, violations.length ? violations[0] : "0 违规");

// —— 场景 2：确定性 ——
console.log("\n[场景 2] 确定性：同 seed 重跑");
const m2 = createMatch({
  game,
  drivers: [
    createRuleBot("bot-甲·谨慎", 0.3),
    createRuleBot("bot-乙·均衡", 0.5),
    createRuleBot("bot-丙·激进", 0.7),
  ],
  seed: 20261006,
});
const r2 = await m2.run();
check("事件序列完全一致", hashEvents(r1.events) === hashEvents(r2.events), `hash=${hashEvents(r1.events)}`);

// —— 场景 3：事件回放 ——
console.log("\n[场景 3] 事件回放：seed + acted 序列重建终局");
const rp = replayEvents(game, r1.events);
check("回放终局分数一致", JSON.stringify(rp.scores) === JSON.stringify(r1.scores));
check(
  "回放游戏事件一致",
  JSON.stringify(rp.gameEvents) === JSON.stringify(r1.gameEvents),
  `${rp.gameEvents.length} 个游戏事件`,
);

// —— 场景 4：超时兜底 ——
console.log("\n[场景 4] 超时兜底：1 个挂起 bot · timeout=60ms");
const t0 = Date.now();
const r4 = await createMatch({
  game,
  drivers: [
    createRuleBot("bot-甲·谨慎", 0.3),
    createHangingBot("bot-挂起"),
    createRuleBot("bot-丙·激进", 0.7),
  ],
  seed: 99,
  timeoutMs: 60,
}).run();
const elapsed = Date.now() - t0;
const timeouts = r4.events.filter((e) => e.type === "timed_out").length;
check("挂起 bot 未阻塞比赛", Object.values(r4.scores).includes(1), `耗时 ${elapsed}ms`);
check("超时默认动作生效", timeouts > 0, `timed_out × ${timeouts}`);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
