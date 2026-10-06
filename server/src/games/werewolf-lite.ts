/**
 * 狼人杀·简化版（werewolf_lite）—— 平台灵魂游戏
 * 6 席：2 狼 / 3 民 / 1 预言家
 * 阶段循环：night（同时相位：狼刀 + 验人）→ day_discuss（顺序发言）
 *   → day_vote（同时相位：投票放逐，平票 seed 随机）→ 下一夜
 * 信息隔离：角色/队友/验人结果仅入 private；狼刀决策事件仅狼可见；
 *   死亡席位保留自身角色视角但不再行动；终局 game_won 公开全部身份
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export type Role = "werewolf" | "seer" | "villager";

interface NightAction {
  type: "kill" | "check" | "pass";
  target?: SeatId;
}

interface State {
  seats: SeatId[];
  roles: Map<SeatId, Role>;
  alive: Map<SeatId, boolean>;
  round: number;
  phase: "night" | "day_discuss" | "day_vote" | "finished";
  nightActions: Map<SeatId, NightAction>;
  sayQueue: SeatId[];
  sayIndex: number;
  todaySays: { seat: SeatId; text: string }[];
  votes: Map<SeatId, SeatId | null>;
  seerChecks: { target: SeatId; is_wolf: boolean }[];
  winner: "good" | "wolves" | null;
}

function aliveSeats(s: State): SeatId[] {
  return s.seats.filter((t) => s.alive.get(t) === true);
}

function wolfSeats(s: State): SeatId[] {
  return s.seats.filter((t) => s.roles.get(t) === "werewolf");
}

/** 夜间行动者：存活狼 + 存活预言家（村民休眠） */
function nightActors(s: State): SeatId[] {
  return s.seats.filter((t) => {
    if (s.alive.get(t) !== true) return false;
    const r = s.roles.get(t);
    return r === "werewolf" || r === "seer";
  });
}

function checkWin(s: State, events: GameEvent[]): boolean {
  const wolves = aliveSeats(s).filter((t) => s.roles.get(t) === "werewolf").length;
  const others = aliveSeats(s).length - wolves;
  if (wolves === 0) {
    s.phase = "finished";
    s.winner = "good";
  } else if (wolves >= others) {
    s.phase = "finished";
    s.winner = "wolves";
  }
  if (s.winner) {
    events.push({
      type: "game_won",
      data: { winner: s.winner, roles: Object.fromEntries([...s.roles.entries()]) },
    });
    return true;
  }
  return false;
}

function tryResolveNight(s: State, events: GameEvent[], rng: Rng): void {
  for (const seat of nightActors(s)) {
    if (!s.nightActions.has(seat)) return; // 还没收齐，等下一个 apply
  }

  // 狼刀：狼队以最后提交（座位序最高）的 kill 为准
  const wolves = wolfSeats(s);
  let target: SeatId | null = null;
  for (const w of wolves) {
    const a = s.nightActions.get(w);
    if (a && a.type === "kill" && a.target !== undefined) target = a.target;
  }
  events.push({ type: "night_kill_decided", data: { target }, visibility: { seats: wolves } });
  if (target !== null) {
    s.alive.set(target, false);
    events.push({ type: "player_died", data: { seat: target, cause: "night" } });
  }

  // 预言家验人（当夜被刀也照样出结果：先行动后结算）
  const seer = s.seats.find((t) => s.roles.get(t) === "seer");
  if (seer !== undefined) {
    const a = s.nightActions.get(seer);
    if (a && a.type === "check" && a.target !== undefined) {
      const isWolf = s.roles.get(a.target) === "werewolf";
      s.seerChecks.push({ target: a.target, is_wolf: isWolf });
      events.push({
        type: "checked",
        data: { target: a.target, is_wolf: isWolf },
        visibility: { seats: [seer] },
      });
    }
  }
  s.nightActions = new Map();

  if (checkWin(s, events)) return;
  s.phase = "day_discuss";
  s.sayQueue = aliveSeats(s);
  s.sayIndex = 0;
  s.todaySays = [];
  void rng;
}

function tryResolveVote(s: State, events: GameEvent[], rng: Rng): void {
  for (const seat of aliveSeats(s)) {
    if (!s.votes.has(seat)) return;
  }
  const tally = new Map<SeatId, number>();
  for (const t of s.votes.values()) {
    if (t !== null) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  let max = 0;
  let tied: SeatId[] = [];
  for (const [t, n] of tally) {
    if (n > max) {
      max = n;
      tied = [t];
    } else if (n === max) {
      tied.push(t);
    }
  }
  let exiled: SeatId | null = null;
  if (max > 0) {
    exiled = tied.length === 1 ? tied[0] : tied[Math.floor(rng() * tied.length)];
  }
  events.push({ type: "vote_result", data: { tally: Object.fromEntries([...tally.entries()]), exiled } });
  if (exiled !== null) {
    s.alive.set(exiled, false);
    events.push({ type: "player_died", data: { seat: exiled, cause: "vote" } });
  }
  if (checkWin(s, events)) return;
  s.round += 1;
  s.phase = "night";
  s.nightActions = new Map();
}

export function createWerewolfLite(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "werewolf_lite", name: "狼人杀·简化", minSeats: 6, maxSeats: 6, defaultTimeoutMs: 90_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 6) throw new Error("werewolf_lite 需要 6 席");
      const order = [...seats];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const roles = new Map<SeatId, Role>();
      order.forEach((seat, i) => {
        roles.set(seat, i < 2 ? "werewolf" : i === 2 ? "seer" : "villager");
      });
      return {
        seats: [...seats],
        roles,
        alive: new Map(seats.map((t) => [t, true])),
        round: 1,
        phase: "night",
        nightActions: new Map(),
        sayQueue: [],
        sayIndex: 0,
        todaySays: [],
        votes: new Map(),
        seerChecks: [],
        winner: null,
      };
    },

    phase(s) {
      return s.phase;
    },

    round(s) {
      return s.round;
    },

    activeSeats(s) {
      if (s.phase === "finished") return [];
      if (s.phase === "night") return nightActors(s);
      if (s.phase === "day_discuss") return [s.sayQueue[s.sayIndex]];
      return aliveSeats(s); // day_vote
    },

    legalActions(s, seat) {
      if (s.phase === "finished") return [];
      const alive = (t: SeatId) => s.alive.get(t) === true;
      const role = s.roles.get(seat);

      if (s.phase === "night") {
        if (alive(seat) !== true || (role !== "werewolf" && role !== "seer")) return [];
        if (role === "werewolf") {
          const targets = aliveSeats(s).filter((t) => s.roles.get(t) !== "werewolf");
          if (targets.length === 0) return [{ type: "pass", hint: "无刀可出" }];
          return [
            { type: "kill", schema: { target: "enum", values: targets } },
            { type: "pass", hint: "空刀" },
          ];
        }
        return [
          { type: "check", schema: { target: "enum", values: aliveSeats(s).filter((t) => t !== seat) } },
          { type: "pass", hint: "不验" },
        ];
      }

      if (s.phase === "day_discuss") {
        return s.sayQueue[s.sayIndex] === seat
          ? [{ type: "say", schema: { text: "string 1-500" }, hint: "公开发言" }]
          : [];
      }

      if (alive(seat) !== true) return [];
      return [
        { type: "vote", schema: { target: "enum", values: aliveSeats(s) } },
        { type: "pass", hint: "弃票" },
      ];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      const alive = (t: SeatId) => s.alive.get(t) === true;
      const role = s.roles.get(seat);

      if (s.phase === "night") {
        if (alive(seat) !== true || (role !== "werewolf" && role !== "seer")) {
          return { ok: false, error: "NOT_YOUR_TURN：夜间休眠" };
        }
        if (action.type === "pass") return { ok: true };
        if (role === "werewolf" && action.type === "kill") {
          const t = action.target as SeatId;
          if (!alive(t) || s.roles.get(t) === "werewolf") {
            return { ok: false, error: "ILLEGAL_ACTION：刀口须为存活的非狼" };
          }
          return { ok: true };
        }
        if (role === "seer" && action.type === "check") {
          const t = action.target as SeatId;
          if (!alive(t) || t === seat) {
            return { ok: false, error: "ILLEGAL_ACTION：验人须为其他存活者" };
          }
          return { ok: true };
        }
        return { ok: false, error: "ILLEGAL_ACTION：角色与动作不符" };
      }

      if (s.phase === "day_discuss") {
        if (s.sayQueue[s.sayIndex] !== seat) return { ok: false, error: "NOT_YOUR_TURN：未到你发言" };
        if (action.type === "say") {
          const text = action.text;
          if (typeof text !== "string" || text.length < 1 || text.length > 500) {
            return { ok: false, error: "ILLEGAL_ACTION：text 须为 1-500 字符" };
          }
          return { ok: true };
        }
        return { ok: false, error: "ILLEGAL_ACTION：发言阶段仅可 say" };
      }

      if (alive(seat) !== true) return { ok: false, error: "NOT_YOUR_TURN：已出局" };
      if (action.type === "pass") return { ok: true };
      if (action.type === "vote") {
        const t = action.target as SeatId;
        if (!alive(t)) return { ok: false, error: "ILLEGAL_ACTION：投票对象须存活" };
        return { ok: true };
      }
      return { ok: false, error: "ILLEGAL_ACTION：投票阶段仅可 vote/pass" };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      if (s.phase === "night") {
        s.nightActions.set(seat, {
          type: action.type === "kill" || action.type === "check" ? (action.type as "kill" | "check") : "pass",
          target: action.target as SeatId | undefined,
        });
        tryResolveNight(s, events, rng);
      } else if (s.phase === "day_discuss") {
        const text = String(action.text ?? "");
        s.todaySays.push({ seat, text });
        events.push({ type: "said", data: { seat, text } });
        s.sayIndex += 1;
        if (s.sayIndex >= s.sayQueue.length) {
          s.phase = "day_vote";
          s.votes = new Map();
        }
      } else if (s.phase === "day_vote") {
        s.votes.set(seat, action.type === "vote" ? (action.target as SeatId) : null);
        tryResolveVote(s, events, rng);
      }
      return { state: s, events };
    },

    viewOf(s, viewer) {
      const pub: Record<string, unknown> = {
        round: s.round,
        phase: s.phase,
        seats: s.seats,
        alive_seats: aliveSeats(s),
        today_says: s.todaySays,
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      const role = s.roles.get(viewer);
      if (role === undefined) return { public: pub, private: {} };
      const priv: Record<string, unknown> = { role, alive: s.alive.get(viewer) === true };
      if (role === "werewolf") {
        priv.teammates = wolfSeats(s).filter((t) => t !== viewer);
      }
      if (role === "seer") {
        priv.checks = [...s.seerChecks];
      }
      return { public: pub, private: priv };
    },

    timeoutAction(s, seat) {
      if (s.phase === "night") {
        if (s.roles.get(seat) === "werewolf") {
          const t = aliveSeats(s).find((x) => s.roles.get(x) !== "werewolf");
          if (t !== undefined) return { type: "kill", target: t };
        }
        return { type: "pass" };
      }
      if (s.phase === "day_discuss") return { type: "say", text: "（沉默）" };
      return { type: "pass" };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      const goodWin = s.winner === "good";
      for (const seat of s.seats) {
        const isWolf = s.roles.get(seat) === "werewolf";
        out[seat] = s.winner !== null && (goodWin ? !isWolf : isWolf) ? 1 : 0;
      }
      return out;
    },
  };

  return game;
}
