/**
 * 冒烟测试：狼人杀·简化版
 * 覆盖：完整对局 / 视图隔离（角色字段+事件可见性）/ 事件级隔离（私有事件仅授权席位可见）
 *   / 确定性 / 回放 / 超时兜底（同时相位下挂起席位不阻塞）
 * 运行：node --experimental-strip-types src/smoke-werewolf.ts
 */

import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { createWerewolfBot } from "./bots/werewolf-bot.ts";
import { createHangingBot } from "./bots/rule-bot.ts";
import type { Match, SeatDriver } from "./arena/match.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const game = createWerewolfLite();
console.log("=== Agent 游戏大厅 · 狼人杀简化版冒烟测试 ===\n");

// —— 场景 1：6 bot 完整对局（视图隔离内嵌检查）——
console.log("[场景 1] 6 bot 完整对局");
const violations: string[] = [];
function withViewCheck(inner: SeatDriver): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      const priv = view.private as Record<string, unknown>;
      const role = priv.role as string;
      if (role !== "werewolf" && "teammates" in priv) violations.push(`seat${view.you.seat}: 非狼看到队友`);
      if (role !== "seer" && "checks" in priv) violations.push(`seat${view.you.seat}: 非预言家看到验人`);
      for (const ev of view.history) {
        if (ev.type === "night_kill_decided" && role !== "werewolf") violations.push(`seat${view.you.seat}: 非狼看到狼刀`);
        if (ev.type === "checked" && role !== "seer") violations.push(`seat${view.you.seat}: 非预言家看到验人`);
      }
      // r8：speaking_kind 一致性——发言席位的 legal_actions[0].type 必须与 public.speaking_kind 一致
      //（day_discuss 单席位相位，act() 只会在当前发言人身上调用）
      if (view.phase === "day_discuss") {
        const pub = view.public as { speaking_seat?: number; speaking_kind?: string; pending_speakers?: number[]; pending_kinds?: string[] };
        const myAction = view.legal_actions[0]?.type;
        if (pub.speaking_seat !== view.you.seat) {
          violations.push(`seat${view.you.seat}: day_discuss 行动者 ≠ speaking_seat(${pub.speaking_seat})`);
        }
        const expect = myAction === "last_words" ? "last_words" : "say";
        if (pub.speaking_kind !== expect) {
          violations.push(`seat${view.you.seat}: speaking_kind=${pub.speaking_kind} ≠ legal_actions[0]=${myAction}`);
        }
        // r10 w10-s1 P2④：pending_kinds 与 pending_speakers 等长、值域 {say,last_words}
        if (Array.isArray(pub.pending_speakers)) {
          if (!Array.isArray(pub.pending_kinds) || pub.pending_kinds.length !== pub.pending_speakers.length) {
            violations.push(`seat${view.you.seat}: pending_kinds 缺失或与 pending_speakers 不等长`);
          } else if (!pub.pending_kinds.every((k) => k === "say" || k === "last_words")) {
            violations.push(`seat${view.you.seat}: pending_kinds 值域异常=${JSON.stringify(pub.pending_kinds)}`);
          }
        }
      }
      await inner.act(view, submit);
    },
  };
}
const names = ["甲", "乙", "丙", "丁", "戊", "己"];
const bots = names.map((n, i) => withViewCheck(createWerewolfBot(`bot-${n}`, i)));
const m1: Match = createMatch({ game, drivers: bots, seed: 6666, id: "m-ww-det" });
const r1 = await m1.run();

const won = r1.events.find((e) => e.type === "game_won");
const winnerTeam = (won?.data as { winner?: string } | undefined)?.winner;
const nights = r1.events.filter((e) => e.type === "phase_started" && (e.data as { phase?: string }).phase === "night").length;
const says = r1.events.filter((e) => e.type === "said").length;
check("对局完整结束且有胜方", winnerTeam === "good" || winnerTeam === "wolves", `${nights} 夜 · ${says} 条发言 · ${winnerTeam} 胜`);
check("胜方得 1 分、败方 0 分", Object.values(r1.scores).some((v) => v === 1) && Object.values(r1.scores).some((v) => v === 0));
check("视图信息隔离（角色字段 + history 事件）", violations.length === 0, violations.length ? violations[0] : "0 违规");

// —— 场景 1.5：P0 回归——夜间动作事件脱敏（acted/timed_out 不得以 all 可见性泄漏刀口/验人）——
const won1 = r1.events.find((e) => e.type === "game_won");
const roles1 = (won1?.data as { roles?: Record<string, string> } | undefined)?.roles ?? {};
const nightActs = r1.events.filter((e) => {
  if (e.type !== "acted" && e.type !== "timed_out") return false;
  const a = (e.type === "acted" ? e.data.action : e.data.default_action) as { type?: string } | undefined;
  return a?.type === "kill" || a?.type === "check";
});
check("P0 回归：夜间动作事件已脱敏（非 all 可见性）", nightActs.length > 0 && nightActs.every((e) => e.visibility !== "all"), `${nightActs.length} 个夜间动作事件`);
const plainSeat = [1, 2, 3, 4, 5, 6].find((s) => roles1[String(s)] === "villager");
const leakedNight = plainSeat === undefined ? -1 : m1.eventsFor(plainSeat).filter((e) => {
  if (e.type !== "acted" && e.type !== "timed_out") return false;
  const a = (e.type === "acted" ? e.data.action : e.data.default_action) as { type?: string } | undefined;
  return a?.type === "kill" || a?.type === "check";
}).length;
check("P0 回归：村民视角看不到任何夜间动作", leakedNight === 0, plainSeat !== undefined ? `以 ${plainSeat} 号（村民）验证` : "本局无村民");

// —— 场景 2：事件级隔离（信息隔离专项测试的最小实现，规划 §8 工程纪律）——
console.log("\n[场景 2] 事件级隔离：私有事件仅授权席位可见");
let leak = 0;
let privateEvents = 0;
for (const ev of r1.events) {
  if (ev.visibility === "all") continue;
  privateEvents++;
  const allowed = ev.visibility.seats;
  for (let seat = 1; seat <= 6; seat++) {
    if (allowed.includes(seat)) continue;
    if (m1.eventsFor(seat).some((e) => e.seq === ev.seq)) leak++;
  }
  if (m1.eventsFor("spectator").some((e) => e.seq === ev.seq)) leak++;
}
check("私有事件零泄漏", leak === 0, `${privateEvents} 个私有事件 · ${leak} 处泄漏`);
check("狼刀事件存在（隔离测试非空）", r1.events.some((e) => e.type === "night_kill_decided"));
check("验人事件存在（隔离测试非空）", r1.events.some((e) => e.type === "checked"));
const specView = m1.viewFor("spectator");
check("观战者视角无任何私有字段", Object.keys(specView.private).length === 0 && specView.legal_actions.length === 0);

// —— 场景 3：确定性 + 回放 ——
console.log("\n[场景 3] 确定性与回放");
const r2 = await createMatch({
  game,
  drivers: names.map((n, i) => createWerewolfBot(`bot-${n}`, i)),
  seed: 6666,
  id: "m-ww-det", // bot 话术含 match_id salt——同 seed 确定性比对须同 id
}).run();
check("同 seed 重跑事件序列一致", hashEvents(r1.events) === hashEvents(r2.events), `hash=${hashEvents(r1.events)}`);
const rp = replayEvents(game, r1.events);
check("回放终局分数一致", JSON.stringify(rp.scores) === JSON.stringify(r1.scores));
check("回放游戏事件一致", JSON.stringify(rp.gameEvents) === JSON.stringify(r1.gameEvents), `${rp.gameEvents.length} 个游戏事件`);

// —— 场景 4：超时兜底（同时相位下挂起席位不阻塞）——
console.log("\n[场景 4] 超时兜底：1 个挂起 bot · timeout=60ms");
const t0 = Date.now();
const r3 = await createMatch({
  game,
  drivers: [
    createWerewolfBot("bot-甲", 0),
    createWerewolfBot("bot-乙", 1),
    createHangingBot("bot-挂起"),
    createWerewolfBot("bot-丁", 3),
    createWerewolfBot("bot-戊", 4),
    createWerewolfBot("bot-己", 5),
  ],
  seed: 1234,
  timeoutMs: 60,
}).run();
const elapsed = Date.now() - t0;
const timeouts = r3.events.filter((e) => e.type === "timed_out").length;
check("挂起 bot 不阻塞比赛", Object.values(r3.scores).some((v) => v === 1), `耗时 ${elapsed}ms · timed_out × ${timeouts}`);

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
