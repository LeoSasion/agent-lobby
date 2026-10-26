/**
 * 拍卖行·密封竞价（auction）—— 博弈论第三类：私有估值 + 竞价（r34 新增 · 第七款游戏）
 *
 * 为什么是这款：现有六款里 dilemma 演示「合作/背叛」、holdem 演示「概率与诈唬」，
 * 但**多席同时出价 + 私有估值**这个组合从未出现；它还是最能压测框架的两项能力——
 * 同时相位收齐结算、私有信息隔离（估值只有本人看得见，观众也看不见）。
 *
 * 规则（首价密封拍卖 · First-Price Sealed-Bid）：
 * - 2–6 席，共 6 件拍品，每席初始资金 100
 * - 每件拍品对每席有**私有估值**（10–100，各席不同，由 match seed 派生）
 * - 所有席同时提交出价（0 ≤ 出价 ≤ 本人余额），出价互相不可见，收齐才揭晓
 * - 最高价者得标，支付自己的出价（首价）；平局按座位号小者优先（确定性）
 * - 得标者净收益 += 估值 − 出价；全部出价为 0 则流拍
 * - 终局：累计净收益最高者胜
 *
 * 得分口径：净收益最高且 > 0 → 1，其余 0；最高净收益 ≤ 0（都不赚）→ 全 0（无胜者）。
 * 原始净收益与成交价只入事件流与 public，不进 scores —— 保持全平台「scores>0=胜者」口径。
 *
 * 易错点（接入新游戏时最容易踩的三处，写在这里省得后人重犯）：
 * 1. 估值必须在**每轮开局时**重新生成并只发给本人——提前把全部轮次的估值放进 state 也
 *    可以（能算出来），但视图绝不能漏；本实现每轮只生成当前拍品，从源头上没有可漏的东西。
 * 2. 「是否已出价」可以公开（等于 submitted_seats），但**金额**绝不能在结算前进入任何
 *    公开事件或 public 视图——否则后手可以看价改价，同时相位就废了。
 * 3. 出价上限是「本人余额」而非全局常量，legalActions 必须按席位算，不能给同一份法表。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

/** 每席初始资金 */
export const START_BALANCE = 100;
/** 拍品数量（轮数） */
export const LOT_COUNT = 6;
/** 私有估值的取值区间（闭区间） */
export const ESTIMATE_RANGE = { min: 10, max: 100 } as const;

/** 拍品名池：按轮次取，不做随机（同一 seed 的观战叙事更稳定） */
const LOT_NAMES = [
  "青花瓷瓶",
  "旧银怀表",
  "绝版邮票",
  "古董打字机",
  "手绘屏风",
  "老式留声机",
  "青铜香炉",
  "木雕佛像",
] as const;

interface LotRecord {
  round: number;
  lot: string;
  /** 本轮全部出价（结算后公开——这是竞价的观赏核心） */
  bids: Record<string, number>;
  /** 本轮各席估值（结算后公开，观众才能看懂「他为什么出这个价」） */
  estimates: Record<string, number>;
  /** 得标席位；null = 流拍 */
  winner: SeatId | null;
  price: number;
  /** 本轮结束后的累计净收益快照 */
  net: Record<string, number>;
  /** 本轮结束后的余额快照 */
  balance: Record<string, number>;
}

interface State {
  seats: SeatId[];
  round: number;
  totalRounds: number;
  phase: "bidding" | "finished";
  lot: string;
  /** 本件拍品对每席的私有估值 */
  estimate: Map<SeatId, number>;
  /** 本轮已提交的出价 */
  pending: Map<SeatId, number>;
  balance: Map<SeatId, number>;
  net: Map<SeatId, number>;
  history: LotRecord[];
  initEvents: GameEvent[];
}

function rollEstimate(rng: Rng): number {
  const { min, max } = ESTIMATE_RANGE;
  return min + Math.floor(rng() * (max - min + 1));
}

/** 为整桌生成估值：各自独立取值，但保证「不是所有人都一样」（否则本轮必然无差别，观赏价值为零） */
function rollEstimates(seats: SeatId[], rng: Rng): Map<SeatId, number> {
  const m = new Map<SeatId, number>();
  for (const t of seats) m.set(t, rollEstimate(rng));
  if (seats.length > 1 && new Set(m.values()).size === 1) {
    // 撞成全部相同：给最后一席挪一格（仍在区间内），避免整桌同值
    const last = seats[seats.length - 1]!;
    const v = m.get(last)!;
    m.set(last, v === ESTIMATE_RANGE.max ? v - 1 : v + 1);
  }
  return m;
}

export function createAuction(config: { lots?: number } = {}): GameModule<State> {
  const totalRounds = Math.max(1, Math.min(12, config.lots ?? LOT_COUNT));

  const game: GameModule<State> = {
    meta: { id: "auction", name: "拍卖行·密封竞价", minSeats: 2, maxSeats: 6, defaultTimeoutMs: 30_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length < 2 || seats.length > 6) throw new Error("auction 需要 2–6 席");
      const estimate = rollEstimates(seats, rng);
      const initState: State = {
        seats: [...seats],
        round: 1,
        totalRounds,
        phase: "bidding",
        lot: LOT_NAMES[0]!,
        estimate,
        pending: new Map(),
        balance: new Map(seats.map((t) => [t, START_BALANCE])),
        net: new Map(seats.map((t) => [t, 0])),
        history: [],
        initEvents: [
          {
            type: "round_started",
            data: { round: 1, total_rounds: totalRounds, lot: LOT_NAMES[0]! },
          },
        ],
      };
      return initState;
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
      return s.phase === "bidding" ? s.seats.filter((t) => !s.pending.has(t)) : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "bidding" || !s.seats.includes(seat) || s.pending.has(seat)) return [];
      const cap = s.balance.get(seat) ?? 0;
      // 出价上限按席位余额算——每席法表不同，不能复用同一份
      return [
        {
          type: "bid",
          schema: { amount: `int 0-${cap}` },
          hint: `出价 0–${cap}（不得超过余额）。最高价得标并支付自己的出价；估值只有你自己看得见`,
        },
        { type: "pass", hint: "放弃本件（等价出价 0）" },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.pending.has(seat)) return { ok: false, error: "DUPLICATE_ACTION：本件已出价" };
      const cap = s.balance.get(seat) ?? 0;
      if (action.type === "pass") return { ok: true };
      if (action.type !== "bid") return { ok: false, error: "ILLEGAL_ACTION：仅可 bid 或 pass" };
      const amount = action.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount)) {
        return { ok: false, error: "ILLEGAL_ACTION：amount 须为整数" };
      }
      if (amount < 0) return { ok: false, error: "ILLEGAL_ACTION：amount 不得为负" };
      if (amount > cap) return { ok: false, error: `ILLEGAL_ACTION：amount 超过余额（${cap}）` };
      return { ok: true };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      if (s.phase !== "bidding") return { state: s, events };
      const amount = action.type === "pass" ? 0 : (action.amount as number);
      s.pending.set(seat, amount);
      if (s.pending.size < s.seats.length) return { state: s, events }; // 未收齐

      // —— 收齐结算：同时揭晓 ——
      const bids = Object.fromEntries([...s.pending.entries()].map(([k, v]) => [String(k), v]));
      const top = Math.max(...s.pending.values());
      let winner: SeatId | null = null;
      if (top > 0) {
        // 平局按座位号小者优先（确定性；同时提交下必须有明确规则，不能靠提交先后）
        const tied = [...s.pending.entries()].filter(([, v]) => v === top).map(([k]) => k).sort((a, b) => a - b);
        winner = tied[0]!;
      }
      const price = winner === null ? 0 : top;
      if (winner !== null) {
        s.balance.set(winner, (s.balance.get(winner) ?? 0) - price);
        const gain = (s.estimate.get(winner) ?? 0) - price;
        s.net.set(winner, (s.net.get(winner) ?? 0) + gain);
      }
      const netSnap = Object.fromEntries([...s.net.entries()].map(([k, v]) => [String(k), v]));
      const balSnap = Object.fromEntries([...s.balance.entries()].map(([k, v]) => [String(k), v]));
      // 估值随结算一起公开（本轮已结束，不再有利用价值，但让观众看懂「他为什么出这个价」）
      const estSnap = Object.fromEntries([...s.estimate.entries()].map(([k, v]) => [String(k), v]));
      const record: LotRecord = { round: s.round, lot: s.lot, bids, estimates: estSnap, winner, price, net: netSnap, balance: balSnap };
      s.history.push(record);
      s.pending = new Map();
      events.push({
        type: "round_resolved",
        data: {
          round: s.round,
          lot: s.lot,
          is_final: s.round >= s.totalRounds,
          bids,
          estimates: estSnap,
          winner,
          price,
          sold: winner !== null,
          net: netSnap,
          balance: balSnap,
        },
      });

      if (s.round >= s.totalRounds) {
        s.phase = "finished";
        const best = Math.max(...s.seats.map((t) => s.net.get(t) ?? 0));
        const champs = s.seats.filter((t) => (s.net.get(t) ?? 0) === best);
        // 都亏钱或无盈利时无胜者（避免「大家一起亏，亏得少的最赚」这种荒谬结论）
        const winnerSeat = best > 0 ? (champs.length === 1 ? champs[0]! : "draw") : "draw";
        events.push({
          type: "game_won",
          data: {
            winner: winnerSeat,
            net: netSnap,
            balance: balSnap,
            reason: best > 0 ? "累计净收益最高" : "无人盈利（全桌净收益 ≤ 0）",
          },
        });
        return { state: s, events };
      }

      s.round += 1;
      s.lot = LOT_NAMES[(s.round - 1) % LOT_NAMES.length]!;
      s.estimate = rollEstimates(s.seats, rng);
      events.push({
        type: "round_started",
        data: { round: s.round, total_rounds: s.totalRounds, lot: s.lot },
      });
      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const net = Object.fromEntries([...s.net.entries()].map(([k, v]) => [String(k), v]));
      const balance = Object.fromEntries([...s.balance.entries()].map(([k, v]) => [String(k), v]));
      const pub: Record<string, unknown> = {
        round: s.round,
        total_rounds: s.totalRounds,
        phase: s.phase,
        lot: s.lot,
        seats: s.seats,
        net,
        balance,
        history: s.history,
        estimate_range: { ...ESTIMATE_RANGE },
        // 结算前只公开「谁已出价」，不公开金额（金额公开 = 后手可看价改价，同时相位即失效）
        submitted_seats: s.phase === "bidding" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return {
        public: pub,
        private: {
          my_estimate: s.phase === "bidding" ? (s.estimate.get(viewer) ?? null) : null,
          my_bid_this_round: s.pending.get(viewer) ?? null,
          my_net: s.net.get(viewer) ?? 0,
          my_balance: s.balance.get(viewer) ?? 0,
        },
      };
    },

    timeoutAction() {
      // 超时 = 放弃本件（等价出价 0）：沉默即不出钱，确定性兜底，绝不随机
      return { type: "pass" };
    },

    actionVisibility(s, seat) {
      // bidding 相位：acted 仅本人可见——对手不得据此推断出价
      if (s.phase === "bidding" && s.seats.includes(seat)) return { seats: [seat] };
      return "all";
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      const best = Math.max(...s.seats.map((t) => s.net.get(t) ?? 0));
      for (const t of s.seats) {
        out[t] = best > 0 && (s.net.get(t) ?? 0) === best ? 1 : 0;
      }
      return out;
    },

    /** 无出局机制：资金归零只是不能再出价，仍可观察与提交 0 出价 */
    seatAlive() {
      return true;
    },

    /** 名次按累计净收益降序（同分并列，note 带净收益与余额） */
    placements(s) {
      const rows = s.seats.map((seat) => ({ seat, net: s.net.get(seat) ?? 0, bal: s.balance.get(seat) ?? 0 }));
      rows.sort((a, b) => b.net - a.net || a.seat - b.seat);
      let rank = 0;
      let prev: number | null = null;
      return rows.map((r, i) => {
        if (prev === null || r.net !== prev) rank = i + 1;
        prev = r.net;
        return { seat: r.seat, rank, note: `net=${r.net} · balance=${r.bal}` };
      });
    },
  };

  return game;
}
