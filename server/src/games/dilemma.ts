/**
 * 囚徒困境·迭代赛（dilemma）—— 博弈论经典 · 闪电快局（路线图 Phase 1 欠账项，OutplayArena/Agent Sports League 共有品类）
 * 2 席 N 轮（默认 10 轮）每轮同时选择合作(cooperate)/背叛(betray)
 * 收益矩阵（Axelrod 经典）：双合作 R=3/3 · 双背叛 P=1/1 · 单方背叛 T=5 / S=0
 * 每轮收齐即结算（同时相位在 apply 内自检，内核不感知相位类型）
 * 信息隔离：本轮选择互不可见直至结算（acted 事件仅本人可见——actionVisibility:{seats:[seat]}）；
 *   历史轮完全公开（迭代博弈的记忆基础）；「谁已出手」经 ctx.submittedSeats 公开（消除盲等，不泄选择）
 * scores 语义：胜者 1 / 负者 0 / 平局各 0.5（总收益仅入事件流供观赏，不进 scores——保持全平台「scores>0=胜者」口径）
 * 超时默认 = 背叛（沉默即不合作——协议 §7.5 明示，与狼人杀「绝不代狼抢刀」同理：超时动作须确定性且可预期）
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export type Choice = "cooperate" | "betray";

export interface DilemmaConfig {
  /** 迭代轮数（默认 10） */
  rounds?: number;
}

/** Axelrod 锦标赛经典收益值 */
export const PAYOFF = { T: 5, R: 3, P: 1, S: 0 } as const;

interface RoundRecord {
  round: number;
  choices: Record<string, Choice>;
  payoff: Record<string, number>;
  totals: Record<string, number>;
}

interface State {
  seats: SeatId[];
  round: number;
  totalRounds: number;
  phase: "playing" | "finished";
  pending: Map<SeatId, Choice>;
  history: RoundRecord[];
  totals: Map<SeatId, number>;
  /** 终局裁决：胜者席位或 "draw" */
  winner: SeatId | "draw" | null;
  /** 开局事件暂存（r13 initialEvents 钩子：首轮 round_started 入流） */
  initEvents: GameEvent[];
}

function payoffOf(a: Choice, b: Choice): [number, number] {
  if (a === "cooperate" && b === "cooperate") return [PAYOFF.R, PAYOFF.R];
  if (a === "cooperate" && b === "betray") return [PAYOFF.S, PAYOFF.T];
  if (a === "betray" && b === "cooperate") return [PAYOFF.T, PAYOFF.S];
  return [PAYOFF.P, PAYOFF.P];
}

export function createDilemma(config: DilemmaConfig = {}): GameModule<State> {
  const totalRounds = Math.max(1, Math.min(50, config.rounds ?? 10));

  const game: GameModule<State> = {
    meta: { id: "dilemma", name: "囚徒困境·迭代赛", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 30_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 2) throw new Error("dilemma 需要 2 席");
      void rng; // 无随机性：完全确定的对局结构
      const s: State = {
        seats: [...seats],
        round: 1,
        totalRounds,
        phase: "playing",
        pending: new Map(),
        history: [],
        totals: new Map(seats.map((t) => [t, 0])),
        winner: null,
        initEvents: [{ type: "round_started", data: { round: 1, total_rounds: totalRounds } }],
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
      return s.phase === "playing" ? s.seats.filter((t) => !s.pending.has(t)) : [];
    },

    legalActions(s, seat) {
      if (s.phase !== "playing" || !s.seats.includes(seat) || s.pending.has(seat)) return [];
      return [
        {
          type: "move",
          schema: { choice: "enum", values: ["cooperate", "betray"] },
          hint: "本轮一次性选择（双方收齐才揭晓）",
        },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.pending.has(seat)) return { ok: false, error: "DUPLICATE_ACTION：本轮已提交" };
      if (action.type !== "move") return { ok: false, error: "ILLEGAL_ACTION：仅可 move" };
      if (action.choice !== "cooperate" && action.choice !== "betray") {
        return { ok: false, error: "ILLEGAL_ACTION：choice 须为 cooperate | betray" };
      }
      return { ok: true };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };
      s.pending.set(seat, action.choice as Choice);
      if (s.pending.size < 2) return { state: s, events }; // 未收齐：等对手

      // 收齐结算：本轮双方选择互不可见 → 同时揭晓
      const [a, b] = s.seats;
      const ca = s.pending.get(a) as Choice;
      const cb = s.pending.get(b) as Choice;
      const [pa, pb] = payoffOf(ca, cb);
      s.totals.set(a, (s.totals.get(a) ?? 0) + pa);
      s.totals.set(b, (s.totals.get(b) ?? 0) + pb);
      const totals = Object.fromEntries([...s.totals.entries()]);
      const record: RoundRecord = {
        round: s.round,
        choices: { [String(a)]: ca, [String(b)]: cb },
        payoff: { [String(a)]: pa, [String(b)]: pb },
        totals,
      };
      s.history.push(record);
      s.pending = new Map();
      events.push({
        type: "round_resolved",
        data: {
          round: s.round,
          is_final: s.round === s.totalRounds,
          pattern: ca === cb ? (ca === "cooperate" ? "CC" : "DD") : "CD",
          ...Object.fromEntries(
            Object.entries(record).filter(([k]) => k !== "round"),
          ),
        },
      });

      if (s.round >= s.totalRounds) {
        // 终局：总收益定胜负（平局 = 双方总收益相等）
        s.phase = "finished";
        const ta = s.totals.get(a) ?? 0;
        const tb = s.totals.get(b) ?? 0;
        s.winner = ta === tb ? "draw" : ta > tb ? a : b;
        events.push({
          type: "game_won",
          data: { winner: s.winner, totals, rounds_played: s.totalRounds, reason: "迭代结束，总收益结算" },
        });
        return { state: s, events };
      }
      s.round += 1;
      events.push({ type: "round_started", data: { round: s.round, total_rounds: s.totalRounds } });
      return { state: s, events };
    },

    viewOf(s, viewer, ctx) {
      const totals = Object.fromEntries([...s.totals.entries()]);
      const pub: Record<string, unknown> = {
        round: s.round,
        total_rounds: s.totalRounds,
        phase: s.phase,
        seats: s.seats,
        totals,
        history: s.history,
        payoff_matrix: { ...PAYOFF },
        // 同时相位公开进度：「谁已出手」不泄露选择（CD 揭晓前双方对称）
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return {
        public: pub,
        private: {
          my_choice_this_round: s.pending.get(viewer) ?? null, // 提交后自见（防重复提交困惑），对手不可见
        },
      };
    },

    timeoutAction() {
      // 超时 = 背叛：沉默即不合作（协议 §7.5 明示——确定性兜底，绝不随机）
      return { type: "move", choice: "betray" };
    },

    actionVisibility(s, seat) {
      // playing 相位：acted/timed_out 仅本人可见——对手不得据此推断本轮选择
      if (s.phase === "playing" && s.seats.includes(seat)) return { seats: [seat] };
      return "all";
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) {
        out[t] = s.winner === null ? 0 : s.winner === "draw" ? 0.5 : t === s.winner ? 1 : 0;
      }
      return out;
    },
  };

  return game;
}
