/**
 * 框架级不变量测试（与具体游戏解耦 —— 规划 §8 工程纪律的通用化实现）
 * 对全部游戏统一执行六类检查：
 *   1. 非法动作拒绝矩阵（validate 必须拒绝且错误可定位）
 *   2. 全超时对局可完赛（每个动作都是超时默认 → 顺带验证默认动作合法性）
 *   3. 无 match_failed（内核/游戏无异常）
 *   4. 回放一致性（seed + acted 序列重建终局）
 *   5. 事件级信息隔离（私有事件仅授权席位可见，覆盖全部游戏）
 *   6. 同 seed 确定性
 * 运行：node --experimental-strip-types src/smoke-framework.ts
 */

import { createLiarsDice } from "./games/liars-dice.ts";
import { createOthello } from "./games/othello.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createHoldemLite } from "./games/holdem-lite.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { createHangingBot, createRuleBot } from "./bots/rule-bot.ts";
import { createOthelloBot } from "./bots/othello-bot.ts";
import { createWerewolfBot } from "./bots/werewolf-bot.ts";
import { createHoldemBot } from "./bots/holdem-bot.ts";
import type { GameModule } from "./games/types.ts";
import type { Match, SeatDriver } from "./arena/match.ts";
import type { Action, SeatId } from "./protocol.ts";
import { mulberry32 } from "./rng.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

interface BadCase {
  seat: SeatId;
  action: Action;
  mustInclude: string;
}
interface Suite {
  name: string;
  game: GameModule<unknown>;
  seats: number;
  makeBots: () => SeatDriver[];
  seeds: number[];
  illegal: (game: GameModule<unknown>, state: unknown) => BadCase[];
}

const suites: Suite[] = [
  {
    name: "吹牛骰",
    game: createLiarsDice(),
    seats: 3,
    makeBots: () => [createRuleBot("甲", 0.4), createRuleBot("乙", 0.6), createRuleBot("丙", 0.5)],
    seeds: [1, 42, 777],
    illegal: () => [
      { seat: 1, action: { type: "bid", qty: 0, face: 99 }, mustInclude: "qty" },
      { seat: 1, action: { type: "nonsense" }, mustInclude: "未知动作" },
      { seat: 2, action: { type: "bid", qty: 1, face: 1 }, mustInclude: "NOT_YOUR_TURN" },
    ],
  },
  {
    name: "黑白棋",
    game: createOthello(),
    seats: 2,
    makeBots: () => [createOthelloBot("位置流", 0), createOthelloBot("吃子流", 1)],
    seeds: [2, 88, 2026],
    illegal: () => [
      { seat: 1, action: { type: "place", cell: 0 }, mustInclude: "无法翻转" },
      { seat: 1, action: { type: "pass" }, mustInclude: "不可虚着" },
      { seat: 2, action: { type: "place", cell: 19 }, mustInclude: "NOT_YOUR_TURN" },
    ],
  },
  {
    name: "狼人杀·简化",
    game: createWerewolfLite(),
    seats: 6,
    makeBots: () => [0, 1, 2, 3, 4, 5].map((i) => createWerewolfBot(`bot-${i}`, i)),
    seeds: [3, 66, 6666],
    illegal: (g, state) => {
      const role = (seat: SeatId) => (g.viewOf(state, seat).private as { role?: string }).role;
      const all = [1, 2, 3, 4, 5, 6];
      const wolf = all.find((s) => role(s) === "werewolf")!;
      const teammate = all.find((s) => s !== wolf && role(s) === "werewolf")!;
      const villager = all.find((s) => role(s) === "villager")!;
      return [
        { seat: wolf, action: { type: "kill", target: teammate }, mustInclude: "非狼" },
        { seat: wolf, action: { type: "kill", target: 99 }, mustInclude: "ILLEGAL" },
        { seat: villager, action: { type: "kill", target: 1 }, mustInclude: "NOT_YOUR_TURN" },
      ];
    },
  },
  {
    name: "德州扑克·简化",
    game: createHoldemLite(),
    seats: 3,
    makeBots: () => [
      createHoldemBot("紧凶", 0.3),
      createHoldemBot("松凶", 0.8),
      createHoldemBot("稳健", 0.5),
    ],
    seeds: [5, 99, 4242],
    illegal: (g, state) => {
      // 用 viewOf 取当前行动者（不依赖游戏内部字段命名；viewOf 是唯一出口）
      const pub = g.viewOf(state, "spectator").public as { to_act: number | null };
      const actor = pub.to_act ?? 1;
      return [
        { seat: actor, action: { type: "raise", to: 5 }, mustInclude: "ILLEGAL" },
        { seat: actor, action: { type: "nonsense" }, mustInclude: "未知动作" },
        { seat: actor === 1 ? 2 : 1, action: { type: "fold" }, mustInclude: "NOT_YOUR_TURN" },
      ];
    },
  },
];

console.log("=== Agent 游戏大厅 · 框架不变量测试 ===\n");

for (const c of suites) {
  console.log(`[ ${c.name} · ${c.seats} 席 ]`);
  const seatIds = Array.from({ length: c.seats }, (_, i) => i + 1);

  // 1) 非法动作拒绝矩阵
  const initRng = mulberry32(12345);
  const st = c.game.init(seatIds, initRng);
  for (const bad of c.illegal(c.game, st)) {
    const v = c.game.validate(st, bad.seat, bad.action);
    check(
      `非法动作被拒 seat${bad.seat} ${JSON.stringify(bad.action).slice(0, 44)}`,
      !v.ok && v.error.includes(bad.mustInclude),
      v.ok ? "竟然放行了" : v.error.slice(0, 44),
    );
  }

  // 2-5) 全超时对局 × 多 seed
  for (const seed of c.seeds) {
    const drivers = seatIds.map(() => createHangingBot("挂起"));
    const m: Match = createMatch({ game: c.game, drivers, seed, timeoutMs: 25 });
    const r = await m.run();
    check(
      `全超时完赛且无 match_failed（seed ${seed}）`,
      Object.keys(r.scores).length === c.seats && !r.events.some((e) => e.type === "match_failed"),
      `${r.events.length} 事件 · timed_out × ${r.events.filter((e) => e.type === "timed_out").length}`,
    );
    const rp = replayEvents(c.game, r.events);
    check(
      `回放一致（seed ${seed}）`,
      JSON.stringify(rp.scores) === JSON.stringify(r.scores) && JSON.stringify(rp.gameEvents) === JSON.stringify(r.gameEvents),
    );
    let leak = 0;
    let priv = 0;
    for (const ev of r.events) {
      if (ev.visibility === "all") continue;
      priv++;
      for (const s of seatIds) {
        if (ev.visibility.seats.includes(s)) continue;
        if (m.eventsFor(s).some((e) => e.seq === ev.seq)) leak++;
      }
    }
    check(`私有事件零泄漏（seed ${seed}）`, leak === 0, `${priv} 个私有事件 · ${leak} 处泄漏`);
  }

  // 6) 同 seed 确定性（正常 bot 对局；bot 话术含 match_id salt，须显式同 id 才可比对）
  const r1 = await createMatch({ game: c.game, drivers: c.makeBots(), seed: 999, id: "m-det" }).run();
  const r2 = await createMatch({ game: c.game, drivers: c.makeBots(), seed: 999, id: "m-det" }).run();
  check("同 seed 确定性", hashEvents(r1.events) === hashEvents(r2.events), `hash=${hashEvents(r1.events)}`);
  console.log("");
}

// 7) nonce 幂等绑定回合（内核级）：同回合重发 → 幂等成功；跨回合重发 → NONCE_EXPIRED 显式拒绝（绝不吞回合）
{
  const game = createOthello();
  let stage = 0;
  const probe: SeatDriver = {
    name: "nonce-probe",
    act: async (view, submit) => {
      const la = view.legal_actions[0];
      if (!la) return;
      if (la.type !== "place") return; // 无子可下等情形不参与探针
      const cell = (la.schema?.values as number[] | undefined)?.[0] ?? 0;
      if (stage === 0) {
        const r1 = submit({ type: "place", cell }, { nonce: "n-probe" });
        const r2 = submit({ type: "place", cell }, { nonce: "n-probe" });
        check("nonce 同回合重发幂等成功", r1.ok && r2.ok, JSON.stringify([r1.ok, r2.ok]));
        stage = 1;
        return;
      }
      const stale = submit({ type: "place", cell }, { nonce: "n-probe" });
      check(
        "nonce 跨回合重发显式拒绝（NONCE_EXPIRED）",
        !stale.ok && String(stale.error).startsWith("NONCE_EXPIRED"),
        JSON.stringify(stale).slice(0, 90),
      );
      const real = submit({ type: "place", cell });
      check("新 nonce 正常提交", real.ok, JSON.stringify(real).slice(0, 90));
      stage = 2;
    },
  };
  const m = createMatch({ game, drivers: [probe, createOthelloBot("白", 1)], seed: 7 });
  const r = await m.run();
  check(
    "nonce 探针对局正常完赛",
    stage === 2 && !r.events.some((e) => e.type === "match_failed"),
    `stage=${stage}`,
  );
  console.log("");
}

console.log(`=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
