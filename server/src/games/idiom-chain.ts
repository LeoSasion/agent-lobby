/**
 * 成语接龙（idiom_chain）—— 中文文字游戏 · 淘汰制 · 第十三款（r38）
 *
 * 2-6 席，顺序轮转：每人必须接一个「首字 = 上一个成语尾字」的成语，**严格同字**。
 * 接不上（或超时）即出局，最后存活者胜。
 *
 * 判定完全封闭：只认 `idiom-data.ts` 词库里的成语、且不能重复使用。
 * 这是刻意的取舍——开放词库就得「由对手裁定是否算成语」，那是主观判定，
 * 与「零 LLM 依赖 + 确定性回放」冲突（辩论房正因此暂缓）。
 *
 * 公平提示：视图公开 `remaining`（以当前尾字开头的**未使用**成语还剩几条）。
 * 只给数量不给答案——让「被逼死」是可预见的，而不是撞墙。
 *
 * 词库现状：508 条 / 202 个首字。仍有约四成尾字无后继（走进去就是死路），
 * 这不是缺陷：**逼对手走到死路正是这款游戏的胜负手段**。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";
import { IDIOMS, IDIOM_SET, BY_FIRST, headOf, tailOf, countByFirst } from "./idiom-data.ts";
import { nextAliveAfter } from "./shared.ts";

interface State {
  seats: SeatId[];
  chain: { seat: SeatId; idiom: string }[];
  used: Set<string>;
  turnSeat: SeatId;
  eliminated: SeatId[];
  /** 当前要接的首字 */
  current: string;
  phase: "playing" | "finished";
  winner: SeatId | null;
  initEvents: GameEvent[];
}

/** 起始成语：尾字至少有 2 个后继，保证开局不会一步就死 */
function pickStart(rng: Rng): string {
  const pool = IDIOMS.filter((w) => countByFirst(tailOf(w)) >= 2);
  return pool[Math.floor(rng() * pool.length)] ?? IDIOMS[0]!;
}

export function createIdiomChain(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "idiom_chain", name: "成语接龙", minSeats: 2, maxSeats: 6, defaultTimeoutMs: 45_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length < 2 || seats.length > 6) throw new Error("idiom_chain 需要 2–6 席");
      const start = pickStart(rng);
      const s: State = {
        seats: [...seats],
        chain: [{ seat: seats[0]!, idiom: start }],
        used: new Set([start]),
        turnSeat: seats[1] ?? seats[0]!,
        eliminated: [],
        current: tailOf(start),
        phase: "playing",
        winner: null,
        initEvents: [
          {
            type: "chain_started",
            data: {
              seats: [...seats],
              start,
              start_by: seats[0],
              current: tailOf(start),
              remaining: countRemaining(tailOf(start), new Set([start])),
            },
          },
        ],
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
      return s.chain.length;
    },

    activeSeats(s) {
      return s.phase === "playing" ? [s.turnSeat] : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || s.turnSeat !== seat) return [];
      const left = countRemaining(s.current, s.used);
      return [
        {
          type: "say",
          schema: { idiom: "string 2-8", rule: `必须是词库里的成语、未被用过、且以「${s.current}」开头` },
          hint: `接一个以「${s.current}」开头的成语（词库里还剩 ${left} 条可用）；接不上就 pass 认输`,
        },
        { type: "pass", hint: "认输（本局出局）" },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.eliminated.includes(seat)) return { ok: false, error: "ILLEGAL_ACTION：已出局" };
      if (s.turnSeat !== seat) return { ok: false, error: "NOT_YOUR_TURN：还没轮到你" };
      if (action.type === "pass") return { ok: true };
      if (action.type !== "say") return { ok: false, error: "ILLEGAL_ACTION：仅可 say 或 pass" };
      const w = action.idiom;
      if (typeof w !== "string" || w.length < 2 || w.length > 8) {
        return { ok: false, error: "ILLEGAL_ACTION：idiom 须为 2-8 个字符" };
      }
      if (!IDIOM_SET.has(w)) return { ok: false, error: `ILLEGAL_ACTION：「${w}」不在词库中` };
      if (s.used.has(w)) return { ok: false, error: `ILLEGAL_ACTION：「${w}」已经用过` };
      if (headOf(w) !== s.current) {
        return { ok: false, error: `ILLEGAL_ACTION：必须以「${s.current}」开头（你给的是「${headOf(w)}」）` };
      }
      return { ok: true };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };

      if (action.type === "pass") {
        s.eliminated.push(seat);
        events.push({ type: "dropped", data: { seat, current: s.current, reason: "接不上，认输" } });
        return advance(s, events, seat);
      }

      const w = String(action.idiom);
      s.chain.push({ seat, idiom: w });
      s.used.add(w);
      s.current = tailOf(w);
      events.push({
        type: "linked",
        data: { seat, idiom: w, current: s.current, length: s.chain.length, remaining: countRemaining(s.current, s.used) },
      });
      return advance(s, events, seat);
    },

    viewOf(s, viewer: Viewer, ctx) {
      const alive = s.seats.filter((t) => !s.eliminated.includes(t));
      const pub: Record<string, unknown> = {
        phase: s.phase,
        chain: s.chain,
        current: s.current,
        turn: s.phase === "playing" ? s.turnSeat : null,
        alive_seats: alive,
        eliminated: s.eliminated,
        /** 以当前尾字开头的**未使用**成语还剩几条（只给数量，不给答案） */
        remaining: s.phase === "playing" ? countRemaining(s.current, s.used) : 0,
        used_count: s.used.size,
        library_size: IDIOMS.length,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((a, b) => a - b) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return { public: pub, private: { my_turn: s.turnSeat === viewer, eliminated: s.eliminated.includes(viewer) } };
    },

    timeoutAction() {
      // 超时 = 认输出局（确定性；不能替玩家随便接一个，那是替他做决策）
      return { type: "pass" };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) out[t] = s.winner === null ? 0 : t === s.winner ? 1 : 0;
      return out;
    },

    seatAlive(s, seat) {
      return !s.eliminated.includes(seat);
    },

    placements(s) {
      // 出局越晚名次越好：最后存活者 rank 1，倒数第二个出局 rank 2，以此类推
      if (s.winner === null) return s.seats.map((seat) => ({ seat, rank: 1 }));
      const order = [...s.eliminated].reverse(); // 最后出局的排最前
      const rest = order.filter((t) => t !== s.winner);
      return [
        { seat: s.winner, rank: 1, note: `接龙 ${s.chain.length} 环` },
        ...rest.map((seat, i) => ({ seat, rank: i + 2 })),
      ];
    },
  };

  return game;
}

/** 以 ch 开头、且未被用过的成语还剩几条 */
function countRemaining(ch: string, used: Set<string>): number {
  const list = BY_FIRST.get(ch);
  if (!list) return 0;
  let n = 0;
  for (const w of list) if (!used.has(w)) n++;
  return n;
}

/** 轮转到下一个存活者；只剩一人则终局 */
function advance(s: State, events: GameEvent[], justActed: SeatId): { state: State; events: GameEvent[] } {
  const alive = s.seats.filter((t) => !s.eliminated.includes(t));
  if (alive.length <= 1) {
    s.phase = "finished";
    s.winner = alive[0] ?? null;
    events.push({
      type: "game_won",
      data: {
        winner: s.winner,
        chain_length: s.chain.length,
        eliminated: s.eliminated,
        reason: s.winner === null ? "全员出局" : `${s.winner} 号是最后幸存者`,
      },
    });
    return { state: s, events };
  }
  // 从 justActed 之后找下一个存活者
  const nxt = nextAliveAfter(s.seats, s.eliminated, justActed);
  if (nxt !== null) s.turnSeat = nxt;
  return { state: s, events };
}
