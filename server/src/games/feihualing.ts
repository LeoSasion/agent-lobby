/**
 * 飞花令（feihualing）—— 诗词接令 · 淘汰制 · 第十四款（r38）
 *
 * 2-6 席，顺序轮转：每人说一句**含令字**的诗句，不能重复。接不上（或超时）即出局，
 * 最后存活者胜。令字从「诗句够多」的字里随机选（春/月/花/风/山/水/云/雪/夜/江）。
 *
 * 与成语接龙是同一个骨架（封闭词库 + 顺序轮转 + 淘汰），区别只在匹配维度：
 * 接龙看**首字/尾字**的串接，飞花令看**是否含某字**。
 * 两者合起来把「中文文字游戏」这一格补满了：一个考联想链，一个考检索面。
 *
 * 公平提示：公开 `remaining`（含令字且未用过的句子还剩几条），只给数量不给句子。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";
import { POEMS, RHYME_CHARS, countAvailable } from "./feihualing-data.ts";

const POEM_SET = new Set(POEMS);

interface State {
  seats: SeatId[];
  /** 令字 */
  rhyme: string;
  said: { seat: SeatId; line: string }[];
  used: Set<string>;
  turnSeat: SeatId;
  eliminated: SeatId[];
  phase: "playing" | "finished";
  winner: SeatId | null;
  initEvents: GameEvent[];
}

export function createFeihualing(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "feihualing", name: "飞花令", minSeats: 2, maxSeats: 6, defaultTimeoutMs: 50_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length < 2 || seats.length > 6) throw new Error("feihualing 需要 2–6 席");
      const rhyme = RHYME_CHARS[Math.floor(rng() * RHYME_CHARS.length)] ?? "春";
      const s: State = {
        seats: [...seats],
        rhyme,
        said: [],
        used: new Set(),
        turnSeat: seats[0]!,
        eliminated: [],
        phase: "playing",
        winner: null,
        initEvents: [
          {
            type: "rhyme_chosen",
            data: {
              rhyme,
              seats: [...seats],
              poetry_size: POEMS.length,
              remaining: countAvailable(rhyme, new Set()),
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
      return s.said.length + 1;
    },

    activeSeats(s) {
      return s.phase === "playing" ? [s.turnSeat] : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || s.turnSeat !== seat) return [];
      return [
        {
          type: "say",
          schema: { line: "string 4-40", rule: `必须是诗库中的句子、未被用过、且含令字「${s.rhyme}」` },
          hint: `说一句含「${s.rhyme}」的诗（库里还剩 ${countAvailable(s.rhyme, s.used)} 句可用）；接不上就 pass`,
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
      const line = action.line;
      if (typeof line !== "string" || line.length < 4 || line.length > 40) {
        return { ok: false, error: "ILLEGAL_ACTION：line 须为 4-40 个字符" };
      }
      if (!POEM_SET.has(line)) return { ok: false, error: `ILLEGAL_ACTION：「${line}」不在诗库中` };
      if (s.used.has(line)) return { ok: false, error: `ILLEGAL_ACTION：「${line}」已经念过` };
      if (!line.includes(s.rhyme)) return { ok: false, error: `ILLEGAL_ACTION：这句里没有令字「${s.rhyme}」` };
      return { ok: true };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };

      if (action.type === "pass") {
        s.eliminated.push(seat);
        events.push({ type: "dropped", data: { seat, rhyme: s.rhyme, reason: "接不上，认输" } });
        return advance(s, events, seat);
      }

      const line = String(action.line);
      s.said.push({ seat, line });
      s.used.add(line);
      events.push({
        type: "recited",
        data: { seat, line, count: s.said.length, remaining: countAvailable(s.rhyme, s.used) },
      });
      return advance(s, events, seat);
    },

    viewOf(s, viewer: Viewer, ctx) {
      const alive = s.seats.filter((t) => !s.eliminated.includes(t));
      const pub: Record<string, unknown> = {
        phase: s.phase,
        rhyme: s.rhyme,
        said: s.said,
        turn: s.phase === "playing" ? s.turnSeat : null,
        alive_seats: alive,
        eliminated: s.eliminated,
        remaining: s.phase === "playing" ? countAvailable(s.rhyme, s.used) : 0,
        used_count: s.used.size,
        poetry_size: POEMS.length,
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((a, b) => a - b) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return { public: pub, private: { my_turn: s.turnSeat === viewer, eliminated: s.eliminated.includes(viewer) } };
    },

    timeoutAction() {
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
      if (s.winner === null) return s.seats.map((seat) => ({ seat, rank: 1 }));
      const rest = [...s.eliminated].reverse().filter((t) => t !== s.winner);
      return [
        { seat: s.winner, rank: 1, note: `共念 ${s.said.length} 句` },
        ...rest.map((seat, i) => ({ seat, rank: i + 2 })),
      ];
    },
  };

  return game;
}

function advance(s: State, events: GameEvent[], justActed: SeatId): { state: State; events: GameEvent[] } {
  const alive = s.seats.filter((t) => !s.eliminated.includes(t));
  if (alive.length <= 1) {
    s.phase = "finished";
    s.winner = alive[0] ?? null;
    events.push({
      type: "game_won",
      data: {
        winner: s.winner,
        rhyme: s.rhyme,
        lines: s.said.length,
        eliminated: s.eliminated,
        reason: s.winner === null ? "全员出局" : `${s.winner} 号是最后幸存者`,
      },
    });
    return { state: s, events };
  }
  const i = s.seats.indexOf(justActed);
  for (let k = 1; k <= s.seats.length; k++) {
    const t = s.seats[(i + k) % s.seats.length]!;
    if (!s.eliminated.includes(t)) {
      s.turnSeat = t;
      break;
    }
  }
  return { state: s, events };
}
