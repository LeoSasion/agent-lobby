/**
 * 冒烟测试：全局不变量（r30 代码审查修复项 / r30c 增补）
 * 这些用例锁的是「跨模块契约」而非某个游戏的样本值——改动内核/网关/游戏时最容易悄悄破坏的东西：
 *   1. 胜者语义：平局（最高分 0.5 / 全 0）winners 必须为空；名次兜底必须同分并列（否则平局长出亚军）
 *   2. 异常终局：apply 抛异常 → match_failed 优雅收口，run() 不得 reject（否则僵尸终局）
 *   3. 视图同源：you.active 恒等于「此刻提交会被内核接受」——夜间密语已交后必须 active=false
 *   4. 名次全序：holdem 的 placements 必须按筹码降序，不能退化成「冠军 + 五个并列」
 *   5. 亮身份：undercover 的 vote_result 带 flipped_role（前端分支不再是死代码）
 *   6. 驱动健壮：间隙缓冲超时回明确错误；reset() 后不再把提交打向已结算的旧 step
 *   7. 内存治理：旧对局/房间/id 簿记必须有上限（长跑不 OOM）
 *   8. House Bot 契约：6 个游戏多 seed 零拒绝零超时（拒绝是静默的，必须拦 submit 回调才看得见）
 *   9. 决策令牌：view.turn 可回传，陈旧提交拒为 STALE_VIEW 且不入账
 *  10. 决策方式记分：acted 的 reasoning 正确累计；持久化导入兼容无该字段的旧数据
 * 运行：node --experimental-strip-types src/smoke-invariants.ts
 */

import { createMatch } from "./arena/lobby.ts";
import { composeAgentView, placementsFromScores, winnersOf } from "./arena/match.ts";
import type { Match, SeatDriver } from "./arena/match.ts";
import type { GameModule } from "./games/types.ts";
import type { Action, AgentView, SeatId, SubmitResult } from "./protocol.ts";
import { createHoldemLite } from "./games/holdem-lite.ts";
import { createLiarsDice } from "./games/liars-dice.ts";
import { createOthello } from "./games/othello.ts";
import { createUndercover } from "./games/undercover.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createDilemma } from "./games/dilemma.ts";
import { createAuction } from "./games/auction.ts";
import { createTurtleSoup } from "./games/turtle-soup.ts";
import { createGomoku } from "./games/gomoku.ts";
import { createJungleChess } from "./games/jungle-chess.ts";
import { HttpSeatDriver } from "./gateway/http.ts";
import { Gateway, reasoningRate } from "./gateway/http.ts";
import { RatingStore } from "./arena/rating.ts";
import { houseBotsFor } from "./bots/registry.ts";
import { mulberry32 } from "./rng.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

/* ---------- 1. 胜者语义 ---------- */
console.log("[1] winnersOf：平局不产生胜者");
const tieWinners = winnersOf({ 1: 0.5, 2: 0.5 });
check("全员 0.5（囚徒双背叛）→ 空", tieWinners.length === 0, JSON.stringify(tieWinners));
check("全员 0（未终局/全负）→ 空", winnersOf({ 1: 0, 2: 0, 3: 0 }).length === 0);
check("单一冠军 → 该席位", JSON.stringify(winnersOf({ 1: 1, 2: 0, 3: 0.5 })) === "[1]");
check("阵营制多席位并列 → 全列", JSON.stringify(winnersOf({ 1: 1, 2: 1, 3: 1, 4: 0 })) === "[1,2,3]");

// 同一口径的另一半：名次兜底必须同分并列，否则「平局无胜者」与「名次榜有亚军」自相矛盾。
// 黑白棋是唯一未自实现 placements 的游戏，它的平局（0.5/0.5）正是这条兜底的唯一用户。
const tieRank = placementsFromScores({ 1: 0.5, 2: 0.5 });
check("比分兜底：平局两席并列 rank 1", tieRank.every((p) => p.rank === 1), JSON.stringify(tieRank));
const mixedRank = placementsFromScores({ 1: 1, 2: 0.5, 3: 0.5, 4: 0 });
check("比分兜底：1,2,2,4（并列后跳号，非严格序 1,2,3,4）", JSON.stringify(mixedRank.map((p) => p.rank)) === "[1,2,2,4]", JSON.stringify(mixedRank));

/* ---------- 2. 异常终局 ---------- */
console.log("\n[2] 内核异常：run() 必须优雅收口而不是 reject");
const broken: GameModule<unknown> = {
  meta: { id: "broken", name: "故障游戏", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 200 },
  init: () => ({ ok: true }),
  phase: () => "playing",
  round: () => 1,
  activeSeats: () => [1, 2],
  legalActions: () => [{ type: "pass" }],
  validate: () => ({ ok: true }),
  apply: () => {
    throw new Error("故意让 apply 崩溃");
  },
  viewOf: () => ({ public: {}, private: {} }),
  timeoutAction: () => ({ type: "pass" }),
  isTerminal: () => false,
  // 关键：状态已损坏 → 取分必抛。修复前 run() 在 fail() 之后仍无条件调用它 → reject
  scores: () => {
    throw new Error("状态已损坏，取分失败");
  },
};
const passDriver = (name: string): SeatDriver => ({
  name,
  act: async (_v: AgentView, submit) => {
    submit({ type: "pass" });
  },
});
let crashed = "";
let failResult: Awaited<ReturnType<Match["run"]>> | null = null;
try {
  failResult = await createMatch({ game: broken, drivers: [passDriver("a"), passDriver("b")], seed: 1, timeoutMs: 200 }).run();
} catch (e) {
  crashed = String(e);
}
check("apply 崩溃后 run() 未 reject", crashed === "", crashed || "正常返回");
check(
  "终局事件为 match_failed 且带 result",
  failResult !== null && failResult.events.some((e) => e.type === "match_failed") && failResult.scores !== undefined,
  failResult ? `scores=${JSON.stringify(failResult.scores)}` : "无 result",
);

/* ---------- 3. 视图与提交同源 ---------- */
console.log("\n[3] you.active 严格等于「此刻提交会被接受」");
const dm = createMatch({
  game: createDilemma({ rounds: 1 }),
  drivers: [
    {
      name: "先手",
      act: async (_v: AgentView, submit) => {
        submit({ type: "move", choice: "cooperate" });
      },
    },
    {
      name: "挂起",
      act: async () => {
        await new Promise((r) => setTimeout(r, 400));
      },
    },
  ],
  seed: 7,
  timeoutMs: 300,
});
const dmRun = dm.run();
const meAfter = dm.viewFor(1);
const otherAfter = dm.viewFor(2);
check(
  "提交后本人 active=false 且法表清空",
  meAfter.you.active === false && meAfter.you.submitted === true && meAfter.legal_actions.length === 0,
  `active=${meAfter.you.active} submitted=${meAfter.you.submitted} legal=${meAfter.legal_actions.length}`,
);
check("未提交的对手仍 active", otherAfter.you.active === true && otherAfter.legal_actions.length > 0);
await dmRun;

// 狼人杀夜间：密语（wolf_say）不写 nightActions，但本步已交 → 必须 active=false。
// r30 曾为它开 multiActionPhase 豁免，导致视图承诺行动权而 trySubmit 必拒。
const wg = createWerewolfLite();
const wst = wg.init([1, 2, 3, 4, 5, 6], mulberry32(9));
const roles = [1, 2, 3, 4, 5, 6].map((s) => (wg.viewOf(wst, s).private as { role?: string }).role);
const wolfSeat = [1, 2, 3, 4, 5, 6].find((s) => roles[s - 1] === "werewolf")!;
const vAfterChat = composeAgentView({
  game: wg,
  state: wst,
  matchId: "m",
  viewer: wolfSeat,
  visible: [],
  finished: false,
  deadlineMs: null,
  youSubmitted: true,
  submittedSeats: [wolfSeat],
});
check(
  "夜间已交密语后 active=false（不再与内核接收度相悖）",
  vAfterChat.you.active === false && vAfterChat.legal_actions.length === 0 && vAfterChat.you.submitted === true,
  `wolf=${wolfSeat} active=${vAfterChat.you.active} legal=${vAfterChat.legal_actions.length}`,
);
const vBeforeChat = composeAgentView({
  game: wg,
  state: wst,
  matchId: "m",
  viewer: wolfSeat,
  visible: [],
  finished: false,
  deadlineMs: null,
  youSubmitted: false,
  submittedSeats: [],
});
check(
  "未交时狼仍 active 且卖 kill",
  vBeforeChat.you.active === true && vBeforeChat.legal_actions.some((a) => a.type === "kill"),
  vBeforeChat.legal_actions.map((a) => a.type).join("/"),
);

/* ---------- 4. holdem 名次全序 ---------- */
console.log("\n[4] holdem placements：按筹码降序，不退化为并列");
const holdem = createHoldemLite({ maxHands: 4 });
const house = houseBotsFor("holdem_lite", 4);
const hr = await createMatch({ game: holdem, drivers: house.map((h) => h.driver), seed: 424242, timeoutMs: 500 }).run();
const pl = hr.placements;
check("4 席全部有名次", pl.length === 4 && new Set(pl.map((p) => p.seat)).size === 4, JSON.stringify(pl));
check("冠军名次为 1", pl[0]?.rank === 1, `rank=${pl[0]?.rank} seat=${pl[0]?.seat}`);
const chipOf = new Map<number, number>();
for (const m of pl) {
  const n = Number(/chips=(-?\d+)/.exec(m.note ?? "")?.[1] ?? NaN);
  chipOf.set(m.seat, Number.isFinite(n) ? n : -Infinity);
}
const monotonic = pl.every((p, i) => i === 0 || (chipOf.get(pl[i - 1]!.seat) ?? 0) >= (chipOf.get(p.seat) ?? 0));
check("名次与筹码严格同序", monotonic, pl.map((p) => `${p.seat}:${p.note}`).join(" · "));

/* ---------- 5. undercover 亮身份 ---------- */
console.log("\n[5] undercover vote_result 带 flipped_role");
const ug = createUndercover();
const useats: SeatId[] = [1, 2, 3, 4, 5, 6];
const urng = mulberry32(20261020);
let ustate = ug.init(useats, urng);
while (ug.phase(ustate) === "describe") {
  const [speaker] = ug.activeSeats(ustate);
  ustate = ug.apply(ustate, speaker!, { type: "describe", text: "一句不含词本身的描述" }, urng).state;
}
const voteEvents: { type: string; data: Record<string, unknown> }[] = [];
let guard = 0;
while (ug.phase(ustate) === "vote" && guard++ < 12) {
  const pub = ug.viewOf(ustate, "spectator").public as { alive_seats: SeatId[]; pk_candidates: SeatId[] | null };
  const pool = pub.pk_candidates ?? pub.alive_seats;
  const target = [...pool].sort((a, b) => a - b)[0]!;
  for (const seat of [...ug.activeSeats(ustate)].sort((a, b) => a - b)) {
    const r = ug.apply(ustate, seat, { type: "vote", target }, urng);
    ustate = r.state;
    for (const ev of r.events) voteEvents.push({ type: ev.type, data: ev.data ?? {} });
  }
}
const vr = voteEvents.find((e) => e.type === "vote_result")?.data as
  | { exiled?: number | null; flipped_role?: string | null }
  | undefined;
check(
  "vote_result 携带被放逐者身份",
  !!vr && vr.exiled != null && (vr.flipped_role === "undercover" || vr.flipped_role === "civilian"),
  vr ? `exiled=${vr.exiled} flipped_role=${vr.flipped_role}` : "无 vote_result",
);
const exiled = voteEvents.find((e) => e.type === "player_exiled")?.data as { seat: number; role: string } | undefined;
check(
  "flipped_role 与 player_exiled.role 一致",
  !!vr && !!exiled && vr.flipped_role === exiled.role,
  `vote_result=${vr?.flipped_role} player_exiled=${exiled?.role}`,
);

/* ---------- 6. 驱动健壮性 ---------- */
console.log("\n[6] HTTP 驱动：间隙缓冲不无限挂起 / reset 丢弃陈旧闭包");
const ghost = new HttpSeatDriver("ghost", 60);
const t0 = Date.now();
const ghostRes = await ghost.handleAction({ type: "pass" });
const waited = Date.now() - t0;
check(
  "间隙缓冲超时返回明确错误（不永久挂起）",
  ghostRes.ok === false && String((ghostRes as { error: string }).error).startsWith("NOT_YOUR_TURN") && waited >= 50,
  `${waited}ms · ${ghostRes.ok === false ? String((ghostRes as { error: string }).error).slice(0, 24) : "ok"}`,
);
const stale = new HttpSeatDriver("stale", 500);
let submits = 0;
void stale.act({} as AgentView, () => {
  submits++;
  return { ok: true };
});
stale.reset();
const buffered = stale.handleAction({ type: "pass" });
await new Promise((r) => setTimeout(r, 40));
check("reset 后提交不再打向旧 step（改为缓冲）", submits === 0, `submit 调用 ${submits} 次`);
void buffered; // 定时器 unref，进程可正常退出

/* ---------- 7. 长跑内存治理 ---------- */
console.log("\n[7] 网关内存治理：旧对局回收 / waiting 房间 TTL");
const gw = new Gateway(join(tmpdir(), `arena-invariants-${process.pid}.json`));
const box = gw as unknown as {
  matches: Map<string, { match: { id: string; isFinished: () => boolean }; startedAt: number }>;
  rooms: Map<string, { status: string; createdAt: number }>;
  guesses: Map<string, unknown>;
  pruneStaleMatches(): void;
  pruneStaleRooms(): void;
};
const HOUR = 3600_000;
for (let i = 0; i < 700; i++) {
  box.matches.set(`m${i}`, { match: { id: `m${i}`, isFinished: () => true }, startedAt: i });
}
// 一场很老的「进行中」对局：绝不能被回收（回收只针对已结束）
box.matches.set("live", { match: { id: "live", isFinished: () => false }, startedAt: -1 });
box.guesses.set("m0", { votes: new Map(), voters: new Map() });
box.pruneStaleMatches();
check("超窗后回收到 400 场", box.matches.size === 400, String(box.matches.size));
check("最老的已结束对局先被淘汰", !box.matches.has("m0") && box.matches.has("m699"));
check("进行中的老对局不被回收", box.matches.has("live"));
check("竞猜票池随对局一并回收", !box.guesses.has("m0"));

box.rooms.set("r-old-waiting", { status: "waiting", createdAt: Date.now() - 13 * HOUR });
box.rooms.set("r-old-started", { status: "started", createdAt: Date.now() - 13 * HOUR });
box.rooms.set("r-fresh", { status: "waiting", createdAt: Date.now() - 1 * HOUR });
box.pruneStaleRooms();
check(
  "过期 waiting 房间被清理，started 与新房保留",
  !box.rooms.has("r-old-waiting") && box.rooms.has("r-old-started") && box.rooms.has("r-fresh"),
  [...box.rooms.keys()].join(","),
);

/* ---------- 8. House Bot 只提交内核会接受的动作 ---------- */
// 房间补位全靠 house bot。bot 与内核的契约一旦漂移（比如 raise.to 从「增量」改成「本街总投入」），
// 症状不是报错而是「该席位不提交 → 每相位靠超时兜底」：对局照样打完，只是变慢、观感变差，极难发现。
// 注意：内核拒绝动作是**静默**返回 {ok:false}，不产生任何事件——所以必须拦 submit 回调才看得见，
// 用 events 过滤 action_rejected 会得到一个永远不会失败的假测试。
console.log("\n[8] House Bot 契约：全游戏多 seed 零拒绝、零超时");
const BOT_SEEDS = [11, 12, 13];
const BOT_GAMES = [
  createLiarsDice(), createOthello(), createDilemma(),
  createUndercover(), createWerewolfLite(), createHoldemLite(), createAuction(), createTurtleSoup(), createGomoku(), createJungleChess(),
] as unknown as GameModule<unknown>[];
for (const game of BOT_GAMES) {
  const rejections: string[] = [];
  let timedOut = 0;
  for (const seed of BOT_SEEDS) {
    // 每局重建 driver：dilemma 的 grim 有跨轮记忆，复用实例会把上一局的状态带进来
    const drivers: SeatDriver[] = houseBotsFor(game.meta.id, game.meta.minSeats).map((b) => {
      const d = b.driver;
      return {
        name: d.name,
        act: (v, submit) =>
          d.act(v, (a, o) => {
            const r = submit(a, o);
            if (!r.ok) rejections.push(`${d.name} → ${r.error ?? "?"}`);
            return r;
          }),
      };
    });
    const r = await createMatch({ game, drivers, seed, timeoutMs: 30 }).run();
    timedOut += r.events.filter((e) => e.type === "timed_out").length;
  }
  check(
    `${game.meta.id}：${BOT_SEEDS.length} 局零拒绝/零超时`,
    rejections.length === 0 && timedOut === 0,
    rejections.length ? rejections.slice(0, 3).join(" · ") : `超时 ${timedOut}`,
  );
}

/* ---------- 9. 决策令牌：陈旧视图提交必须被拒 ---------- */
// r30c：视图暴露 turn，客户端回传后，基于旧视图的提交被拒为 STALE_VIEW。
// 治的是「用第 N 步的视图做决策、却在第 N+1 步才到」——动作本身可能仍然合法，
// 此前会被静默当成一条新决策入账，决策依据早已过期且无人察觉。
console.log("\n[9] turn 决策令牌：陈旧提交拒收、当前提交放行");
const probeGame: GameModule<{ n: number }> = {
  meta: { id: "turnprobe", name: "令牌探针", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 3000 },
  init: () => ({ n: 0 }),
  phase: () => "p",
  round: () => 1,
  activeSeats: () => [1, 2],
  legalActions: () => [{ type: "move" }],
  validate: (_s, _seat, a) => (a.type === "move" ? { ok: true } : { ok: false, error: "BAD_ACTION" }),
  apply: (s) => ({ state: { n: s.n + 1 }, events: [] }),
  viewOf: () => ({ public: {}, private: {} }),
  timeoutAction: () => ({ type: "move" }),
  isTerminal: (s) => s.n >= 2,
  scores: () => ({ 1: 1, 2: 0 }),
};
// 探针：座 1 先拿「上一步」的令牌提交（必须被拒且不入账），再用正确令牌提交（必须通过）
const probe: { seen: number | null; stale: SubmitResult | null; fresh: SubmitResult | null } = {
  seen: null,
  stale: null,
  fresh: null,
};
const seat1: SeatDriver = {
  name: "probe-1",
  act: async (view, submit) => {
    probe.seen = typeof view.turn === "number" ? view.turn : null;
    probe.stale = submit({ type: "move" }, { turn: (view.turn ?? 1) - 1 });
    probe.fresh = submit({ type: "move" }, { turn: view.turn });
  },
};
const seat2: SeatDriver = {
  name: "probe-2",
  act: async (view, submit) => {
    submit({ type: "move" }, { turn: view.turn });
  },
};
await createMatch({ game: probeGame, drivers: [seat1, seat2], seed: 1, timeoutMs: 3000 }).run();
const staleErr = probe.stale && !probe.stale.ok ? probe.stale.error : "";
check("视图带 turn 字段", probe.seen !== null, String(probe.seen));
check("陈旧令牌提交被拒（STALE_VIEW）", probe.stale?.ok === false && staleErr.includes("STALE_VIEW"), staleErr || "未被拒");
check("被拒后同一步的正确令牌仍可提交", probe.fresh?.ok === true, String(probe.fresh?.ok));

console.log("\n[10] 决策方式记分：reasoning 累计正确、旧数据兼容、零行动 rate 为 null");
const rs10 = new RatingStore();
const r10 = await createMatch({
  game: createDilemma(),
  drivers: [
    { name: "reasoner", act: async (_v, submit) => { submit({ type: "move", choice: "cooperate" }, { reasoning: "每步都带推理" }); } },
    { name: "silent", act: async (_v, submit) => { submit({ type: "move", choice: "betray" }); } },
  ],
  seed: 7,
  timeoutMs: 3000,
}).run();
const seatAgents10 = new Map<SeatId, string>([[1, "reasoner"], [2, "silent"]]);
rs10.applyActionStats("dilemma", seatAgents10, r10.events);
const ra10 = rs10.record("dilemma", "reasoner");
const rb10 = rs10.record("dilemma", "silent");
check("带推理的行动全部计入", ra10.actions === 10 && ra10.reasoned === 10, `reasoner actions=${ra10.actions} reasoned=${ra10.reasoned}`);
check("不带推理的行动 reasoned 恒 0", rb10.actions === 10 && (rb10.reasoned ?? -1) === 0, `silent actions=${rb10.actions} reasoned=${rb10.reasoned}`);
const rs10b = new RatingStore();
rs10b.import({ dilemma: { legacy: { rating: 1200, games: 1, wins: 0, draws: 0, losses: 1 } } });
const legacy = rs10b.record("dilemma", "legacy");
check("持久化导入兼容旧数据（actions/reasoned 兜底 0）", legacy.actions === 0 && legacy.reasoned === 0, `legacy actions=${legacy.actions} reasoned=${legacy.reasoned}`);
check("从未行动 rate 为 null（不显示成 0%）", reasoningRate({ rating: 1200, games: 0, wins: 0, draws: 0, losses: 0 }) === null, "");
check("rate 计算正确", reasoningRate(ra10) === 1, String(reasoningRate(ra10)));

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
