/**
 * 21 点（blackjack）—— 对庄家 · 不完全信息 · 第十二款（r38）
 *
 * 2-6 席，**庄家由平台扮演**（不是第三个选手）。每局各发 2 张，庄家 1 明 1 暗；
 * 所有未完成的玩家同时决定「要牌（hit）」或「停牌（stand）」，多轮直到全员停/爆；
 * 然后庄家按固定规则补牌（<17 必须要，>=17 停），逐人比点。
 *
 * A 记 1 或 11（取不爆的最大值）；J/Q/K 记 10。
 * 每局胜负：赢 +1 / 平 +0.5 / 输 0，多局累计（默认 5 局），总分高者胜。
 *
 * 信息隔离：庄家的暗牌在全员停牌前**不可见**（否则玩家能算出该不该要牌，游戏就没了）。
 * 其他玩家的手牌是公开的——这是真实 21 点桌上的情况。
 *
 * 与 holdem 的区别（同属「牌 + 概率」但机制完全不同）：
 * holdem 是玩家互相对抗、有下注轮与诈唬；21 点是**共同对抗庄家**、只有要牌/停牌两个动作，
 * 决策依据是「我的手牌 vs 庄家明牌」的期望值。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export const BJ_DEFAULT_ROUNDS = 5;
const DEALER_STAND = 17;

/** 牌值：1=A，11=J，12=Q，13=K */
export type Card = number;

export function cardValue(c: Card): number {
  if (c === 1) return 11;
  return Math.min(c, 10);
}

/** 手牌点数：A 先按 11 算，爆了再逐个降为 1 */
export function handValue(cards: Card[]): number {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c === 1) { aces++; sum += 11; }
    else sum += cardValue(c);
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}

export interface RoundOutcome {
  round: number;
  dealer: Card[];
  dealerValue: number;
  results: Record<string, { cards: Card[]; value: number; outcome: "win" | "lose" | "push" }>;
}

interface State {
  seats: SeatId[];
  round: number;
  totalRounds: number;
  deck: Card[];
  hands: Map<SeatId, Card[]>;
  stood: Set<SeatId>;
  busted: Set<SeatId>;
  /** 庄家手牌；dealerUp 恒为第 0 张（明牌） */
  dealer: Card[];
  dealerRevealed: boolean;
  pending: Map<SeatId, "hit" | "stand">;
  scores: Map<SeatId, number>;
  history: RoundOutcome[];
  phase: "playing" | "finished";
  winner: SeatId | "draw" | null;
  initEvents: GameEvent[];
  /** 洗牌用（牌堆耗尽时重洗）；内核每步传入同一 rng，存一份即可 */
  deckRng?: Rng;
}

function newDeck(rng: Rng): Card[] {
  const d: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let c = 1; c <= 13; c++) d.push(c);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = d[i]!;
    d[i] = d[j]!;
    d[j] = t;
  }
  return d;
}

function dealOne(s: State): Card {
  if (s.deck.length === 0) s.deck = newDeck(s.deckRng ?? (() => 0.5));
  return s.deck.pop()!;
}

export function createBlackjack(config: { rounds?: number } = {}): GameModule<State> {
  const totalRounds = Math.max(1, Math.min(20, config.rounds ?? BJ_DEFAULT_ROUNDS));

  const game: GameModule<State> = {
    meta: { id: "blackjack", name: "21 点", minSeats: 2, maxSeats: 6, defaultTimeoutMs: 40_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length < 2 || seats.length > 6) throw new Error("blackjack 需要 2–6 席");
      const s: State = {
        seats: [...seats],
        round: 1,
        totalRounds,
        deck: newDeck(rng),
        hands: new Map(),
        stood: new Set(),
        busted: new Set(),
        dealer: [],
        dealerRevealed: false,
        pending: new Map(),
        scores: new Map(seats.map((t) => [t, 0])),
        history: [],
        phase: "playing",
        winner: null,
        initEvents: [],
      };
      s.deckRng = rng;
      // 发牌：每人两张，庄家一张（明）+ 一张（暗）
      for (const t of s.seats) s.hands.set(t, [dealOne(s), dealOne(s)]);
      s.dealer.push(dealOne(s), dealOne(s));
      s.initEvents.push({ type: "hand_dealt", data: { round: 1, total_rounds: totalRounds, dealer_up: s.dealer[0]! } });
      return s;
    },

    initialEvents(state) {
      return state.initEvents.splice(0);
    },

    phase(s) {
      return s.phase;
    },

    round(s) {
      return s.round;
    },

    activeSeats(s) {
      if (s.phase !== "playing") return [];
      return s.seats.filter((t) => !s.stood.has(t) && !s.busted.has(t) && !s.pending.has(t));
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || !s.seats.includes(seat)) return [];
      if (s.stood.has(seat) || s.busted.has(seat) || s.pending.has(seat)) return [];
      return [
        { type: "hit", hint: "要一张牌；超过 21 点即爆" },
        { type: "stand", hint: "停牌，按当前点数结算" },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.stood.has(seat)) return { ok: false, error: "ILLEGAL_ACTION：已停牌" };
      if (s.busted.has(seat)) return { ok: false, error: "ILLEGAL_ACTION：已爆牌" };
      if (s.pending.has(seat)) return { ok: false, error: "DUPLICATE_ACTION：本步已提交" };
      if (action.type !== "hit" && action.type !== "stand") {
        return { ok: false, error: "ILLEGAL_ACTION：仅可 hit 或 stand" };
      }
      return { ok: true };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };
      s.deckRng = rng;
      s.pending.set(seat, action.type === "hit" ? "hit" : "stand");
      if (s.pending.size < activeCount(s)) return { state: s, events };

      // 本步收齐：逐个执行
      for (const t of s.seats) {
        const act = s.pending.get(t);
        if (!act) continue;
        if (act === "stand") {
          s.stood.add(t);
          events.push({ type: "stood", data: { seat: t, value: handValue(s.hands.get(t) ?? []) } });
        } else {
          const hand = s.hands.get(t)!;
          hand.push(dealOne(s));
          const v = handValue(hand);
          events.push({ type: "hit_drawn", data: { seat: t, card: hand[hand.length - 1]!, value: v } });
          if (v > 21) {
            s.busted.add(t);
            events.push({ type: "busted", data: { seat: t, value: v } });
          }
        }
      }
      s.pending = new Map();

      // 还有人在要牌 → 继续下一步
      if (s.seats.some((t) => !s.stood.has(t) && !s.busted.has(t))) return { state: s, events };

      // 全员完成 → 庄家补牌
      s.dealerRevealed = true;
      while (handValue(s.dealer) < DEALER_STAND) s.dealer.push(dealOne(s));
      const dv = handValue(s.dealer);
      events.push({ type: "dealer_revealed", data: { dealer: s.dealer, value: dv } });

      const results: Record<string, { cards: Card[]; value: number; outcome: "win" | "lose" | "push" }> = {};
      for (const t of s.seats) {
        const hand = s.hands.get(t) ?? [];
        const v = handValue(hand);
        let outcome: "win" | "lose" | "push";
        if (v > 21) outcome = "lose";
        else if (dv > 21) outcome = "win";
        else if (v > dv) outcome = "win";
        else if (v === dv) outcome = "push";
        else outcome = "lose";
        results[String(t)] = { cards: [...hand], value: v, outcome };
        const delta = outcome === "win" ? 1 : outcome === "push" ? 0.5 : 0;
        s.scores.set(t, (s.scores.get(t) ?? 0) + delta);
      }
      const scores = Object.fromEntries([...s.scores.entries()].map(([k, v]) => [String(k), v]));
      s.history.push({ round: s.round, dealer: [...s.dealer], dealerValue: dv, results });
      events.push({ type: "round_settled", data: { round: s.round, is_final: s.round >= s.totalRounds, dealer: s.dealer, dealer_value: dv, results, scores } });

      if (s.round >= s.totalRounds) {
        s.phase = "finished";
        const best = Math.max(...s.seats.map((t) => s.scores.get(t) ?? 0));
        const champs = s.seats.filter((t) => (s.scores.get(t) ?? 0) === best);
        s.winner = best <= 0 ? "draw" : champs.length === 1 ? champs[0]! : "draw";
        events.push({ type: "game_won", data: { winner: s.winner, scores, rounds: s.totalRounds, reason: best <= 0 ? "全员未赢一局" : champs.length === 1 ? "累计得分最高" : "并列最高，平局" } });
        return { state: s, events };
      }

      // 下一局：重新洗牌发牌
      s.round += 1;
      s.deck = newDeck(rng);
      s.hands = new Map();
      s.stood = new Set();
      s.busted = new Set();
      s.dealer = [];
      s.dealerRevealed = false;
      s.pending = new Map();
      for (const t of s.seats) s.hands.set(t, [dealOne(s), dealOne(s)]);
      s.dealer.push(dealOne(s), dealOne(s));
      events.push({ type: "hand_dealt", data: { round: s.round, total_rounds: s.totalRounds, dealer_up: s.dealer[0]! } });
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      // 庄家暗牌在揭示前不下发——连张数都只给「明牌 + 是否还有暗牌」
      const dealerUp = s.dealer[0] ?? null;
      const players = s.seats.map((t) => {
        const hand = s.hands.get(t) ?? [];
        return { seat: t, cards: hand, value: handValue(hand), stood: s.stood.has(t), busted: s.busted.has(t) };
      });
      const pub: Record<string, unknown> = {
        phase: s.phase,
        round: s.round,
        total_rounds: s.totalRounds,
        dealer_up: dealerUp,
        dealer_revealed: s.dealerRevealed,
        dealer: s.dealerRevealed ? s.dealer : null,
        dealer_value: s.dealerRevealed ? handValue(s.dealer) : null,
        players,
        scores: Object.fromEntries([...s.scores.entries()].map(([k, v]) => [String(k), v])),
        history: s.history,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      const mine = s.hands.get(viewer) ?? [];
      return {
        public: pub,
        private: { my_cards: mine, my_value: handValue(mine), my_score: s.scores.get(viewer) ?? 0 },
      };
    },

    timeoutAction() {
      // 超时 = 停牌（确定性；继续要牌可能把好牌要爆，风险不可控）
      return { type: "stand" };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) out[t] = s.winner === null ? 0 : s.winner === "draw" ? 0.5 : t === s.winner ? 1 : 0;
      return out;
    },

    seatAlive() {
      return true;
    },

    placements(s) {
      const rows = s.seats.map((seat) => ({ seat, v: s.scores.get(seat) ?? 0 }));
      rows.sort((a, b) => b.v - a.v || a.seat - b.seat);
      let rank = 0;
      let prev: number | null = null;
      return rows.map((r, i) => {
        if (prev === null || r.v !== prev) rank = i + 1;
        prev = r.v;
        return { seat: r.seat, rank, note: `score=${r.v}` };
      });
    },
  };

  return game;
}

function activeCount(s: State): number {
  return s.seats.filter((t) => !s.stood.has(t) && !s.busted.has(t)).length;
}
