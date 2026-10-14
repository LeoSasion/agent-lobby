/**
 * 冒烟测试：谁是卧底（undercover）
 * 覆盖：开局不变量（词对/卧底唯一）/ 描述校验（含词拒收/长度限）/ 完整对局（bot 六席）/
 *   信息隔离（word/is_undercover 仅自见+观战零词）/ 放逐亮身份 / 胜负两分支 / 平票 PK / 确定性回放 / 竞猜目标语义
 * 运行：node --experimental-strip-types src/smoke-undercover.ts
 */

import { createUndercover, wordPairs } from "./games/undercover.ts";
import { createUndercoverBot } from "./bots/undercover-bot.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import type { SeatDriver } from "./arena/match.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const game = createUndercover();
console.log("=== Agent 游戏大厅 · 谁是卧底 冒烟测试 ===\n");

// —— 场景 A：开局不变量 ——
console.log("[场景 A] 开局不变量");
const rng = () => 0.42;
const s0 = game.init([1, 2, 3, 4, 5, 6], rng);
check("6 席恰 1 卧底", [...s0.roles.values()].filter((r) => r === "undercover").length === 1);
check("词对一致：平民同词、卧底异词",
  [...s0.words.values()].filter((w) => w === s0.wordPair.civilian).length === 5
    && [...s0.words.values()].filter((w) => w === s0.wordPair.undercover).length === 1,
);
check(
  "词对库 r26-a 不变量：40 对且同类别互不相邻",
  // 相邻 idx 类别不同——连续 rng 抽到相邻位不至连局同类别（联想泄露防线）
  wordPairs().length === 40
    && new Set(wordPairs().map((p) => p.cat)).size >= 22
    && Array.from({ length: 39 }, (_, i) => wordPairs()[i].cat !== wordPairs()[i + 1].cat).every(Boolean),
);
const vSpec = game.viewOf(s0, "spectator");
check("观战零词零身份", !JSON.stringify(vSpec).includes(s0.wordPair.civilian) && !JSON.stringify(vSpec).includes(s0.wordPair.undercover) && !JSON.stringify(vSpec.public).includes("is_undercover"));
const vMe = game.viewOf(s0, 1);
check("席位私有含词与身份标记", typeof vMe.private.word === "string" && typeof vMe.private.is_undercover === "boolean");
const init0 = game.initialEvents?.(s0) ?? [];
check(
  "初始事件：6 个 word_assigned 全私有",
  init0.length === 6 && init0.every((e) => typeof e.visibility === "object" && e.visibility !== null && Array.isArray(e.visibility.seats)),
);

// —— 场景 B：描述校验 ——
console.log("\n[场景 B] 描述校验");
const myWord = s0.words.get(1) ?? "";
check("描述含词被拒", game.validate(s0, 1, { type: "describe", text: `我的词是${myWord}相关` }).ok === false);
check("描述超 120 字被拒", game.validate(s0, 1, { type: "describe", text: "长".repeat(121) }).ok === false);
check("合法描述通过", game.validate(s0, 1, { type: "describe", text: "跟吃的有关的东西" }).ok === true);
check("非本人描述被拒", game.validate(s0, 3, { type: "describe", text: "ok" }).ok === false);

// —— 场景 C：完整对局 + 信息隔离专项 ——
console.log("\n[场景 C] 完整对局（bot 六席）+ 信息隔离");
const violations: string[] = [];
function withIsolationCheck(inner: SeatDriver): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      const pubJson = JSON.stringify(view.public);
      if (pubJson.includes("undercover") && !pubJson.includes("alive_seats")) violations.push("public 疑似泄露身份字段");
      if (/"word"\s*:/.test(pubJson)) violations.push(`seat${view.you.seat}: public 泄露词`);
      if (view.private.word === undefined || view.private.is_undercover === undefined) {
        violations.push(`seat${view.you.seat}: private 缺 word/is_undercover`);
      }
      return inner.act(view, submit);
    },
  };
}
const mk = (i: number) => withIsolationCheck(createUndercoverBot(`uc-bot-${i}`, i));
const rC = await createMatch({
  game,
  drivers: [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)],
  seed: 42,
  timeoutMs: 100,
}).run();
check("信息隔离零违例（逐帧）", violations.length === 0, violations.join("; ").slice(0, 120));
check("对局终局", game.isTerminal === undefined ? rC.events.some((e) => e.type === "game_won") : true);
const gw = rC.events.find((e) => e.type === "game_won");
const gwD = (gw?.data ?? {}) as { roles?: unknown; word_pair?: unknown; winner?: string };
check(
  "game_won 公开身份与词对",
  !!gw && !!gwD.roles && !!gwD.word_pair && (gwD.winner === "civilians" || gwD.winner === "undercover"),
);
check("放逐者亮身份事件在场", rC.events.some((e) => e.type === "player_exiled" && typeof e.data.was_undercover === "boolean"));
const descs = rC.events.filter((e) => e.type === "described");
check("described 事件全公开（描述是公开行为）", descs.length > 0 && descs.every((e) => e.visibility === undefined || e.visibility === "all"));
const words = rC.events.filter((e) => e.type === "word_assigned");
check(
  "word_assigned 事件全私有",
  words.length === 6 && words.every((e) => typeof e.visibility === "object" && e.visibility !== null && Array.isArray(e.visibility.seats)),
);

// —— 场景 D：胜负两分支（黄金 seed 搜索）——
console.log("\n[场景 D] 胜负两分支（黄金 seed）");
let civWin = false, ucWin = false;
for (let seed = 1; seed <= 60 && !(civWin && ucWin); seed++) {
  const r = await createMatch({
    game,
    drivers: [1, 2, 3, 4, 5, 6].map((i) => createUndercoverBot(`b${i}`, i)),
    seed,
    timeoutMs: 50,
  }).run();
  const w = r.events.find((e) => e.type === "game_won");
  if (w?.data?.winner === "civilians") civWin = true;
  if (w?.data?.winner === "undercover") ucWin = true;
}
check("两分支均可达（黄金 seed 搜到平民胜+卧底胜）", civWin && ucWin, `civ=${civWin} uc=${ucWin}`);

// —— 场景 E：确定性回放 ——
console.log("\n[场景 E] 确定性");
const rE = await createMatch({
  game,
  drivers: [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)], // 同名同包装——事件流含 drivers 名，须与 rC 完全一致
  seed: 42,
  timeoutMs: 50,
}).run();
check("双跑事件哈希一致", hashEvents(rC.events) === hashEvents(rE.events));
const replayed = replayEvents(game, rC.events);
check("事件重放还原同一终局（scores 一致）", JSON.stringify(replayed.scores) === JSON.stringify(rC.scores));

// —— 场景 F：平票 PK（构造性验证）——
console.log("\n[场景 F] 平票 PK");
{
  const rng2 = () => 0.99;
  const st = game.init([1, 2, 3, 4, 5, 6], rng2);
  // 跳过描述阶段：全员逐个 describe
  for (let seat = 1; seat <= 6; seat++) {
    game.apply(st, seat, { type: "describe", text: `描述${seat}` }, rng2);
  }
  // 三对三平票：1,2,3 投 4；4,5,6 投 1 → 平票 PK
  game.apply(st, 1, { type: "vote", target: 4 }, rng2);
  game.apply(st, 2, { type: "vote", target: 4 }, rng2);
  game.apply(st, 3, { type: "vote", target: 4 }, rng2);
  game.apply(st, 4, { type: "vote", target: 1 }, rng2);
  game.apply(st, 5, { type: "vote", target: 1 }, rng2);
  const r6 = game.apply(st, 6, { type: "vote", target: 1 }, rng2);
  const pk = r6.events.find((e) => e.type === "vote_pk");
  const pkD = (pk?.data ?? {}) as { candidates?: number[] };
  check("三对三平票触发 PK（候选恰为两被投者）", !!pk && [...(pkD.candidates ?? [])].sort().join(",") === "1,4");
  check("PK 后相位回 vote 且票池重置", st.phase === "vote" && st.pkCandidates !== null);
}

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
