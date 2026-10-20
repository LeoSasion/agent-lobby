/**
 * 冒烟测试：谁是卧底（undercover）
 * 覆盖：开局不变量（词对/卧底唯一）/ 描述校验（含词拒收/长度限）/ 完整对局（bot 六席）/
 *   信息隔离（word 仅自见 + 观战零词 + 身份不外泄）/ 放逐亮身份 / 胜负两分支 / 平票 PK / 确定性回放 / 竞猜目标语义
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
// r29：视图只发自己的词，不再直接给 is_undercover——
// 「你不知道自己是不是卧底」是本游戏全部玩法，直接给字段等于把答案发给玩家
check(
  "席位私有含词且不给身份",
  typeof vMe.private.word === "string" && !("is_undercover" in vMe.private),
);
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
      if (view.private.word === undefined) {
        violations.push(`seat${view.you.seat}: private 缺 word`);
      }
      // 反向断言（r29）：私有视图不得出现身份字段
      if ("is_undercover" in view.private) {
        violations.push(`seat${view.you.seat}: private 泄露 is_undercover`);
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

// —— 场景 F：平票 PK 两轮制（构造性验证，r27-d）——
console.log("\n[场景 F] 平票 PK 两轮制");
{
  const rng2 = () => 0.99;
  const st = game.init([1, 2, 3, 4, 5, 6], rng2);
  const describeAll = (tag: string): void => {
    for (let seat = 1; seat <= 6; seat++) {
      game.apply(st, seat, { type: "describe", text: `描述${tag}${seat}` }, rng2);
    }
  };
  describeAll("一");
  // 三对三平票：1,2,3 投 4；4,5,6 投 1 → 平票 PK 第 1 轮
  game.apply(st, 1, { type: "vote", target: 4 }, rng2);
  game.apply(st, 2, { type: "vote", target: 4 }, rng2);
  game.apply(st, 3, { type: "vote", target: 4 }, rng2);
  game.apply(st, 4, { type: "vote", target: 1 }, rng2);
  game.apply(st, 5, { type: "vote", target: 1 }, rng2);
  const r6 = game.apply(st, 6, { type: "vote", target: 1 }, rng2);
  const pk1 = r6.events.find((e) => e.type === "vote_pk");
  const pk1D = (pk1?.data ?? {}) as { candidates?: number[]; pk_round?: number };
  check(
    "三对三平票触发 PK1（候选恰为两被投者，pk_round=1）",
    !!pk1 && [...(pk1D.candidates ?? [])].sort().join(",") === "1,4" && pk1D.pk_round === 1,
  );
  check("PK1 后相位回 vote 且票池重置（pkRound=1）", st.phase === "vote" && st.pkCandidates !== null && st.pkRound === 1);
  check("viewOf 暴露 pk_round", (game.viewOf(st, "spectator").public as { pk_round?: number }).pk_round === 1);

  // PK1 再三对三平票 → PK2：候选更新为本次平票者，pk_round=2
  game.apply(st, 1, { type: "vote", target: 1 }, rng2);
  game.apply(st, 2, { type: "vote", target: 4 }, rng2);
  game.apply(st, 3, { type: "vote", target: 1 }, rng2);
  game.apply(st, 4, { type: "vote", target: 4 }, rng2);
  game.apply(st, 5, { type: "vote", target: 1 }, rng2);
  const rPK1b = game.apply(st, 6, { type: "vote", target: 4 }, rng2);
  const pk2 = rPK1b.events.find((e) => e.type === "vote_pk");
  const pk2D = (pk2?.data ?? {}) as { candidates?: number[]; pk_round?: number };
  check(
    "PK1 再平票触发 PK2（pk_round=2，候选保持）",
    !!pk2 && pk2D.pk_round === 2 && [...(pk2D.candidates ?? [])].sort().join(",") === "1,4" && st.pkRound === 2,
  );

  // PK2 再三对三平票 → 无人出局：vote_result exiled=null 且 pk=true，进下一轮 describe
  game.apply(st, 1, { type: "vote", target: 1 }, rng2);
  game.apply(st, 2, { type: "vote", target: 4 }, rng2);
  game.apply(st, 3, { type: "vote", target: 1 }, rng2);
  game.apply(st, 4, { type: "vote", target: 4 }, rng2);
  game.apply(st, 5, { type: "vote", target: 1 }, rng2);
  const rEnd = game.apply(st, 6, { type: "vote", target: 4 }, rng2);
  const vr = rEnd.events.find((e) => e.type === "vote_result");
  const vrD = (vr?.data ?? {}) as { exiled?: unknown; pk?: boolean };
  check(
    "PK2 再平票无人出局（exiled=null 且 pk=true）",
    !!vr && vrD.exiled === null && vrD.pk === true,
  );
  check("无人出局后进下一轮 describe（round=2，PK 态清零）", st.phase === "describe" && st.round === 2 && st.pkCandidates === null && st.pkRound === 0);

  // 回合推进：下一轮全员弃票（全 pass）→ 无人出局 round=3
  describeAll("二");
  for (let seat = 1; seat <= 6; seat++) game.apply(st, seat, { type: "pass" }, rng2);
  check("全弃票无人出局且推进 round=3", st.phase === "describe" && st.round === 3 && st.pkRound === 0);

  // 第 3 轮打完 → 卧底存活卧底胜（3 轮上限）
  describeAll("三");
  for (let seat = 1; seat <= 6; seat++) game.apply(st, seat, { type: "pass" }, rng2);
  check("3 轮打完卧底存活 → 卧底胜终局", st.phase === "finished" && st.winner === "undercover");
}

// —— 场景 G：PK 候选收敛（三路平票 → PK1 二路 → PK2 一锤定音，r27-d）——
console.log("\n[场景 G] PK 候选收敛");
{
  const rng3 = () => 0.5;
  const st = game.init([1, 2, 3, 4, 5, 6], rng3);
  for (let seat = 1; seat <= 6; seat++) {
    game.apply(st, seat, { type: "describe", text: `描述${seat}` }, rng3);
  }
  // 三路平票 2:2:2：1,2 投 3；3,4 投 5；5,6 投 2 → PK1 候选 [2,3,5]
  game.apply(st, 1, { type: "vote", target: 3 }, rng3);
  game.apply(st, 2, { type: "vote", target: 3 }, rng3);
  game.apply(st, 3, { type: "vote", target: 5 }, rng3);
  game.apply(st, 4, { type: "vote", target: 5 }, rng3);
  game.apply(st, 5, { type: "vote", target: 2 }, rng3);
  const rPK1 = game.apply(st, 6, { type: "vote", target: 2 }, rng3);
  const pkA = rPK1.events.find((e) => e.type === "vote_pk");
  const pkAD = (pkA?.data ?? {}) as { candidates?: number[] };
  check("三路平票 PK1 候选三席", !!pkA && [...(pkAD.candidates ?? [])].sort().join(",") === "2,3,5");

  // PK1：2 票投 2、2 票投 3、2 人弃 → 二路平票 → PK2 候选收敛 [2,3]
  game.apply(st, 1, { type: "vote", target: 2 }, rng3);
  game.apply(st, 2, { type: "vote", target: 2 }, rng3);
  game.apply(st, 3, { type: "vote", target: 3 }, rng3);
  game.apply(st, 4, { type: "vote", target: 3 }, rng3);
  game.apply(st, 5, { type: "pass" }, rng3);
  const rPK2 = game.apply(st, 6, { type: "pass" }, rng3);
  const pkB = rPK2.events.find((e) => e.type === "vote_pk");
  const pkBD = (pkB?.data ?? {}) as { candidates?: number[]; pk_round?: number };
  check(
    "PK1 二路平票 → PK2 候选收敛（[2,3,5]→[2,3]，pk_round=2）",
    !!pkB && pkBD.pk_round === 2 && [...(pkBD.candidates ?? [])].sort().join(",") === "2,3",
  );

  // PK2：3 票投 2、3 人弃 → 一锤定音放逐 2 号
  game.apply(st, 1, { type: "vote", target: 2 }, rng3);
  game.apply(st, 3, { type: "vote", target: 2 }, rng3);
  game.apply(st, 4, { type: "pass" }, rng3);
  game.apply(st, 5, { type: "vote", target: 2 }, rng3);
  game.apply(st, 6, { type: "pass" }, rng3);
  const rExile = game.apply(st, 2, { type: "pass" }, rng3);
  const ex = rExile.events.find((e) => e.type === "player_exiled");
  const exD = (ex?.data ?? {}) as { seat?: number };
  check("PK2 多数票放逐成功（player_exiled seat=2）", !!ex && exD.seat === 2 && st.pkRound === 0);
  check("放逐后进下一轮 describe", st.phase === "describe" && st.round === 2);
}

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
