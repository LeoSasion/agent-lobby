/**
 * 冒烟测试：德州扑克·简化版（holdem_lite）—— r12 新增游戏专项
 * 覆盖：
 *   1. 牌力评估器：9 档牌型识别 + 大小链 + A2345 轮子 + 平局 + 踢脚决胜 + 5/6/7 张选优
 *   2. bot 多 seed 完整对局 + 每 phase × 每席位视图隔离
 *      （私有字段白名单 / 手牌不泄露 / 未发公共牌不泄露 / 合法动作与 to_call 一致）
 *   3. 事件级隔离：私有 cards_dealt 仅授权席位可见（含观战者）；弃牌者不进摊牌亮牌；
 *      出局者不再发牌不轮盲注
 *   4. 确定性 + 回放（固定 seed 快照：同 seed 重跑哈希一致 + replayEvents 终局一致）
 *   5. 全超时完赛：2 席 heads-up（超时默认 check/fold 均合法）+ SB=button 盲注规则
 *   6. all-in 有效投入三层结算（黄金 seed 搜索 + 手工推演断言：短码最优只赢自己的层）
 *   7. 平分池 pot_split（check-down 场景搜索 + 份额守恒断言）
 * 运行：node --experimental-strip-types src/smoke-holdem.ts
 */

import {
  createHoldemLite,
  evaluate5,
  evaluateBest,
  evaluate7,
  cmpEval,
  HAND_NAMES,
} from "./games/holdem-lite.ts";
import type { Card, HandEval } from "./games/holdem-lite.ts";
import { createMatch } from "./arena/lobby.ts";
import { replayEvents } from "./arena/replay.ts";
import { hashEvents } from "./arena/event-store.ts";
import { createHoldemBot } from "./bots/holdem-bot.ts";
import { createHangingBot } from "./bots/rule-bot.ts";
import type { Match, SeatDriver } from "./arena/match.ts";
import type { AgentView, MatchEvent } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const game = createHoldemLite();
console.log("=== Agent 游戏大厅 · 德州扑克简化版冒烟测试 ===\n");

// ---------- 场景 1：牌力评估器 ----------

console.log("[场景 1] 牌力评估器");
const C = (s: string): Card => ({ r: "23456789TJQKA".indexOf(s[0]) + 2, s: "shdc".indexOf(s[1]) });
const H = (strs: string[]): Card[] => strs.map(C);

const ladder: [string, string[], number][] = [
  ["高牌", ["Ah", "Kd", "9c", "7s", "4h"], 0],
  ["一对", ["Ah", "Ad", "Kc", "7s", "4h"], 1],
  ["两对", ["Ah", "Ad", "Kc", "Ks", "4h"], 2],
  ["三条", ["Ah", "Ad", "Ac", "Ks", "4h"], 3],
  ["顺子", ["9h", "Td", "Jc", "Qs", "Kh"], 4],
  ["同花", ["Ah", "Kh", "9h", "7h", "4h"], 5],
  ["葫芦", ["Ah", "Ad", "Ac", "Ks", "Kh"], 6],
  ["四条", ["Ah", "Ad", "Ac", "As", "Kh"], 7],
  ["同花顺", ["9h", "Th", "Jh", "Qh", "Kh"], 8],
];
for (const [name, cards, rank] of ladder) {
  const ev = evaluate5(H(cards));
  check(`牌型识别：${name}`, ev.rank === rank && HAND_NAMES[ev.rank] === name, `tb=${JSON.stringify(ev.tb)}`);
}
for (let i = 1; i < ladder.length; i++) {
  check(
    `牌型大小链：${ladder[i][0]} > ${ladder[i - 1][0]}`,
    cmpEval(evaluate5(H(ladder[i][1])), evaluate5(H(ladder[i - 1][1]))) > 0,
  );
}
check(
  "轮子 A2345 = 顺子且高牌为 5",
  evaluate5(H(["Ah", "2d", "3c", "4s", "5h"])).rank === 4 && evaluate5(H(["Ah", "2d", "3c", "4s", "5h"])).tb[0] === 5,
);
check("轮子 < 6 高顺", cmpEval(evaluate5(H(["Ah", "2d", "3c", "4s", "5h"])), evaluate5(H(["2h", "3d", "4c", "5s", "6h"]))) < 0);
check("K 高顺 < A 高顺", cmpEval(evaluate5(H(["9h", "Td", "Jc", "Qs", "Kh"])), evaluate5(H(["Th", "Jd", "Qc", "Kh", "Ah"]))) < 0);
check(
  "皇家同花顺 = A 高同花顺",
  evaluate5(H(["Th", "Jh", "Qh", "Kh", "Ah"])).rank === 8 && evaluate5(H(["Th", "Jh", "Qh", "Kh", "Ah"])).tb[0] === 14,
);
check("平局：异花同点高牌", cmpEval(evaluate5(H(["Ah", "Kd", "9c", "7s", "4h"])), evaluate5(H(["As", "Kc", "9d", "7h", "4s"]))) === 0);
check("平局：异花同点两对", cmpEval(evaluate5(H(["Ah", "Ad", "Kc", "Ks", "Qh"])), evaluate5(H(["Ac", "As", "Kd", "Kh", "Qs"]))) === 0);
check("踢脚决胜：AAKQJ > AAKQT", cmpEval(evaluate5(H(["Ah", "Ad", "Kc", "Qs", "Jh"])), evaluate5(H(["Ah", "Ad", "Kc", "Qs", "Th"]))) > 0);
check("7 张选优：含同花取同花", evaluateBest(H(["Ah", "Kh", "9h", "7h", "4h", "2d", "3c"])).rank === 5);
check(
  "7 张选优：散牌中取 K 高顺",
  evaluateBest(H(["9h", "Td", "Jc", "Qs", "Kh", "2d", "3c"])).rank === 4 && evaluateBest(H(["9h", "Td", "Jc", "Qs", "Kh", "2d", "3c"])).tb[0] === 13,
);
check(
  "7 张选优（evaluate7）：轮子",
  evaluate7(H(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"])).rank === 4 && evaluate7(H(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"])).tb[0] === 5,
);
check("7 张选优：两对三张中取葫芦", evaluateBest(H(["Ah", "Ad", "Ac", "Ks", "Kh", "2d", "3c"])).rank === 6);
check("6 张选优：AAKKK 取葫芦", evaluateBest(H(["Ah", "Ad", "Kc", "Ks", "Kh", "2d"])).rank === 6);
check("7 张选优：同花顺", evaluateBest(H(["9h", "Th", "Jh", "Qh", "Kh", "2d", "Ac"])).rank === 8);

// ---------- 场景 2：bot 多 seed 对局 + 每 phase × 每席位视图隔离 ----------

console.log("\n[场景 2] bot 完整对局 + 视图隔离（3 席 ×3 seed + 6 席 ×1 seed）");
const violations: string[] = [];
const coverage = new Map<string, number>();

function withViewCheck(inner: SeatDriver): SeatDriver {
  return {
    name: inner.name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as {
        hand_no: number;
        street: string;
        community: string[];
        current_bet: number;
        players: Record<string, unknown>[];
      };
      const me = view.you.seat;
      // 私有字段白名单 + 恰两张手牌
      const priv = view.private as Record<string, unknown>;
      for (const k of Object.keys(priv)) {
        if (!["hole_cards", "my_chips", "my_bet"].includes(k)) violations.push(`seat${me}: 私有字段越权 ${k}`);
      }
      const hole = priv.hole_cards as string[] | undefined;
      if (!Array.isArray(hole) || hole.length !== 2) violations.push(`seat${me}: 手牌数异常 ${JSON.stringify(hole)}`);
      else for (const c of hole) if (!/^[2-9TJQKA][shdc]$/.test(c)) violations.push(`seat${me}: 非法手牌 ${c}`);
      // 未发公共牌不泄露：community 与 street 严格一致
      const expectLen: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
      if (expectLen[pub.street] !== undefined && pub.community.length !== expectLen[pub.street]) {
        violations.push(`seat${me}: ${pub.street} 公共牌 ${pub.community.length} 张（应 ${expectLen[pub.street]}）`);
      }
      for (const c of pub.community) if (!/^[2-9TJQKA][shdc]$/.test(c)) violations.push(`seat${me}: 非法公共牌 ${c}`);
      // 公共面无牌堆、无他人手牌
      if ("deck" in pub) violations.push(`seat${me}: 公共面出现 deck`);
      for (const p of pub.players) {
        for (const k of Object.keys(p)) {
          if (!["seat", "chips", "bet", "committed", "folded", "allin"].includes(k)) {
            violations.push(`seat${me}: players 含越权字段 ${k}`);
          }
        }
      }
      // history 中不可见他人手牌事件
      for (const ev of view.history) {
        if (ev.type === "cards_dealt" && (ev.data as { seat?: number }).seat !== me) {
          violations.push(`seat${me}: history 泄露他人手牌事件 seat=${(ev.data as { seat?: number }).seat}`);
        }
      }
      // 合法动作与 to_call 一致
      const myBet = (priv.my_bet as number | undefined) ?? 0;
      const toCall = pub.current_bet - myBet;
      const types = view.legal_actions.map((a) => a.type);
      if (toCall > 0) {
        if (types.includes("check")) violations.push(`seat${me}: 面对下注仍有 check`);
        if (!types.includes("call")) violations.push(`seat${me}: 面对下注缺 call`);
      } else {
        if (types.includes("call")) violations.push(`seat${me}: 无需跟注仍有 call`);
        if (!types.includes("check")) violations.push(`seat${me}: 无需跟注缺 check`);
      }
      if (!types.includes("fold")) violations.push(`seat${me}: 缺 fold`);
      if (!view.you.active) violations.push(`seat${me}: 非行动者收到视图`);
      const key = `${pub.street}#${me}`;
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
      await inner.act(view, submit);
    },
  };
}

interface BotRun {
  match: Match;
  seats: number;
  label: string;
  hands: number;
  eliminations: number;
}
const botRuns: BotRun[] = [];
const botSuites: { label: string; seats: number; seed: number }[] = [
  { label: "3 席 seed=11", seats: 3, seed: 11 },
  { label: "3 席 seed=22", seats: 3, seed: 22 },
  { label: "3 席 seed=33", seats: 3, seed: 33 },
  { label: "6 席 seed=77", seats: 6, seed: 77 },
];
for (const s of botSuites) {
  const names3 = ["紧凶", "松凶", "稳健"];
  const names6 = ["紧凶", "松凶", "稳健", "石墙", "跟注站", "平衡"];
  const drivers = (s.seats === 3 ? names3 : names6).map((n, i) =>
    withViewCheck(createHoldemBot(n, [0.3, 0.8, 0.5, 0.15, 0.65, 0.45][i])),
  );
  const m = createMatch({ game, drivers, seed: s.seed, id: "m-holdem-det", timeoutMs: 2000 });
  const r = await m.run();
  const ge = r.events.find((e) => e.type === "game_ended");
  const hands = r.gameEvents.filter((e) => e.type === "hand_ended").length;
  const elim = r.events.filter((e) => e.type === "player_eliminated").length;
  check(
    `${s.label} 完整结束`,
    ge !== undefined && !r.events.some((e) => e.type === "match_failed") && Object.values(r.scores).some((v) => v === 1),
    `${hands} 手 · ${r.gameEvents.filter((e) => e.type === "showdown").length} 次摊牌 · 出局 ${elim} · ${(ge?.data as { reason?: string }).reason}`,
  );
  botRuns.push({ match: m, seats: s.seats, label: s.label, hands, eliminations: elim });
}
check("视图信息隔离（每 phase × 每席位）", violations.length === 0, violations.length ? violations[0] : "0 违规");
const streetsSeen = new Set([...coverage.keys()].map((k) => k.split("#")[0]));
check(
  "相位覆盖：四条街均被观察",
  ["preflop", "flop", "turn", "river"].every((s) => streetsSeen.has(s)),
  [...streetsSeen].join(","),
);
for (let seat = 1; seat <= 6; seat++) {
  check(`席位覆盖：seat${seat} 收到过行动视图`, (coverage.get(`preflop#${seat}`) ?? 0) > 0);
}

// 弃牌者不进摊牌亮牌 + 出局者不再发牌不轮盲注
function structuralChecks(run: BotRun): void {
  const evs = run.match.currentResult()!.events;
  let folded = new Set<number>();
  let revealBad = 0;
  for (const ev of evs) {
    if (ev.type === "hand_started") folded = new Set();
    if (ev.type === "action" && (ev.data as { action?: string }).action === "fold") {
      folded.add((ev.data as { seat: number }).seat);
    }
    if (ev.type === "showdown") {
      for (const rv of (ev.data as { reveals: { seat: number }[] }).reveals) {
        if (folded.has(rv.seat)) revealBad++;
      }
    }
  }
  check(`${run.label}：弃牌者不进摊牌亮牌`, revealBad === 0, `${revealBad} 处违规`);

  // 每手（hand_started 起）：发牌数 = 在局人数；盲注位 ⊆ 发牌者
  const starts = evs.map((e, i) => (e.type === "hand_started" ? i : -1)).filter((i) => i >= 0);
  let dealtBad = 0;
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b];
    const to = b + 1 < starts.length ? starts[b + 1] : evs.length;
    const seg = evs.slice(from, to);
    const dealt = seg.filter((e) => e.type === "cards_dealt").map((e) => (e.data as { seat: number }).seat);
    const blinds = seg.filter((e) => e.type === "blind_posted").map((e) => (e.data as { seat: number }).seat);
    const eliminatedBefore = evs.slice(0, from).filter((e) => e.type === "player_eliminated").length;
    const live = run.seats - eliminatedBefore;
    if (dealt.length !== live || blinds.some((s) => !dealt.includes(s))) dealtBad++;
  }
  check(`${run.label}：出局者不再发牌/轮盲注`, dealtBad === 0, `${starts.length} 手 · ${dealtBad} 处违规`);
}
for (const run of botRuns) structuralChecks(run);
check("出局覆盖非空（上述不变量经过实战）", botRuns.some((r2) => r2.eliminations > 0), `合计出局 ${botRuns.reduce((a, b) => a + b.eliminations, 0)} 人次`);

// ---------- 场景 3：事件级隔离（私有 cards_dealt 零泄漏） ----------

console.log("\n[场景 3] 事件级隔离：私有 cards_dealt 仅授权席位可见");
function isolationCheck(run: BotRun): void {
  const r = run.match.currentResult()!;
  let leak = 0;
  let priv = 0;
  for (const ev of r.events) {
    if (ev.visibility === "all") continue;
    priv++;
    for (let seat = 1; seat <= run.seats; seat++) {
      if (ev.visibility.seats.includes(seat)) continue;
      if (run.match.eventsFor(seat).some((e) => e.seq === ev.seq)) leak++;
    }
    if (run.match.eventsFor("spectator").some((e) => e.seq === ev.seq)) leak++;
  }
  check(`${run.label}：私有事件零泄漏`, leak === 0, `${priv} 个私有事件 · ${leak} 处泄漏`);
  check(`${run.label}：私有事件非空（测试有效）`, priv > 0);
  const spec = run.match.viewFor("spectator");
  check(`${run.label}：观战者无私有字段、无合法动作`, Object.keys(spec.private).length === 0 && spec.legal_actions.length === 0);
}
isolationCheck(botRuns[0]);
isolationCheck(botRuns[3]);

// ---------- 场景 4：确定性 + 回放（固定 seed 快照） ----------

console.log("\n[场景 4] 确定性与回放");
const r1 = botRuns[0].match.currentResult()!;
const r2 = await createMatch({
  game,
  drivers: ["紧凶", "松凶", "稳健"].map((n, i) => createHoldemBot(n, [0.3, 0.8, 0.5][i])),
  seed: 11,
  id: "m-holdem-det",
}).run();
check("同 seed 同 id 重跑事件序列一致", hashEvents(r1.events) === hashEvents(r2.events), `hash=${hashEvents(r1.events)}`);
const rp = replayEvents(game, r1.events);
check("回放终局分数一致", JSON.stringify(rp.scores) === JSON.stringify(r1.scores));
check("回放游戏事件一致", JSON.stringify(rp.gameEvents) === JSON.stringify(r1.gameEvents), `${rp.gameEvents.length} 个游戏事件`);

// ---------- 场景 5：全超时完赛（2 席 heads-up） ----------

console.log("\n[场景 5] 全超时完赛：2 席 heads-up · timeout=15ms");
{
  const t0 = Date.now();
  const r5 = await createMatch({
    game,
    drivers: [createHangingBot("挂起A"), createHangingBot("挂起B")],
    seed: 8,
    timeoutMs: 15,
  }).run();
  const ge5 = r5.events.find((e) => e.type === "game_ended");
  check(
    "全超时完赛且无 match_failed",
    ge5 !== undefined && !r5.events.some((e) => e.type === "match_failed"),
    `耗时 ${Date.now() - t0}ms · timed_out × ${r5.events.filter((e) => e.type === "timed_out").length}`,
  );
  check(
    "50 手上限收束",
    (ge5?.data as { hands_played?: number } | undefined)?.hands_played === 50 &&
      (ge5?.data as { reason?: string } | undefined)?.reason === "hand_limit",
  );
  // heads-up 盲注规则：小盲位 = 庄家位（2 席特有；首手事件随 init 丢弃，从第 2 手起校验）
  let btn = -1;
  let blindBad = 0;
  let hands = 0;
  for (const ev of r5.events) {
    if (ev.type === "hand_started") {
      btn = (ev.data as { button: number }).button;
      hands++;
    }
    if (ev.type === "blind_posted" && (ev.data as { blind: string }).blind === "small") {
      if ((ev.data as { seat: number }).seat !== btn) blindBad++;
    }
  }
  check("heads-up 小盲位 = 庄家位", blindBad === 0 && hands > 40, `${hands} 手 · ${blindBad} 处不符`);
}

// ---------- 场景 6：all-in 有效投入三层结算 ----------

console.log("\n[场景 6] all-in 有效投入分层结算（3 席脚本局 · maxHands=2 · seed 搜索）");

/** 脚本局：手 1 定位角色（攻/跟/弃 → 筹码 1320/700/980），手 2 按筹码全下（短/中/长） */
function layeredScript(name: string): SeatDriver {
  return {
    name,
    act: async (view, submit) => {
      const pub = view.public as {
        hand_no: number;
        street: string;
        current_bet: number;
        players: { seat: number; chips: number; bet: number }[];
      };
      const my = view.private as { my_chips?: number; my_bet?: number };
      const myTotal = (my.my_chips ?? 0) + (my.my_bet ?? 0);
      const toCall = pub.current_bet - (my.my_bet ?? 0);
      if (pub.hand_no === 1) {
        if (view.you.seat === 1) {
          if (pub.street === "preflop") {
            if (!submit({ type: "raise", to: 300 }).ok) submit({ type: "fold" });
          } else submit({ type: "check" });
        } else if (view.you.seat === 2) {
          if (toCall > 0) submit({ type: "call" });
          else submit({ type: "check" });
        } else {
          submit({ type: "fold" });
        }
        return;
      }
      // 手 2：按筹码总量定角色——最短/最长码全下，中码跟注
      const totals = pub.players.map((p) => p.chips + p.bet);
      const smaller = totals.filter((t) => t < myTotal).length;
      const larger = totals.filter((t) => t > myTotal).length;
      if (smaller === 0 || larger === 0) {
        submit({ type: "allin" });
        return;
      }
      if (toCall > 0) submit({ type: "call" });
      else submit({ type: "check" });
    },
  };
}

interface H2Info {
  seed: number;
  hash: string;
  committed: Record<number, number>;
  evals: Map<number, HandEval>;
  amounts: Record<number, number>;
  pot: number;
  reason: string;
  scores: Record<number, number>;
  eliminated: number[];
  streetCards: number[];
  roles: { L: number; F: number; W: number };
}

async function runLayered(seed: number): Promise<H2Info | null> {
  const m = createMatch({
    game: createHoldemLite({ maxHands: 2 }),
    drivers: [layeredScript("攻"), layeredScript("跟"), layeredScript("弃")],
    seed,
    timeoutMs: 150,
  });
  const r = await m.run();
  const evs = r.events;
  if (evs.some((e) => e.type === "match_failed")) return null;
  // 手 1 须单一赢家（无平分）才可稳定定位角色
  const h1 = evs.find((e) => e.type === "hand_ended" && e.data.hand_no === 1);
  if (!h1) return null;
  const am1 = ((h1.data as { amounts?: Record<string, number> }).amounts ?? {});
  if (Object.values(am1).filter((v) => v > 0).length !== 1) return null;
  // 手 2 切片：最后一个 hand_started 之后
  const starts = evs.map((e, i) => (e.type === "hand_started" ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const h2 = evs.slice(starts[starts.length - 1]);
  const sd = h2.find((e) => e.type === "showdown");
  if (!sd) return null;
  if ((sd.data as { reveals: { seat: number }[] }).reveals.length !== 3) return null;
  // 纯 preflop all-in 战：street_dealt 之后不得再有 action（保证 committed 重建可靠）
  const firstStreet = h2.findIndex((e) => e.type === "street_dealt");
  if (firstStreet < 0) return null;
  if (h2.slice(firstStreet).some((e) => e.type === "action")) return null;
  const committed: Record<number, number> = {};
  for (const ev of h2.slice(0, firstStreet)) {
    if (ev.type === "action" && typeof (ev.data as { to?: unknown }).to === "number") {
      committed[(ev.data as { seat: number }).seat] = (ev.data as { to: number }).to;
    }
  }
  if (Object.keys(committed).length !== 3) return null;
  if ([...new Set(Object.values(committed))].length !== 3) return null;
  const evals = new Map<number, HandEval>();
  for (const e2 of (sd.data as { evaluations: { seat: number; rank: number; tb: number[] }[] }).evaluations) {
    evals.set(e2.seat, { rank: e2.rank, tb: e2.tb });
  }
  const seats = [...evals.keys()];
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      if (cmpEval(evals.get(seats[i])!, evals.get(seats[j])!) === 0) return null; // 严格无平局
    }
  }
  const he2 = h2.find((e) => e.type === "hand_ended");
  const ge = evs.find((e) => e.type === "game_ended");
  if (!he2 || !ge) return null;
  const byStack = Object.entries(committed).sort((a, b) => a[1] - b[1]);
  return {
    seed,
    hash: hashEvents(evs),
    committed,
    evals,
    amounts: (he2.data as { amounts: Record<string, number> }).amounts as Record<number, number>,
    pot: (he2.data as { pot: number }).pot,
    reason: (ge.data as { reason: string }).reason,
    scores: r.scores,
    eliminated: evs.filter((e) => e.type === "player_eliminated").map((e) => (e.data as { seat: number }).seat),
    streetCards: h2
      .filter((e) => e.type === "street_dealt")
      .map((e) => ((e.data as { cards: string[] }).cards ?? []).length),
    roles: { L: Number(byStack[0][0]), F: Number(byStack[1][0]), W: Number(byStack[2][0]) },
  };
}

let caseL: H2Info | null = null;
let caseF: H2Info | null = null;
let caseW: H2Info | null = null;
for (let seed = 1; seed <= 150 && (!caseL || !caseW); seed++) {
  const info = await runLayered(seed);
  if (!info) continue;
  const { L, F, W } = info.roles;
  const best = [L, F, W].reduce((a, b) => (cmpEval(info.evals.get(a)!, info.evals.get(b)!) >= 0 ? a : b));
  if (best === L && !caseL) caseL = info;
  else if (best === W && !caseW) caseW = info;
  else if (best === F && !caseF) caseF = info;
}
check("分层案例搜索：短码最优（分池铁证场景）", caseL !== null, caseL ? `seed=${caseL.seed}` : "150 个 seed 未出现");
check("分层案例搜索：大码通吃（全池+未跟注返还）", caseW !== null, caseW ? `seed=${caseW.seed}` : "150 个 seed 未出现");
if (caseF) console.log(`  [INFO] 中码通吃案例 seed=${caseF.seed}（记录备查）`);

if (caseL) {
  const { L, F, W } = caseL.roles;
  const SL = caseL.committed[L];
  const SF = caseL.committed[F];
  const SW = caseL.committed[W];
  const total = SL + SF + SW;
  const fBeatsW = cmpEval(caseL.evals.get(F)!, caseL.evals.get(W)!) > 0;
  check(
    `短码最优只赢第一层（3×${SL}）`,
    caseL.amounts[L] === 3 * SL,
    `amounts[L]=${caseL.amounts[L]}`,
  );
  check("短码最优未通吃全池（有效投入分池生效）", caseL.amounts[L] < total, `${caseL.amounts[L]} < ${total}`);
  check(
    "中码按第二层归属",
    caseL.amounts[F] === (fBeatsW ? 2 * (SF - SL) : 0),
    `amounts[F]=${caseL.amounts[F]} · F>${fBeatsW ? "W" : "W 不成立"}`,
  );
  check(
    "大码拿回未跟注部分",
    caseL.amounts[W] === SW - SF + (fBeatsW ? 0 : 2 * (SF - SL)),
    `amounts[W]=${caseL.amounts[W]}`,
  );
  check(
    "全池守恒",
    Object.values(caseL.amounts).reduce((a, b) => a + b, 0) === total && caseL.pot === total,
    `pot=${caseL.pot} · total=${total}`,
  );
  check("runout 完整（flop 3 + turn 1 + river 1）", JSON.stringify(caseL.streetCards) === JSON.stringify([3, 1, 1]));
  check("终局按筹码最高计分（短码 3×本码后领先）", caseL.scores[L] === 1, JSON.stringify(caseL.scores));
  check("50 手未到 → hand_limit 收束", caseL.reason === "hand_limit", caseL.reason);
  // 确定性：同 seed 重跑哈希一致
  const again = await runLayered(caseL.seed);
  check("分层场景同 seed 重跑一致", again !== null && again.hash === caseL.hash);
}
if (caseW) {
  const { L, F, W } = caseW.roles;
  const SL = caseW.committed[L];
  const SF = caseW.committed[F];
  const SW = caseW.committed[W];
  const total = SL + SF + SW;
  check("大码最优通吃全池", caseW.amounts[W] === total, `amounts[W]=${caseW.amounts[W]} · total=${total}`);
  check("短码/中码双双出局", caseW.amounts[L] === 0 && caseW.amounts[F] === 0);
  check("出局事件齐全", caseW.eliminated.sort((a, b) => a - b).join(",") === [L, F].sort((a, b) => a - b).join(","), JSON.stringify(caseW.eliminated));
  check("last_standing 即刻终局", caseW.reason === "last_standing" && caseW.scores[W] === 1, `${caseW.reason} · ${JSON.stringify(caseW.scores)}`);
}

// ---------- 场景 7：平分池 pot_split ----------

console.log("\n[场景 7] 平分池 pot_split（3 席 check-down · maxHands=1 · seed 搜索）");
const checkdown = (name: string): SeatDriver => ({
  name,
  act: async (view, submit) => {
    const pub = view.public as { current_bet: number };
    const my = view.private as { my_bet?: number };
    const toCall = pub.current_bet - (my.my_bet ?? 0);
    if (toCall > 0) {
      if (!submit({ type: "call" }).ok) submit({ type: "fold" });
    } else if (!submit({ type: "check" }).ok) submit({ type: "fold" });
  },
});
let splitInfo: { seed: number; r: { scores: Record<number, number>; events: readonly MatchEvent[] }; ev: MatchEvent } | null = null;
for (let seed = 1; seed <= 250 && !splitInfo; seed++) {
  const r = await createMatch({
    game: createHoldemLite({ maxHands: 1 }),
    drivers: [checkdown("甲"), checkdown("乙"), checkdown("丙")],
    seed,
    timeoutMs: 150,
  }).run();
  const ev = r.events.find((e) => e.type === "pot_split");
  if (ev) splitInfo = { seed, r, ev };
}
check("平分场景搜索", splitInfo !== null, splitInfo ? `seed=${splitInfo.seed}` : "250 个 seed 未出现");
if (splitInfo) {
  const d = splitInfo.ev.data as { layer: number; winners: number[]; share: number };
  const sd = splitInfo.r.events.find((e) => e.type === "showdown")!;
  const evals = (sd.data as { evaluations: { seat: number; rank: number; tb: number[] }[] }).evaluations;
  const asEv = (e: { rank: number; tb: number[] }): HandEval => ({ rank: e.rank, tb: e.tb });
  const bestEval = evals.reduce((a, b) => (cmpEval(asEv(a), asEv(b)) >= 0 ? a : b));
  const maxSeats = evals.filter((e) => cmpEval(asEv(e), asEv(bestEval)) === 0).map((e) => e.seat).sort((a, b) => a - b);
  check("平分者 = 牌力并列最高者", JSON.stringify([...d.winners].sort((a, b) => a - b)) === JSON.stringify(maxSeats), `${JSON.stringify(d.winners)} vs ${JSON.stringify(maxSeats)}`);
  check("层池 = 3×大盲（单层）", d.layer === 60, `layer=${d.layer}`);
  check("份额 = floor(池/人数)", d.share === Math.floor(60 / d.winners.length), `share=${d.share}`);
  const he = splitInfo.r.events.find((e) => e.type === "hand_ended")!;
  const amounts = (he.data as { amounts: Record<string, number> }).amounts;
  check(
    "并列者各得 share（±1 余码）",
    d.winners.every((w) => amounts[w] === d.share || amounts[w] === d.share + 1),
    JSON.stringify(amounts),
  );
  check("全池守恒", Object.values(amounts).reduce((a, b) => a + b, 0) === 60);
  const win1 = Number(Object.entries(splitInfo.r.scores).filter(([, v]) => v === 1).map(([k]) => k)[0] ?? -1);
  check("终局胜者出自并列者", d.winners.includes(win1), `winner=${win1}`);
}

// ---------- 场景 8：heads-up 盲注与行动顺序（r13 修复回归） ----------

console.log("\n[场景 8] heads-up 盲注与行动顺序（减员至 2 人 + 原生 2 席）");
/** 8a 专用：手 1 造出局（seat1 全下 · seat2 跟注全下 · seat3 弃牌），手 2+ check-down */
const cullScript = (name: string): SeatDriver => ({
  name,
  act: async (view, submit) => {
    const pub = view.public as { hand_no: number; current_bet: number };
    if (pub.hand_no === 1) {
      if (view.you.seat === 1) { submit({ type: "allin" }); return; }
      if (view.you.seat === 2) { submit({ type: "call" }); return; }
      submit({ type: "fold" }); return;
    }
    const my = view.private as { my_bet?: number };
    const toCall = pub.current_bet - (my.my_bet ?? 0);
    if (toCall > 0) { if (!submit({ type: "call" }).ok) submit({ type: "fold" }); }
    else if (!submit({ type: "check" }).ok) submit({ type: "fold" });
  },
});
/**
 * 断言：每手 button=小盲；preflop 首行动=button(SB)；postflop 首行动≠button（heads-up 由 BB 先行动，
 * 位置优势在庄家——标准规则）。r13 修复前：3+ 席减员至 2 人时 button 成了大盲且 preflop 错位。
 */
/** from：起始校验手号（3 席减员局的手 1 仍是满员手，须从手 2 起校验 heads-up 纪律） */
function assertHeadsUpOrder(label: string, events: readonly MatchEvent[], from = 1): void {
  type H = { handNo: number; button: number; sb: number | null; pre: number | null; post: number | null; street: string; blinds: number };
  const hands = new Map<number, H>();
  let cur: H | null = null;
  for (const ev of events) {
    if (ev.type === "hand_started") {
      const d = ev.data as { hand_no: number; button: number };
      cur = { handNo: d.hand_no, button: d.button, sb: null, pre: null, post: null, street: "preflop", blinds: 0 };
      hands.set(d.hand_no, cur);
    } else if (!cur) continue;
    else if (ev.type === "street_dealt") cur.street = (ev.data as { street: string }).street;
    else if (ev.type === "blind_posted") {
      const d = ev.data as { seat: number; blind: string };
      cur.blinds++;
      if (d.blind === "small") cur.sb = d.seat;
    } else if (ev.type === "action") {
      const seat = (ev.data as { seat: number }).seat;
      if (cur.street === "preflop") { if (cur.pre === null) cur.pre = seat; }
      else if (cur.post === null) cur.post = seat;
    }
  }
  let sbBad = 0, preBad = 0, postBad = 0, postN = 0, n = 0;
  for (const h of hands.values()) {
    if (h.handNo < from) continue;
    if (h.blinds !== 2) continue; // 盲注恰好两席才成立 heads-up 断言
    n++;
    if (h.sb !== null && h.sb !== h.button) sbBad++;
    if (h.pre !== null && h.pre !== h.button) preBad++;
    if (h.post !== null) { postN++; if (h.post === h.button) postBad++; }
  }
  check(`${label}：button 席盲注 = small`, n > 0 && sbBad === 0, `heads-up ${n} 手 · ${sbBad} 处不符`);
  check(`${label}：preflop 首行动 = button(SB)`, n > 0 && preBad === 0, `${n} 手 · ${preBad} 处不符`);
  check(`${label}：postflop 首行动 ≠ button（位置优势在庄家）`, postN > 0 && postBad === 0, `${postN} 手到 postflop · ${postBad} 处不符`);
  check(`${label}：含首手事件（initialEvents 钩子）`, hands.has(1), `手 1 hand_started ${hands.has(1) ? 1 : 0} 条`);
}
// 8a：3 席手 1 造出局 → 减员 heads-up（多 seed 搜索避开手 1 平局）
let hu8a: { seed: number; events: readonly MatchEvent[] } | null = null;
for (let seed = 1; seed <= 30 && !hu8a; seed++) {
  const r = await createMatch({
    game: createHoldemLite({ maxHands: 12 }),
    drivers: [cullScript("甲"), cullScript("乙"), cullScript("丙")],
    seed,
    timeoutMs: 150,
  }).run();
  const seats = new Set<number>();
  let h2 = false;
  for (const ev of r.events) {
    if (ev.type === "hand_started") h2 = (ev.data as { hand_no: number }).hand_no >= 2;
    if (h2 && ev.type === "action") seats.add((ev.data as { seat: number }).seat);
  }
  if (seats.size === 2) hu8a = { seed, events: r.events };
}
check("减员 heads-up 场景构造（手 1 出局 1 人）", hu8a !== null, hu8a ? `seed=${hu8a.seed}` : "30 个 seed 未出现");
if (hu8a) assertHeadsUpOrder("减员 heads-up", hu8a.events, 2);
// 8b：原生 2 席 check-down
{
  const r8b = await createMatch({
    game: createHoldemLite({ maxHands: 12 }),
    drivers: [checkdown("甲"), checkdown("乙")],
    seed: 42,
    timeoutMs: 150,
  }).run();
  assertHeadsUpOrder("原生 2 席", r8b.events);
}

console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
