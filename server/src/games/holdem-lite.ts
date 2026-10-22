/**
 * 德州扑克·简化版（holdem_lite）—— r12 新增游戏
 * 规则：2-6 席，每人初始 1000 筹码；固定盲注 10/20（不涨盲）；
 * 每手 preflop→flop(3)→turn(1)→river(1)→showdown；筹码输光出局，仅剩 1 人即终局；
 * 50 手上限到限按筹码定胜（最高者胜，v0 二元计分）。
 * v0 简化（文档 §7.4 已注明）：
 *   - 单池「有效投入法」结算（不做多级边池：每层奖池由该层有资格的最好牌力者赢得，
 *     多人不同额 all-in 时与真实边池可能有微小出入）
 *   - 不足额全下不重开他人行动权、不改变最小加注额（标准规则的简化子集）
 *   - init 不产生事件（框架限制，同吹牛骰首手掷骰）：首手发牌/盲注仅体现在 view，
 *     第 2 手起 hand_started/cards_dealt 等事件正常入流
 * 信息隔离：手牌 private（cards_dealt 事件按席位可见）；摊牌亮牌仅限未弃牌者（showdown 事件公开）；
 *   弃牌者底牌永不公开；deck 不可见。
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

// ---------- 基础类型 ----------

export interface Card {
  r: number; // 2-14（11=J 12=Q 13=K 14=A）
  s: number; // 0=♠ 1=♥ 2=♦ 3=♣
}

const SUITS = ["s", "h", "d", "c"];
const RANKS = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

export function cardStr(c: Card): string {
  return RANKS[c.r] + SUITS[c.s];
}

export interface HoldemConfig {
  startingChips?: number;
  smallBlind?: number;
  maxHands?: number;
}

interface Player {
  seat: SeatId;
  chips: number;
  hole: Card[];
  folded: boolean;
  allin: boolean;
  bet: number; // 本街已投入
  committed: number; // 本手累计投入（跨街）
}

interface State {
  players: Player[];
  deck: Card[];
  community: Card[];
  street: "preflop" | "flop" | "turn" | "river";
  pot: number; // 已收入池（不含本街 bet）
  button: number; // 庄家（players 下标）
  toAct: number | null;
  currentBet: number; // 本街最高投入
  minRaise: number; // 本街最小加注增量
  acted: boolean[]; // 本街各下标是否已行动（加注后重置）
  initEvents?: GameEvent[]; // 首手事件暂存（r13：initialEvents 钩子取出后清空）
  handNo: number;
  finished: boolean;
  bustedOrder: SeatId[];
}

// ---------- 牌力评估（7 选 5） ----------

export interface HandEval {
  rank: number; // 0 高牌 … 8 同花顺
  tb: number[]; // 同 rank 的降序决胜数组
}

export function evaluate5(cards: Card[]): HandEval {
  const rs = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);

  let straightHigh = 0;
  const uniq = [...new Set(rs)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // A2345 轮子
  }

  const cnt = new Map<number, number>();
  for (const r of rs) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const k = groups.map((g) => g[1]);

  if (flush && straightHigh) return { rank: 8, tb: [straightHigh] };
  if (k[0] === 4) return { rank: 7, tb: [groups[0][0], groups[1][0]] };
  if (k[0] === 3 && k[1] === 2) return { rank: 6, tb: [groups[0][0], groups[1][0]] };
  if (flush) return { rank: 5, tb: rs };
  if (straightHigh) return { rank: 4, tb: [straightHigh] };
  if (k[0] === 3) return { rank: 3, tb: [groups[0][0], groups[1][0], groups[2][0]] };
  if (k[0] === 2 && k[1] === 2) return { rank: 2, tb: [groups[0][0], groups[1][0], groups[2][0]] };
  if (k[0] === 2) return { rank: 1, tb: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]] };
  return { rank: 0, tb: rs };
}

const combosOf5 = (n: number): number[][] => {
  const combos: number[][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) combos.push([a, b, c, d, e]);
  return combos;
};

/** 任意 ≥5 张牌取最佳 5 张（bot 评 5/6/7 张用；showdown 传 7 张） */
export function evaluateBest(cards: Card[]): HandEval {
  if (cards.length === 5) return evaluate5(cards);
  let best: HandEval | null = null;
  for (const idx of combosOf5(cards.length)) {
    const ev = evaluate5(idx.map((i) => cards[i]));
    if (!best || cmpEval(ev, best) > 0) best = ev;
  }
  return best!;
}

export function evaluate7(cards: Card[]): HandEval {
  return evaluateBest(cards);
}

export function cmpEval(a: HandEval, b: HandEval): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const n = Math.max(a.tb.length, b.tb.length);
  for (let i = 0; i < n; i++) {
    const d = (a.tb[i] ?? 0) - (b.tb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const HAND_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

// ---------- 引擎 ----------

function freshDeck(): Card[] {
  const out: Card[] = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) out.push({ r, s });
  return out;
}

function shuffle(deck: Card[], rng: Rng): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function nextCanActIdx(s: State, from: number): number | null {
  let i = from;
  for (let k = 0; k < s.players.length; k++) {
    const p = s.players[i];
    if (!p.folded && !p.allin && p.chips > 0) return i;
    i = (i + 1) % s.players.length;
  }
  return null;
}

/** 从 from 起找下一个在局（未出局）的下标；出局者不再参与轮转 */
function nextLiveFrom(s: State, from: number): number {
  const n = s.players.length;
  let i = ((from % n) + n) % n;
  while (s.players[i].chips === 0) i = (i + 1) % n;
  return i;
}

function aliveCount(s: State): number {
  return s.players.filter((p) => !p.folded).length;
}

function canActCount(s: State): number {
  return s.players.filter((p) => !p.folded && !p.allin && p.chips > 0).length;
}

export function createHoldemLite(config: HoldemConfig = {}): GameModule<State> {
  const startingChips = config.startingChips ?? 1000;
  const sb = config.smallBlind ?? 10;
  const bb = sb * 2;
  const maxHands = config.maxHands ?? 50;

  /** 开新一手（含发牌+盲注+行动权）。事件含私有 cards_dealt。出局者（chips=0）不参与。 */
  function startHand(s: State, rng: Rng): GameEvent[] {
    const events: GameEvent[] = [];
    const n = s.players.length;
    for (const p of s.players) {
      p.hole = [];
      // 出局者（endHand 已记 bustedOrder）整手标记弃牌：不发牌、不轮盲注、不进摊牌
      p.folded = p.chips === 0;
      p.allin = false;
      p.bet = 0;
      p.committed = 0;
    }
    s.community = [];
    s.street = "preflop";
    s.pot = 0;
    s.deck = freshDeck();
    shuffle(s.deck, rng);
    s.currentBet = 0;
    s.minRaise = bb;
    s.acted = s.players.map(() => false);

    events.push({
      type: "hand_started",
      data: { hand_no: s.handNo, button: s.players[s.button].seat, small_blind: sb, big_blind: bb },
    });

    for (const p of s.players) {
      if (p.chips === 0) continue; // 出局者不发牌
      p.hole = [s.deck.pop()!, s.deck.pop()!];
      events.push({
        type: "cards_dealt",
        data: { seat: p.seat, cards: p.hole.map(cardStr) },
        visibility: { seats: [p.seat] },
      });
    }

    // 盲注位轮转跳过出局者（庄家位在 endHand 已保证落在在局者上）
    // r13 修复：heads-up 判据用「存活人数」而非席位总数——3+ 席减员至 2 人时
    // button 须转为小盲（原 n===players.length 使 heads-up 分支永不触发，实测 36/36 手 button=大盲）
    const live = s.players.filter((q) => q.chips > 0).length;
    const sbIdx = live === 2 ? s.button : nextLiveFrom(s, s.button + 1);
    const bbIdx = nextLiveFrom(s, sbIdx + 1);
    postBlind(s, sbIdx, sb, events);
    postBlind(s, bbIdx, bb, events);
    s.currentBet = Math.max(s.players[sbIdx].bet, s.players[bbIdx].bet);
    s.minRaise = bb;

    if (canActCount(s) >= 2 && aliveCount(s) > 1) {
      // r13 修复：preflop 行动起点 = 大盲下一位在局者（UTG），通吃满员/减员/heads-up
      // （原 (button+3)%n 按席位总数定位，减员后错位；heads-up 时自然地回到 SB=button 先行动）
      const startIdx = nextLiveFrom(s, bbIdx + 1);
      s.toAct = nextCanActIdx(s, startIdx);
      if (s.toAct === null) {
        return [...events, ...runoutRest(s, rng), ...showdown(s, rng)];
      }
      return events;
    }
    return [...events, ...runoutRest(s, rng), ...showdown(s, rng)];
  }

  function postBlind(s: State, idx: number, amount: number, events: GameEvent[]): void {
    const p = s.players[idx];
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.committed += pay;
    if (p.chips === 0) p.allin = true;
    events.push({
      type: "blind_posted",
      // r13 修复（P2）：补 hand_no——50 手局 98 条盲注事件原本全为 null，归因只能靠顺序
      data: { hand_no: s.handNo, seat: p.seat, amount: pay, blind: amount === sb ? "small" : "big" },
    });
  }

  /** 收街：本街 bet 并入 pot，重置街内状态 */
  function closeStreet(s: State): void {
    for (const p of s.players) s.pot += p.bet;
    for (const p of s.players) p.bet = 0;
    s.currentBet = 0;
    s.minRaise = bb;
    s.acted = s.players.map(() => false);
  }

  /** 发下一街公共牌（纯发牌；行动权由调用方决定） */
  function dealNextStreet(s: State): GameEvent[] {
    let cards: Card[];
    if (s.street === "preflop") {
      s.street = "flop";
      cards = [s.deck.pop()!, s.deck.pop()!, s.deck.pop()!];
    } else if (s.street === "flop") {
      s.street = "turn";
      cards = [s.deck.pop()!];
    } else if (s.street === "turn") {
      s.street = "river";
      cards = [s.deck.pop()!];
    } else {
      return [];
    }
    s.community.push(...cards);
    return [{
      type: "street_dealt",
      data: { street: s.street, cards: cards.map(cardStr), community: s.community.map(cardStr) },
    }];
  }

  /** 无行动余地时发完剩余公共牌（不设行动权）
   * r27-c：runout 补发全部街道相位——正常收街由内核 announcePhase 按相位变化播报（唯一），
   * 但 runout 在单个 apply 内连发多街直抵摊牌/终局，内核只见最终 finished——flop/turn/river
   * 全部丢失（backlog「runout 漏发 phase_started」的准确病灶：中间街+最终街都得引擎自发） */
  function runoutRest(s: State, rng: Rng): GameEvent[] {
    void rng;
    const events: GameEvent[] = [];
    const NEXT: Record<string, string> = { preflop: "flop", flop: "turn", turn: "river" };
    while (s.street !== "river") {
      events.push({ type: "phase_started", data: { phase: NEXT[s.street]!, round: s.handNo } });
      events.push(...dealNextStreet(s));
    }
    s.toAct = null;
    return events;
  }

  /** 摊牌：亮牌 + 有效投入法分池 + 手结算（含开下一手/终局） */
  function showdown(s: State, rng: Rng): GameEvent[] {
    const events: GameEvent[] = [];
    const contenders = s.players.filter((p) => !p.folded);
    closeStreet(s);

    const reveals = contenders.map((p) => ({ seat: p.seat, cards: p.hole.map(cardStr) }));
    const evals = new Map<SeatId, HandEval>();
    for (const p of contenders) evals.set(p.seat, evaluate7([...p.hole, ...s.community]));
    events.push({
      type: "showdown",
      data: {
        reveals,
        evaluations: contenders.map((p) => ({ seat: p.seat, ...evals.get(p.seat)!, name: HAND_NAMES[evals.get(p.seat)!.rank] })),
        community: s.community.map(cardStr),
      },
    });

    const amounts: Record<number, number> = {};
    for (const p of s.players) amounts[p.seat] = 0;
    const levels = [...new Set(s.players.map((p) => p.committed))].sort((a, b) => a - b);
    let prev = 0;
    for (const level of levels) {
      let layerPot = 0;
      for (const p of s.players) layerPot += Math.max(0, Math.min(p.committed, level) - prev);
      if (layerPot === 0) {
        prev = level;
        continue;
      }
      let eligible = contenders.filter((p) => p.committed >= level);
      if (eligible.length === 0) eligible = contenders.filter((p) => p.committed >= prev);
      if (eligible.length > 0) splitPot(layerPot, eligible, evals, amounts, events);
      prev = level;
    }
    // r13 修复（P2）：「超额投入退回」显式化——h13-f / h13-b 都遇到「摊牌输了却出现在 winners 里」，
    // 那部分其实是退回额。现 winners 只留真正赢得底池者，退回额单列 uncalled{seat:amount}，复盘不再反推。
    const calledCap = new Map<SeatId, number>();
    for (const p of s.players) {
      const others = s.players.filter((q) => q.seat !== p.seat && q.committed > 0).map((q) => q.committed);
      calledCap.set(p.seat, others.length ? Math.max(...others) : 0);
    }
    const uncalled: Record<number, number> = {};
    for (const p of s.players) {
      const back = Math.max(0, p.committed - (calledCap.get(p.seat) ?? 0));
      if (back > 0) uncalled[p.seat] = back;
    }
    const realWinners = Object.entries(amounts)
      .filter(([k, v]) => v > 0 && (uncalled[Number(k)] ?? 0) < v)
      .map(([k]) => Number(k));
    events.push({
      type: "hand_ended",
      data: {
        hand_no: s.handNo,
        pot: s.pot,
        winners: realWinners.length > 0 ? realWinners : Object.entries(amounts).filter(([, v]) => v > 0).map(([k]) => Number(k)),
        amounts,
        uncalled,
        reason: "showdown",
      },
    });
    return [...events, ...endHand(s, rng)];
  }

  function splitPot(
    layerPot: number,
    eligible: Player[],
    evals: Map<SeatId, HandEval>,
    amounts: Record<number, number>,
    events: GameEvent[],
  ): void {
    let best: Player | null = null;
    const winners: Player[] = [];
    for (const p of eligible) {
      if (!best || cmpEval(evals.get(p.seat)!, evals.get(best.seat)!) > 0) {
        best = p;
        winners.length = 0;
        winners.push(p);
      } else if (cmpEval(evals.get(p.seat)!, evals.get(best.seat)!) === 0) {
        winners.push(p);
      }
    }
    const share = Math.floor(layerPot / winners.length);
    let rem = layerPot - share * winners.length;
    for (const w of winners) {
      let get = share;
      if (rem > 0) {
        get += 1;
        rem -= 1;
      }
      w.chips += get;
      amounts[w.seat] = (amounts[w.seat] ?? 0) + get;
    }
    if (winners.length > 1) {
      events.push({ type: "pot_split", data: { layer: layerPot, winners: winners.map((w) => w.seat), share } });
    }
  }

  /** 手结束：出局检查 → 终局判定 → 开下一手 */
  function endHand(s: State, rng: Rng): GameEvent[] {
    const events: GameEvent[] = [];
    for (const p of s.players) {
      if (p.chips === 0 && !s.bustedOrder.includes(p.seat)) {
        s.bustedOrder.push(p.seat);
        events.push({ type: "player_eliminated", data: { seat: p.seat, order: s.bustedOrder.length } });
      }
    }
    const alive = s.players.filter((p) => p.chips > 0);
    if (alive.length <= 1) {
      s.finished = true;
      s.toAct = null;
      events.push({ type: "game_ended", data: { winner: alive[0]?.seat ?? null, hands_played: s.handNo, reason: "last_standing" } });
      return events;
    }
    if (s.handNo >= maxHands) {
      s.finished = true;
      s.toAct = null;
      const top = [...alive].sort((a, b) => b.chips - a.chips)[0];
      events.push({ type: "game_ended", data: { winner: top.seat, hands_played: s.handNo, reason: "hand_limit" } });
      return events;
    }
    s.handNo += 1;
    do {
      s.button = (s.button + 1) % s.players.length;
    } while (s.players[s.button].chips === 0);
    return [...events, ...startHand(s, rng)];
  }

  const game: GameModule<State> = {
    meta: {
      id: "holdem_lite",
      name: "德州扑克·简化版",
      minSeats: 2,
      maxSeats: 6,
      defaultTimeoutMs: 60_000,
    },

    init(seats, rng) {
      const players = seats.map((seat) => ({
        seat, chips: startingChips, hole: [], folded: false, allin: false, bet: 0, committed: 0,
      }));
      const s: State = {
        players, deck: [], community: [], street: "preflop", pot: 0,
        button: Math.floor(rng() * players.length),
        toAct: null, currentBet: 0, minRaise: bb, acted: players.map(() => false),
        handNo: 1, finished: false, bustedOrder: [],
      };
      // r13 修复：首手事件不再丢弃——暂存于 state，由 Match 经 initialEvents 钩子入账
      // （纯事件流重建首手账本不再缺 30 筹码；replay 同样经钩子对称重建）
      s.initEvents = startHand(s, rng);
      return s;
    },

    initialEvents(state) {
      const evs = state.initEvents ?? [];
      state.initEvents = undefined; // 取出即清空：防二次入账（Match 与 replay 各自独立 state，互不影响）
      return evs;
    },

    phase(s) {
      return s.finished ? "finished" : s.street;
    },

    round(s) {
      return s.handNo;
    },

    activeSeats(s) {
      if (s.finished || s.toAct === null) return [];
      return [s.players[s.toAct].seat];
    },

    legalActions(s, seat) {
      if (s.finished || s.toAct === null || s.players[s.toAct].seat !== seat) return [];
      const p = s.players[s.toAct];
      const acts: LegalAction[] = [{ type: "fold" }];
      if (p.bet === s.currentBet) acts.push({ type: "check" });
      else acts.push({ type: "call" });
      if (p.chips > 0) {
        const maxTo = p.bet + p.chips;
        const minTo = Math.min(s.currentBet + s.minRaise, maxTo);
        if (maxTo > s.currentBet) {
          acts.push({
            type: "raise",
            schema: {
              to: `int ${minTo}-${maxTo}`,
              // r13：并列数值字段——脚本无需正则解析字符串区间（BRIEF P2：避开惟文本契约）
              to_min: minTo,
              to_max: maxTo,
              rule: `to = 本街总投入（含已投 ${p.bet}）；全下 to = ${maxTo} 恒合法（不足最小加注额时视为不足额全下，不重开他人行动权）`,
            },
          });
        }
        acts.push({ type: "allin" });
      }
      return acts;
    },

    validate(s, seat, action) {
      if (s.finished) return { ok: false, error: "MATCH_FINISHED" };
      if (s.toAct === null || s.players[s.toAct].seat !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      const p = s.players[s.toAct];
      switch (action.type) {
        case "fold":
          return { ok: true };
        case "check":
          if (p.bet !== s.currentBet) {
            return { ok: false, error: "ILLEGAL_ACTION：有人下注时不可 check，须 call/fold/raise" };
          }
          return { ok: true };
        case "call": {
          if (p.bet === s.currentBet) {
            return { ok: false, error: "ILLEGAL_ACTION：当前无需跟注（已持平），请 check" };
          }
          return { ok: true };
        }
        case "raise": {
          const to = action.to as number;
          if (!Number.isInteger(to)) return { ok: false, error: "ILLEGAL_ACTION：to 须为整数" };
          const maxTo = p.bet + p.chips;
          // r13 修复（P1-②）：非法 raise 的 message 携带完整合法区间与决策要素——
          // 原版拆两条且下界只写 currentBet，客户端把 (20, maxTo] 当合法区间（3 人独立踩坑：
          // 短码加注按 currentBet+minRaise 算出 > 全下额的非法 to）。现在机器可解析、人可读。
          const minTo = Math.min(s.currentBet + s.minRaise, maxTo);
          if (to <= s.currentBet || to > maxTo || (to < minTo && to !== maxTo)) {
            return {
              ok: false,
              error: `ILLEGAL_ACTION：to=${to} 非法——合法区间 [${minTo}, ${maxTo}]（to=本街总投入；当前注 ${s.currentBet} · 最小加注增量 ${s.minRaise} · 全下 to=${maxTo}）`,
            };
          }
          return { ok: true };
        }
        case "allin":
          if (p.chips === 0) return { ok: false, error: "ILLEGAL_ACTION：已无筹码" };
          return { ok: true };
        default:
          return {
            ok: false,
            error: `ILLEGAL_ACTION：未知动作类型「${String(action.type)}」——须为 legal_actions 列出的 type 之一（缺 action 字段或 type 拼写错误都会走到这里）`,
          };
      }
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      const idx = s.toAct!;
      const p = s.players[idx];

      /** 动作入账后的推进：手/街结束判定 + 行动权 */
      const advance = (): GameEvent[] => {
        if (aliveCount(s) <= 1) {
          // 全员弃牌：最后一人直接赢池（无需摊牌）
          s.toAct = null;
          const w = s.players.find((q) => !q.folded)!;
          const win = s.pot + s.players.reduce((a, q) => a + q.bet, 0);
          w.chips += win;
          // r13 修复（P2）：amounts 补齐全席位（输家 0）——原 all_folded 只含赢家键，
          // 与 showdown 形态不一致，客户端要写两套解析（h13-a 实测踩到）
          const allAmounts: Record<number, number> = {};
          for (const q of s.players) allAmounts[q.seat] = q.seat === w.seat ? win : 0;
          const uncalledAll: Record<number, number> = {};
          for (const q of s.players) {
            const others = s.players.filter((o) => o.seat !== q.seat).map((o) => o.committed);
            const back = Math.max(0, q.committed - (others.length ? Math.max(...others) : 0));
            if (back > 0) uncalledAll[q.seat] = back;
          }
          events.push({
            type: "hand_ended",
            data: { hand_no: s.handNo, pot: win, winners: [w.seat], amounts: allAmounts, uncalled: uncalledAll, reason: "all_folded" },
          });
          return [...events, ...endHand(s, rng)];
        }
        const canAct = s.players.filter((q) => !q.folded && !q.allin && q.chips > 0);
        const settled = canAct.length === 0 || canAct.every((q) => s.acted[s.players.indexOf(q)] && q.bet === s.currentBet);
        if (settled) {
          if (s.street === "river") {
            // 河牌圈行动收齐：无牌可发，直接摊牌（showdown 内部自会 closeStreet）
            events.push(...showdown(s, rng));
          } else {
            closeStreet(s);
            if (canActCount(s) >= 2 && aliveCount(s) > 1) {
              // 正常进入下一街（设行动权）
              events.push(...dealNextStreet(s));
              // postflop 行动起点 = 庄家下一位在局者起找第一个可行动者（标准规则）：
              // 满员桌 = SB 先行动、button 最后（button 位置优势）；
              // heads-up = BB 先行动、button 后行动（button 在 preflop 先动、postflop 拥有
              // 位置优势——"button acts first preflop and last on every street after it"）。
              // r13 裁定：h13-b 的此版规则正确（曾误改回 sbIdx 起点致 heads-up 顺序颠倒，已纠正）
              s.toAct = nextCanActIdx(s, nextLiveFrom(s, s.button + 1));
            } else {
              // 无行动余地：发完剩余公共牌直接摊牌
              events.push(...runoutRest(s, rng));
              events.push(...showdown(s, rng));
            }
          }
        } else {
          s.toAct = nextCanActIdx(s, (idx + 1) % s.players.length);
        }
        return events;
      };

      // r13 修复（P2）：action 事件自带 hand_no / street——此前一只 action 只带 seat/action，
      // 属于哪一手的哪一街只能靠 hand_started 与 street_dealt 的先后顺序推断（首手尤难）
      const actEvent = (data: Record<string, unknown>): void => {
        events.push({ type: "action", data: { ...data, hand_no: s.handNo, street: s.street } });
      };

      switch (action.type) {
        case "fold": {
          p.folded = true;
          s.acted[idx] = true;
          actEvent({ seat, action: "fold" });
          return { state: s, events: advance() };
        }
        case "check": {
          s.acted[idx] = true;
          actEvent({ seat, action: "check" });
          return { state: s, events: advance() };
        }
        case "call": {
          const need = Math.min(s.currentBet - p.bet, p.chips);
          p.chips -= need;
          p.bet += need;
          p.committed += need;
          if (p.chips === 0) p.allin = true;
          s.acted[idx] = true;
          actEvent({ seat, action: "call", amount: need, to: p.bet });
          return { state: s, events: advance() };
        }
        case "raise": {
          const to = action.to as number;
          const pay = to - p.bet;
          const isAllin = pay === p.chips;
          p.chips -= pay;
          p.bet = to;
          p.committed += pay;
          if (p.chips === 0) p.allin = true;
          s.acted[idx] = true;
          const raiseSize = to - s.currentBet;
          if (raiseSize >= s.minRaise) {
            // 足额加注：更新最小增量并重开他人行动权
            s.minRaise = raiseSize;
            for (let i = 0; i < s.players.length; i++) {
              const q = s.players[i];
              if (i !== idx && !q.folded && !q.allin && q.chips > 0) s.acted[i] = false;
            }
          }
          s.currentBet = Math.max(s.currentBet, to);
          actEvent({ seat, action: isAllin ? "allin" : "raise", to, amount: pay });
          return { state: s, events: advance() };
        }
        case "allin": {
          const pay = p.chips;
          const to = p.bet + pay;
          p.chips = 0;
          p.bet = to;
          p.committed += pay;
          p.allin = true;
          s.acted[idx] = true;
          const raiseSize = to - s.currentBet;
          if (raiseSize >= s.minRaise) {
            s.minRaise = raiseSize;
            for (let i = 0; i < s.players.length; i++) {
              const q = s.players[i];
              if (i !== idx && !q.folded && !q.allin && q.chips > 0) s.acted[i] = false;
            }
          }
          s.currentBet = Math.max(s.currentBet, to);
          actEvent({ seat, action: "allin", to, amount: pay });
          return { state: s, events: advance() };
        }
        default:
          return { state: s, events: [] };
      }
    },

    viewOf(s, viewer) {
      // r13 修复（P2）：total_pot = 已收池 + 本街在途投入——真实奖池一步可得。
      // 原 public.pot 不含本街 bet（preflop 常见 pot=0/current_bet=20），4 名选手按 pot 直接算赔率
      // 出现系统性虚高弃牌（实盘 -32% 净值）；此前口径需 pot + Σplayers[].bet 手工还原。
      const totalPot = s.pot + s.players.reduce((a, p) => a + p.bet, 0);
      const pub: Record<string, unknown> = {
        hand_no: s.handNo,
        street: s.street,
        community: s.community.map(cardStr),
        pot: s.pot,
        total_pot: totalPot,
        current_bet: s.currentBet,
        min_raise: s.minRaise,
        to_act: s.toAct === null ? null : s.players[s.toAct].seat,
        button: s.players[s.button].seat,
        starting_chips: startingChips,
        small_blind: sb,
        big_blind: bb,
        max_hands: maxHands,
        players: s.players.map((p) => ({
          seat: p.seat,
          chips: p.chips,
          bet: p.bet,
          committed: p.committed,
          folded: p.folded,
          allin: p.allin,
          // r13 修复（P2）：出局态显式化——此前只能靠 chips===0 反推（h13-b 出局后脚本仍在用
          // 上一手残留的 hole_cards 算胜率）。观战/复盘的席位归属不再需要猜。
          eliminated: s.bustedOrder.includes(p.seat),
          elimination_order: s.bustedOrder.includes(p.seat) ? s.bustedOrder.indexOf(p.seat) + 1 : null,
        })),
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      const me = s.players.find((p) => p.seat === viewer);
      if (!me) return { public: pub, private: {} };
      const busted = s.bustedOrder.includes(me.seat);
      return {
        public: pub,
        private: {
          // 出局者底牌置空：既无牌可下，也不该让脚本拿过期数据继续算
          hole_cards: busted ? [] : me.hole.map(cardStr),
          my_chips: me.chips,
          my_bet: me.bet,
          my_committed: me.committed,
          eliminated: busted,
          elimination_order: busted ? s.bustedOrder.indexOf(me.seat) + 1 : null,
        },
      };
    },

    timeoutAction(s, seat) {
      // 超时友好默认：能 check 则 check（零成本），否则 fold（最保守——绝不替玩家投入筹码）
      const p = s.players.find((q) => q.seat === seat);
      if (p && p.bet === s.currentBet) return { type: "check" };
      return { type: "fold" };
    },

    isTerminal(s) {
      return s.finished;
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      let winner: SeatId | null = null;
      if (s.finished) {
        const alive = s.players.filter((p) => p.chips > 0);
        if (alive.length === 1) winner = alive[0].seat;
        else if (alive.length > 1) winner = [...alive].sort((a, b) => b.chips - a.chips)[0].seat;
      }
      for (const p of s.players) out[p.seat] = p.seat === winner ? 1 : 0;
      return out;
    },

    /** 出局态：筹码归零即出局（与 view.players[].eliminated 同源） */
    seatAlive(s, seat) {
      return (s.players.find((p) => p.seat === seat)?.chips ?? 0) > 0;
    },

    /**
     * r30：终局全序名次。scores 只有冠军 1 分，其余 5 人全是 0——兜底名次会把
     * 「第 2 名」与「第 6 名」判成并列，多模型对照实验在 holdem 上直接失去分辨率。
     * 排序：剩余筹码降序 → 出局顺序（越晚出局越好）→ 座位号升序。
     */
    placements(s) {
      const rows = s.players.map((p) => ({
        seat: p.seat,
        chips: p.chips,
        bust: s.bustedOrder.indexOf(p.seat), // -1 = 未出局
      }));
      rows.sort((a, b) => b.chips - a.chips || b.bust - a.bust || a.seat - b.seat);
      let rank = 0;
      let prevKey: string | null = null;
      return rows.map((r, i) => {
        const key = `${r.chips}|${r.bust}`;
        if (key !== prevKey) rank = i + 1;
        prevKey = key;
        return {
          seat: r.seat,
          rank,
          note: r.bust >= 0 ? `chips=${r.chips},eliminated_order=${r.bust + 1}` : `chips=${r.chips}`,
        };
      });
    },
  };

  return game;
}
