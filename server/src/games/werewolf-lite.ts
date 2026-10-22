/**
 * 狼人杀·简化版（werewolf_lite）—— 平台灵魂游戏
 * 6 席：2 狼 / 3 民 / 1 预言家
 * 阶段循环：night（同时相位：狼刀 + 验人）→ day_discuss（遗言开场 → 顺序发言）
 *   → day_vote（同时相位：投票放逐，平票 PK 重投，PK 再平无人出局）→ 下一夜
 * 遗言：夜亡者与白天被放逐者在次日白天开场依次公开讲 last_words
 *   （真预言家首夜被刀后查验信息不湮灭——好人阵营的信息补偿机制）
 * 信息隔离：角色/队友/验人结果仅入 private；狼刀决策事件仅狼可见；
 *   死亡席位保留自身角色视角并保留遗言行动权；终局 game_won 公开全部身份
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
  todaySays: { seat: SeatId; text: string; kind?: "say" | "last_words" }[];
  votes: Map<SeatId, SeatId | null>;
  seerChecks: { target: SeatId; is_wolf: boolean }[];
  winner: "good" | "wolves" | null;
  stall: number;
  roundHadKill: boolean;
  pkCandidates: SeatId[] | null;
  lastSays: { seat: SeatId; text: string }[];
  /** 待讲遗言席位累积（夜亡 + 白天被放逐），次日白天开场依次讲出 */
  pendingLW: SeatId[];
  /** 今日开场遗言队列（座位序）与游标 */
  lwQueue: SeatId[];
  lwIndex: number;
  /** r26-b 狼队夜间密语（本夜累积；新夜清空）——协调刀口的沟通通道 */
  wolfChat: { seat: SeatId; text: string }[];
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

  // 狼刀：狼队意见不一致时，以座位号最大的狼的 kill 为准（v0 简化；分歧以 night_kill_decided.disagreed 标记，文档需写明）
  const wolves = wolfSeats(s);
  let target: SeatId | null = null;
  let disagreed = false;
  for (const w of wolves) {
    const a = s.nightActions.get(w);
    if (a && a.type === "kill" && a.target !== undefined) {
      if (target !== null && a.target !== target) disagreed = true;
      target = a.target;
    }
  }
  events.push({ type: "night_kill_decided", data: { target, disagreed }, visibility: { seats: wolves } });
  if (target !== null) {
    s.alive.set(target, false);
    s.pendingLW.push(target); // 夜亡者次日留遗言（真预言家的查验不随死亡湮灭）
    events.push({ type: "player_died", data: { seat: target, cause: "night" } });
  }
  s.roundHadKill = target !== null;

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
  // 开场遗言：累积的死者按座位序依次讲，随后存活者依序发言
  s.lwQueue = [...s.pendingLW].sort((a, b) => a - b);
  s.lwIndex = 0;
  s.pendingLW = [];
  s.sayQueue = aliveSeats(s);
  s.sayIndex = 0;
  s.todaySays = [];
  void rng;
}

function tryResolveVote(s: State, events: GameEvent[]): void {
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
  if (max > 0 && tied.length > 1 && s.pkCandidates === null) {
    // 首轮平票 → PK 重投（候选=平票者），本轮不放逐，全员在候选中重投
    s.pkCandidates = tied;
    s.votes = new Map();
    events.push({
      type: "vote_pk",
      data: { candidates: tied, tally: Object.fromEntries([...tally.entries()]) },
    });
    return;
  }
  const exiled: SeatId | null = max > 0 && tied.length === 1 ? tied[0] : null; // PK 再平 → 无人出局
  const passed = aliveSeats(s).filter((t) => s.votes.get(t) === null);
  events.push({
    type: "vote_result",
    data: { tally: Object.fromEntries([...tally.entries()]), exiled, passed, pk: s.pkCandidates !== null },
  });
  s.pkCandidates = null;
  if (exiled !== null) {
    s.alive.set(exiled, false);
    s.pendingLW.push(exiled); // 被放逐者亦留遗言（次日白天开场讲出）
    events.push({ type: "player_died", data: { seat: exiled, cause: "vote" } });
  }
  if (checkWin(s, events)) return;
  // 停滞治理：整轮无死亡且无放逐（如全员超时/空刀）连续两轮 → 终局，好人胜
  if (exiled === null && !s.roundHadKill) {
    s.stall += 1;
    events.push({ type: "round_stalled", data: { consecutive: s.stall } });
    if (s.stall >= 2) {
      s.phase = "finished";
      s.winner = "good";
      events.push({
        type: "game_won",
        data: { winner: "good", roles: Object.fromEntries([...s.roles.entries()]), reason: "连续两轮无淘汰，好人熬赢" },
      });
      return;
    }
  } else {
    s.stall = 0;
  }
  s.lastSays = s.todaySays;
  s.round += 1;
  s.phase = "night";
  s.nightActions = new Map();
  s.wolfChat = []; // r26-b 新夜清空狼队密语
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
        stall: 0,
        roundHadKill: false,
        pkCandidates: null,
        lastSays: [],
        pendingLW: [],
        lwQueue: [],
        lwIndex: 0,
        wolfChat: [],
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
      // r27-e：夜间已交行动者退出活跃集。r26-b 两步夜（先密语后出刀）让夜间横跨多个 step，
      // 而内核每 step 清空 received——已交的预言家会被重复驱动重交 check；同批 apply 循环内
      // 先手狼刀收齐即把相位推进到 day_discuss，后手这份陈旧 check 便落进遗言分支，
      // 化作空文本「幻影遗言」吞掉夜亡者真遗言（且其 acted 可见性误判 all——验人目标泄露）。
      if (s.phase === "night") return nightActors(s).filter((t) => !s.nightActions.has(t));
      if (s.phase === "day_discuss") {
        // 开场遗言优先（死者依次讲），随后存活者依序发言
        if (s.lwIndex < s.lwQueue.length) return [s.lwQueue[s.lwIndex]];
        return [s.sayQueue[s.sayIndex]];
      }
      return aliveSeats(s); // day_vote
    },

    legalActions(s, seat) {
      if (s.phase === "finished") return [];
      const alive = (t: SeatId) => s.alive.get(t) === true;
      const role = s.roles.get(seat);

      if (s.phase === "night") {
        if (alive(seat) !== true || (role !== "werewolf" && role !== "seer")) return [];
        // r27-e：与 activeSeats 同步——已交夜间行动者法表清空（you.active=false，
        // 视图不再兜售 check/kill；重复 POST 由内核按活跃集拒以 NOT_YOUR_TURN）
        if (s.nightActions.has(seat)) return [];
        if (role === "werewolf") {
          const targets = aliveSeats(s).filter((t) => s.roles.get(t) !== "werewolf");
          if (targets.length === 0) return [{ type: "pass", hint: "无刀可出" }];
          return [
            { type: "kill", schema: { target: "enum", values: targets } },
            { type: "pass", hint: "空刀" },
            // r26-b 狼队密语：不占夜间收齐名额（随时可说，不影响 kill/check 的收齐判定）
            { type: "wolf_say", schema: { text: "string 1-500" }, hint: "狼队密语（仅狼可见，协调刀口）" },
          ];
        }
        return [
          { type: "check", schema: { target: "enum", values: aliveSeats(s).filter((t) => t !== seat) } },
          { type: "pass", hint: "不验" },
        ];
      }

      if (s.phase === "day_discuss") {
        if (s.lwIndex < s.lwQueue.length) {
          return s.lwQueue[s.lwIndex] === seat
            ? [{ type: "last_words", schema: { text: "string 1-500" }, hint: "遗言（公开）" }]
            : [];
        }
        return s.sayQueue[s.sayIndex] === seat
          ? [{ type: "say", schema: { text: "string 1-500" }, hint: "公开发言" }]
          : [];
      }

      if (alive(seat) !== true) return [];
      const pool = s.pkCandidates ?? aliveSeats(s);
      return [
        { type: "vote", schema: { target: "enum", values: pool }, hint: s.pkCandidates ? "PK 重投：仅可投平票候选人" : undefined },
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
        // r26-b 狼队密语：仅夜间存活狼可发；不写 nightActions（不占收齐名额）
        // r27-a 频率限制：每狼每夜 ≤5 条（防刷屏；超时兜底/QPS 之外的引擎级防线）
        if (role === "werewolf" && action.type === "wolf_say") {
          const text = action.text;
          if (typeof text !== "string" || text.length < 1 || text.length > 500) {
            return { ok: false, error: `ILLEGAL_ACTION：text 须为 1-500 字符（按 UTF-16 码元计，当前 ${typeof text === "string" ? text.length : typeof text}）` };
          }
          if (s.wolfChat.filter((c) => c.seat === seat).length >= 5) {
            return { ok: false, error: "ILLEGAL_ACTION：本夜密语已达上限（5 条/夜）——话要说在刀口上" };
          }
          return { ok: true };
        }
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
        if (s.lwIndex < s.lwQueue.length) {
          if (s.lwQueue[s.lwIndex] !== seat) return { ok: false, error: "NOT_YOUR_TURN：未到其遗言" };
          if (action.type === "last_words") {
            const text = action.text;
            if (typeof text !== "string" || text.length < 1 || text.length > 500) {
              return { ok: false, error: `ILLEGAL_ACTION：text 须为 1-500 字符（按 UTF-16 码元计，当前 ${typeof text === "string" ? text.length : typeof text}）` };
            }
            return { ok: true };
          }
          return { ok: false, error: "ILLEGAL_ACTION：遗言阶段仅可 last_words" };
        }
        if (s.sayQueue[s.sayIndex] !== seat) return { ok: false, error: "NOT_YOUR_TURN：未到你发言" };
        if (action.type === "say") {
          const text = action.text;
          if (typeof text !== "string" || text.length < 1 || text.length > 500) {
            return { ok: false, error: `ILLEGAL_ACTION：text 须为 1-500 字符（按 UTF-16 码元计，当前 ${typeof text === "string" ? text.length : typeof text}）` };
          }
          return { ok: true };
        }
        return { ok: false, error: "ILLEGAL_ACTION：发言阶段仅可 say" };
      }

      if (alive(seat) !== true) return { ok: false, error: "NOT_YOUR_TURN：已出局" };
      if (action.type === "pass") return { ok: true };
      if (action.type === "vote") {
        const t = action.target as SeatId;
        const pool = s.pkCandidates ?? aliveSeats(s);
        if (!pool.includes(t)) {
          return { ok: false, error: s.pkCandidates ? "ILLEGAL_ACTION：PK 阶段只能投平票候选人" : "ILLEGAL_ACTION：投票对象须存活" };
        }
        return { ok: true };
      }
      return { ok: false, error: "ILLEGAL_ACTION：投票阶段仅可 vote/pass" };
    },

    apply(s, seat, action, rng) {
      const events: GameEvent[] = [];
      if (s.phase === "night") {
        // r26-b 狼队密语：即时入流（不占收齐名额、不触发结算）——狼可以边聊边刀
        if (action.type === "wolf_say" && s.roles.get(seat) === "werewolf") {
          const text = String(action.text ?? "");
          s.wolfChat.push({ seat, text });
          events.push({ type: "wolf_said", data: { seat, text }, visibility: { seats: wolfSeats(s) } });
          return { state: s, events };
        }
        s.nightActions.set(seat, {
          type: action.type === "kill" || action.type === "check" ? (action.type as "kill" | "check") : "pass",
          target: action.target as SeatId | undefined,
        });
        tryResolveNight(s, events, rng);
      } else if (s.phase === "day_discuss") {
        if (s.lwIndex < s.lwQueue.length) {
          // 遗言：入公开 today_says（kind 标记），bots/观众可据此推理
          const text = String(action.text ?? "");
          s.todaySays.push({ seat, text, kind: "last_words" });
          events.push({ type: "last_words", data: { seat, text } });
          s.lwIndex += 1;
        } else {
          const text = String(action.text ?? "");
          s.todaySays.push({ seat, text, kind: "say" });
          events.push({ type: "said", data: { seat, text } });
          s.sayIndex += 1;
          if (s.sayIndex >= s.sayQueue.length) {
            s.phase = "day_vote";
            s.votes = new Map();
          }
        }
      } else if (s.phase === "day_vote") {
        s.votes.set(seat, action.type === "vote" ? (action.target as SeatId) : null);
        tryResolveVote(s, events);
      }
      return { state: s, events };
    },

    viewOf(s, viewer, ctx) {
      const pub: Record<string, unknown> = {
        round: s.round,
        phase: s.phase,
        seats: s.seats,
        alive_seats: aliveSeats(s),
        today_says: s.todaySays,
        last_day_says: s.lastSays,
        pk_candidates: s.pkCandidates,
      };
      // 相位进度（纯公开信息，不含票向/身份）：谁在发言、谁还没投票——消除真人局盲等（r6 三方反馈）
      if (s.phase === "day_discuss") {
        const inLw = s.lwIndex < s.lwQueue.length;
        pub.speaking_seat = inLw ? s.lwQueue[s.lwIndex] : s.sayQueue[s.sayIndex];
        // r8：显式标注当前发言种类——开场遗言与普通发言对外观感一致，2/2 死亡席位实测错过遗言窗口
        pub.speaking_kind = inLw ? "last_words" : "say";
        pub.pending_speakers = inLw ? [...s.lwQueue.slice(s.lwIndex + 1), ...s.sayQueue] : s.sayQueue.slice(s.sayIndex + 1);
        // r10 w10-s1 P2④：待发言队列的 kind 标注（等长数组，与 pending_speakers 按位对应）——
        // 真人无法预判队列里哪些是遗言，错估遗言窗口会错过一次性动作
        pub.pending_kinds = inLw
          ? [...s.lwQueue.slice(s.lwIndex + 1).map(() => "last_words"), ...s.sayQueue.map(() => "say")]
          : s.sayQueue.slice(s.sayIndex + 1).map(() => "say");
      }
      if (s.phase === "day_vote") {
        // 已投票席位来自内核 ctx.submittedSeats（received 实时缓冲）——s.votes 要等批量 apply 才写入，
        // 窗口期读它恒为空（r7 P0：四方实测 16 次轮询 votes_cast=[]）。
        // 契约提醒：夜间等隐藏同时相位绝不可读 ctx（狼/预言家的提交进度会泄露身份）
        const cast = ctx?.submittedSeats ?? [];
        pub.votes_cast = [...cast].sort((a, b) => a - b);
        pub.pending_voters = aliveSeats(s).filter((t) => !cast.includes(t));
      }
      if (viewer === "spectator") return { public: pub, private: {} };
      const role = s.roles.get(viewer);
      if (role === undefined) return { public: pub, private: {} };
      const priv: Record<string, unknown> = { role, alive: s.alive.get(viewer) === true };
      if (role === "werewolf") {
        priv.teammates = wolfSeats(s).filter((t) => t !== viewer);
        priv.wolf_chat = [...s.wolfChat]; // r26-b 本夜狼队密语（新夜清空）
      }
      if (role === "seer") {
        priv.checks = [...s.seerChecks];
      }
      return { public: pub, private: priv };
    },

    timeoutAction(s) {
      // 夜间超时一律 pass（空刀/不验）：绝不替狼队抢刀权；比赛推进由停滞治理兜底
      if (s.phase === "day_discuss") {
        // 文案明确区分「超时」与「主动沉默」——避免系统默认话术被当作推理素材（r5 真人局实测反馈）
        if (s.lwIndex < s.lwQueue.length) return { type: "last_words", text: "（超时未留遗言）" };
        return { type: "say", text: "（超时未发言）" };
      }
      return { type: "pass" };
    },

    actionVisibility(s, seat) {
      if (s.phase !== "night") return "all";
      const role = s.roles.get(seat);
      if (role === "werewolf") return { seats: wolfSeats(s) };
      if (role === "seer") return { seats: [seat] };
      return "all";
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

    seatAlive(s, seat) {
      return s.alive.get(seat) === true;
    },

    /** r29：终局名次——按阵营给序（胜方并列 1，负方并列 2），note 带身份供复盘 */
    placements(s) {
      const goodWin = s.winner === "good";
      const won = (seat: SeatId) => {
        const isWolf = s.roles.get(seat) === "werewolf";
        return s.winner !== null && (goodWin ? !isWolf : isWolf);
      };
      return s.seats
        .map((seat) => ({ seat, rank: won(seat) ? 1 : 2, note: s.roles.get(seat) }))
        .sort((a, b) => a.rank - b.rank || a.seat - b.seat);
    },
  };

  return game;
}
