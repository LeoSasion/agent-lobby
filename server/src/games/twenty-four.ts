/**
 * 24 点（twenty_four）—— 算术解谜 · 同时相位 · 第十一款（r38）
 *
 * 每局发 4 张牌（1-13），全员同时提交一个用这 4 个数各一次、结果为 24 的算式。
 * 解出者本局 +1，解不出 0；N 局后总分高者胜。**不做抢答**——内核是「收齐才结算」，
 * 没有「第一个到达」的语义，硬做会变成「谁的网络快谁赢」。
 *
 * 安全铁律：**绝不能用 eval 解析玩家提交的算式**。这里是一个只认「数字 + - * / ( )」
 * 的手写递归下降解析器，其他字符一律非法。同时校验「用掉的数字多重集必须等于发的牌」，
 * 防止「24*(1)」这种蒙混。
 *
 * 无解牌组是真实存在的（约两成），该局全员得 0——这是设计的一部分，不是 bug。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export const TF_TARGET = 24;
export const TF_DEFAULT_ROUNDS = 10;

interface RoundRecord {
  round: number;
  cards: number[];
  /** 本局每题：谁提交了什么、是否算对 */
  answers: Record<string, { expr: string; ok: boolean }>;
  scores: Record<string, number>;
}

interface State {
  seats: SeatId[];
  round: number;
  totalRounds: number;
  cards: number[];
  /** 本局已提交的算式 */
  pending: Map<SeatId, string | null>;
  scores: Map<SeatId, number>;
  history: RoundRecord[];
  phase: "solving" | "finished";
  winner: SeatId | "draw" | null;
  initEvents: GameEvent[];
}

/** 牌面字面 → 数值（只接受整数 1-13 的字符串形式） */
function parseCardToken(tok: string): number | null {
  if (!/^\d{1,2}$/.test(tok)) return null;
  const n = Number(tok);
  return n >= 1 && n <= 13 ? n : null;
}

/** 手写递归下降求值：数字 / + - * / / 括号。非法返回 null（绝不 eval） */
export function evalExpression(src: string): { value: number; used: number[] } | null {
  const s = String(src).replace(/\s+/g, "");
  if (!s || s.length > 200) return null;
  let i = 0;
  const used: number[] = [];
  const fail = (): never => {
    throw new Error("BAD");
  };
  function peek(): string {
    return s[i] ?? "";
  }
  function parseFactor(): number {
    const c = peek();
    if (c === "(") {
      i++;
      const v = parseSum();
      if (peek() !== ")") fail();
      i++;
      return v;
    }
    let digits = "";
    while (/\d/.test(peek())) digits += s[i++];
    const n = parseCardToken(digits);
    if (n === null) throw new Error("BAD");
    used.push(n);
    return n;
  }
  function parseUnary(): number {
    if (peek() === "-") {
      i++;
      return -parseUnary();
    }
    return parseFactor();
  }
  function parseProduct(): number {
    let v = parseUnary();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= parseUnary(); }
      else if (c === "/") {
        i++;
        const d = parseUnary();
        if (d === 0) fail();
        v /= d;
      } else break;
    }
    return v;
  }
  function parseSum(): number {
    let v = parseProduct();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += parseProduct(); }
      else if (c === "-") { i++; v -= parseProduct(); }
      else break;
    }
    return v;
  }
  try {
    const value = parseSum();
    if (i !== s.length) return null;
    return { value, used };
  } catch {
    return null;
  }
}

/** 校验：算式合法 + 数字多重集与牌面一致 + 结果等于 24 */
export function checkSolution(expr: string, cards: number[]): boolean {
  const r = evalExpression(expr);
  if (!r) return false;
  if (Math.abs(r.value - TF_TARGET) > 1e-9) return false;
  const a = [...r.used].sort((x, y) => x - y);
  const b = [...cards].sort((x, y) => x - y);
  return a.length === b.length && a.every((v, k) => v === b[k]);
}

function deal(rng: Rng): number[] {
  return [0, 1, 2, 3].map(() => 1 + Math.floor(rng() * 13));
}

export function createTwentyFour(config: { rounds?: number } = {}): GameModule<State> {
  const totalRounds = Math.max(1, Math.min(30, config.rounds ?? TF_DEFAULT_ROUNDS));

  const game: GameModule<State> = {
    meta: { id: "twenty_four", name: "24 点", minSeats: 2, maxSeats: 6, defaultTimeoutMs: 45_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length < 2 || seats.length > 6) throw new Error("twenty_four 需要 2–6 席");
      const cards = deal(rng);
      const s: State = {
        seats: [...seats],
        round: 1,
        totalRounds,
        cards,
        pending: new Map(),
        scores: new Map(seats.map((t) => [t, 0])),
        history: [],
        phase: "solving",
        winner: null,
        initEvents: [{ type: "cards_dealt", data: { round: 1, total_rounds: totalRounds, cards } }],
      };
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
      return s.phase === "solving" ? s.seats.filter((t) => !s.pending.has(t)) : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "solving" || !s.seats.includes(seat) || s.pending.has(seat)) return [];
      return [
        {
          type: "solve",
          schema: { expr: "string 1-200", rule: "只能使用 + - * / ( ) 与这四张牌的数字，每张用一次" },
          hint: `用 ${s.cards.join(" ")} 各一次算出 24；算不出就 pass`,
        },
        { type: "pass", hint: "本局放弃" },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.pending.has(seat)) return { ok: false, error: "DUPLICATE_ACTION：本局已提交" };
      if (action.type === "pass") return { ok: true };
      if (action.type !== "solve") return { ok: false, error: "ILLEGAL_ACTION：仅可 solve 或 pass" };
      const expr = action.expr;
      if (typeof expr !== "string" || expr.length < 1 || expr.length > 200) {
        return { ok: false, error: "ILLEGAL_ACTION：expr 须为 1-200 字符" };
      }
      return { ok: true };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      if (s.phase !== "solving") return { state: s, events };
      s.pending.set(seat, action.type === "pass" ? null : String(action.expr));
      if (s.pending.size < s.seats.length) return { state: s, events };

      // 收齐结算
      const answers: Record<string, { expr: string; ok: boolean }> = {};
      for (const t of s.seats) {
        const expr = s.pending.get(t) ?? null;
        if (expr === null) {
          answers[String(t)] = { expr: "", ok: false };
        } else {
          answers[String(t)] = { expr, ok: checkSolution(expr, s.cards) };
          if (answers[String(t)]!.ok) s.scores.set(t, (s.scores.get(t) ?? 0) + 1);
        }
      }
      const scores = Object.fromEntries([...s.scores.entries()].map(([k, v]) => [String(k), v]));
      s.history.push({ round: s.round, cards: [...s.cards], answers, scores });
      s.pending = new Map();
      events.push({
        type: "round_resolved",
        data: {
          round: s.round,
          is_final: s.round >= s.totalRounds,
          cards: s.cards,
          answers,
          scores,
        },
      });

      if (s.round >= s.totalRounds) {
        s.phase = "finished";
        const best = Math.max(...s.seats.map((t) => s.scores.get(t) ?? 0));
        const champs = s.seats.filter((t) => (s.scores.get(t) ?? 0) === best);
        s.winner = best <= 0 ? "draw" : champs.length === 1 ? champs[0]! : "draw";
        events.push({
          type: "game_won",
          data: {
            winner: s.winner,
            scores,
            rounds: s.totalRounds,
            reason: best <= 0 ? "无人解出任何一局" : champs.length === 1 ? "解出局数最多" : "并列最多，平局",
          },
        });
        return { state: s, events };
      }

      s.round += 1;
      s.cards = deal(rng); // 必须用内核传入的 rng——用 Math.random 会破坏同 seed 确定性
      events.push({ type: "cards_dealt", data: { round: s.round, total_rounds: s.totalRounds, cards: s.cards } });
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const scores = Object.fromEntries([...s.scores.entries()].map(([k, v]) => [String(k), v]));
      const pub: Record<string, unknown> = {
        phase: s.phase,
        round: s.round,
        total_rounds: s.totalRounds,
        cards: s.cards,
        target: TF_TARGET,
        scores,
        history: s.history,
        submitted_seats: s.phase === "solving" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return {
        public: pub,
        private: { my_score: s.scores.get(viewer) ?? 0, my_answer: s.pending.get(viewer) ?? null },
      };
    },

    timeoutAction() {
      // 超时 = 放弃本局（确定性，且不会误判为答对）
      return { type: "pass" };
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
        return { seat: r.seat, rank, note: `solved=${r.v}` };
      });
    },
  };

  return game;
}
