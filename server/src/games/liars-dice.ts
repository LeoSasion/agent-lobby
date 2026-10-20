/**
 * 吹牛骰（Liar's Dice）—— MVP 旗舰演示游戏
 * 规则：每人 5 骰；轮流叫价（qty 个 face）或质疑；质疑后全场计数，
 * 叫价不实则叫价方输一骰，属实则质疑方输一骰；输家开下一轮并重掷；仅剩一人有骰则胜。
 * 配置：wildcardOnes=true 时 1 为百搭（不可叫、计数时算任意面），默认关。
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

interface Player {
  seat: SeatId;
  dice: number[];
}

interface State {
  players: Player[];
  bid: { seat: SeatId; qty: number; face: number } | null;
  turn: number; // players 数组下标
  round: number; // 1 起
  finished: boolean;
  winner: SeatId | null;
  /** r29：出局回合（座位 → 轮次）。终局名次需要，旧回放/旧存档可能没有此字段——读取处必须兜底 */
  eliminatedAt?: Map<SeatId, number>;
}

export interface LiarDiceConfig {
  wildcardOnes?: boolean;
  dicePerPlayer?: number;
}

function rollDice(n: number, rng: Rng): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(1 + Math.floor(rng() * 6));
  return out;
}

function bidHigher(qty: number, face: number, cur: { qty: number; face: number }): boolean {
  return qty > cur.qty || (qty === cur.qty && face > cur.face);
}

function nextAliveIdx(s: State, from: number): number {
  let i = from;
  do {
    i = (i + 1) % s.players.length;
  } while (s.players[i].dice.length === 0);
  return i;
}

export function createLiarsDice(config: LiarDiceConfig = {}): GameModule<State> {
  const wildcard = config.wildcardOnes ?? false;
  const perPlayer = config.dicePerPlayer ?? 5;
  const minFace = wildcard ? 2 : 1;

  const game: GameModule<State> = {
    meta: {
      id: "liars_dice",
      name: "吹牛骰",
      minSeats: 2,
      maxSeats: 6,
      defaultTimeoutMs: 45_000,
    },

    init(seats: SeatId[], rng: Rng): State {
      const players = seats.map((seat) => ({ seat, dice: rollDice(perPlayer, rng) }));
      return { players, bid: null, turn: 0, round: 1, finished: false, winner: null, eliminatedAt: new Map() };
    },

    phase(s) {
      return s.finished ? "finished" : "bid";
    },

    round(s) {
      return s.round;
    },

    activeSeats(s) {
      if (s.finished) return [];
      return [s.players[s.turn].seat];
    },

    legalActions(s, seat) {
      if (s.finished || s.players[s.turn].seat !== seat) return [];
      const acts: LegalAction[] = [
        {
          type: "bid",
          schema: { qty: "int 1-30", face: `int ${minFace}-6`, rule: "须严格大于当前叫价" },
        },
      ];
      if (s.bid) acts.push({ type: "challenge", hint: "质疑当前叫价" });
      return acts;
    },

    validate(s, seat, action) {
      if (s.finished) return { ok: false, error: "MATCH_FINISHED" };
      if (s.players[s.turn].seat !== seat) return { ok: false, error: "NOT_YOUR_TURN" };
      if (action.type === "challenge") {
        if (!s.bid) return { ok: false, error: "ILLEGAL_ACTION：尚无叫价可质疑" };
        return { ok: true };
      }
      if (action.type === "bid") {
        const qty = action.qty;
        const face = action.face;
        if (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > 30) {
          return { ok: false, error: "ILLEGAL_ACTION：qty 须为 1-30 的整数" };
        }
        if (!Number.isInteger(face) || (face as number) < minFace || (face as number) > 6) {
          return { ok: false, error: `ILLEGAL_ACTION：face 须为 ${minFace}-6 的整数` };
        }
        if (s.bid && !bidHigher(qty as number, face as number, s.bid)) {
          return { ok: false, error: "ILLEGAL_ACTION：叫价必须严格大于当前叫价" };
        }
        return { ok: true };
      }
      // r9 w9-d1：缺 action 字段/type 拼错时报「未知动作类型 undefined」不友好——指引排查方向
      return { ok: false, error: `ILLEGAL_ACTION：未知动作类型「${String(action.type)}」——须为 legal_actions 列出的 type 之一（缺 action 字段或 type 拼写错误都会走到这里）` };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];

      if (action.type === "bid") {
        const qty = action.qty as number;
        const face = action.face as number;
        s.bid = { seat, qty, face };
        s.turn = nextAliveIdx(s, s.turn);
        events.push({ type: "bid_placed", data: { seat, qty, face } });
        return { state: s, events };
      }

      // challenge（validate 已保证 s.bid 存在）
      const bid = s.bid!;
      let count = 0;
      for (const p of s.players) {
        for (const d of p.dice) {
          if (d === bid.face || (wildcard && d === 1)) count++;
        }
      }
      const bidWasTrue = count >= bid.qty;
      const loserIdx = s.players.findIndex((p) => p.seat === (bidWasTrue ? seat : bid.seat));
      const loser = s.players[loserIdx];
      loser.dice.pop();
      events.push({
        type: "challenge_resolved",
        data: {
          challenger: seat,
          challenged_bid: bid,
          actual_count: count,
          bid_was_true: bidWasTrue,
          loser: loser.seat,
          loser_dice_left: loser.dice.length,
        },
      });

      const alive = s.players.filter((p) => p.dice.length > 0);
      if (alive.length <= 1) {
        if (loser.dice.length === 0) {
          (s.eliminatedAt ??= new Map()).set(loser.seat, s.round);
          events.push({ type: "player_eliminated", data: { seat: loser.seat } });
        }
        s.finished = true;
        s.winner = alive[0]?.seat ?? null;
        s.bid = null;
        return { state: s, events };
      }

      if (loser.dice.length === 0) {
        (s.eliminatedAt ??= new Map()).set(loser.seat, s.round);
        events.push({ type: "player_eliminated", data: { seat: loser.seat } });
      }
      s.round += 1;
      for (const p of s.players) {
        if (p.dice.length > 0) p.dice = rollDice(p.dice.length, rng);
      }
      s.bid = null;
      s.turn = loser.dice.length > 0 ? loserIdx : nextAliveIdx(s, loserIdx);
      events.push({ type: "round_started", data: { round: s.round } });
      return { state: s, events };
    },

    viewOf(s, viewer) {
      const pub: Record<string, unknown> = {
        round: s.round,
        players: s.players.map((p) => ({ seat: p.seat, dice_count: p.dice.length })),
        current_bid: s.bid,
        turn: s.finished ? null : s.players[s.turn]?.seat ?? null,
        wildcard_ones: wildcard,
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      const me = s.players.find((p) => p.seat === viewer);
      return { public: pub, private: me ? { my_dice: [...me.dice] } : {} };
    },

    timeoutAction(s) {
      // 协议约定：有叫价则质疑，否则最低合法叫价
      if (s.bid) return { type: "challenge" };
      return { type: "bid", qty: 1, face: minFace };
    },

    isTerminal(s) {
      return s.finished;
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const p of s.players) out[p.seat] = s.finished && p.seat === s.winner ? 1 : 0;
      return out;
    },

    seatAlive(s, seat) {
      return (s.players.find((p) => p.seat === seat)?.dice.length ?? 0) > 0;
    },

    /**
     * r29：终局全序名次——只按 scores 排会让「第 2 名」与「第 6 名」数据等价。
     * 排序依据：剩余骰数降序 → 出局轮次降序（越晚出局名次越高）→ 座位号升序。
     */
    placements(s) {
      const elim = s.eliminatedAt ?? new Map<SeatId, number>();
      const rows = s.players.map((p) => ({
        seat: p.seat,
        dice: p.dice.length,
        elimRound: elim.get(p.seat) ?? null,
      }));
      rows.sort((a, b) => {
        if (b.dice !== a.dice) return b.dice - a.dice;
        const ea = a.elimRound ?? -1;
        const eb = b.elimRound ?? -1;
        if (eb !== ea) return eb - ea;
        return a.seat - b.seat;
      });
      let rank = 0;
      let prevKey = "";
      return rows.map((r, i) => {
        const key = `${r.dice}|${r.elimRound}`;
        if (key !== prevKey) rank = i + 1;
        prevKey = key;
        return {
          seat: r.seat,
          rank,
          note: r.elimRound === null ? `dice=${r.dice}` : `dice=${r.dice},eliminated_round=${r.elimRound}`,
        };
      });
    },
  };

  return game;
}
