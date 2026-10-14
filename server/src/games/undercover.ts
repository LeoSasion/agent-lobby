/**
 * 谁是卧底（undercover）—— 社交推理经典 · 中文国民游戏（r25：双游戏轮主菜，Masquerade/SteamedClaw 品类）
 * 6 席：1 卧底 + 5 平民；平民同拿「平民词」，卧底拿近似「卧底词」（词对库 rng 选取）
 * 流程（3 轮上限）：发词（私有）→ describe（存活者按座位序一句话描述自己的词，不得含词本身）
 *   → vote（同时投票放逐，平票 PK 重投——狼人杀同构）→ 被放逐者亮身份 → 下一轮
 * 胜负：放逐卧底 = 平民胜；存活 ≤3 且卧底在场 = 卧底胜；3 轮打完卧底仍存活 = 卧底胜
 * 信息隔离：private.word + private.is_undercover（卧底词异于他人 = 卧底自知身份——经典规则）；
 *   描述与投票公开；被放逐者身份公开（亮身份）；终局 game_won 公开全部身份与词对（观赏性）
 */

import type { Action, LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export type Role = "undercover" | "civilian";

/** 词对库（平民词 / 卧底词 / 类别——类别供 bot 生成安全描述：近似词对天然同类）
 * r26-a：20→40 对（23 类别）。排列约束：同类别条目互不相邻——连续 rng 抽到相邻 idx 时
 * 不至于连局同类别（「上局水果这局又是水果」的联想泄露）。 */
const WORD_PAIRS: { c: string; u: string; cat: string }[] = [
  { c: "苹果", u: "梨", cat: "水果" }, { c: "咖啡", u: "茶", cat: "饮品" },
  { c: "篮球", u: "足球", cat: "运动" }, { c: "地铁", u: "公交", cat: "交通" },
  { c: "手机", u: "平板", cat: "电子设备" }, { c: "医生", u: "护士", cat: "职业" },
  { c: "筷子", u: "勺子", cat: "餐具" }, { c: "雨伞", u: "雨衣", cat: "雨具" },
  { c: "狼", u: "狗", cat: "动物" }, { c: "春天", u: "秋天", cat: "季节" },
  { c: "生日", u: "节日", cat: "日子" }, { c: "面包", u: "蛋糕", cat: "食物" },
  { c: "沙发", u: "椅子", cat: "家具" }, { c: "铅笔", u: "钢笔", cat: "文具" },
  { c: "红包", u: "礼物", cat: "馈赠" }, { c: "直播", u: "录像", cat: "影像" },
  { c: "图书馆", u: "书店", cat: "场所" }, { c: "电梯", u: "楼梯", cat: "垂直通行" },
  { c: "牙膏", u: "洗面奶", cat: "日用品" }, { c: "猫", u: "老虎", cat: "动物" },
  { c: "帽子", u: "围巾", cat: "服饰" }, { c: "电视", u: "投影仪", cat: "家电" },
  { c: "钢琴", u: "电子琴", cat: "乐器" }, { c: "西瓜", u: "哈密瓜", cat: "水果" },
  { c: "可乐", u: "雪碧", cat: "饮品" }, { c: "游泳", u: "跳水", cat: "运动" },
  { c: "飞机", u: "高铁", cat: "交通" }, { c: "耳机", u: "音箱", cat: "电子设备" },
  { c: "老师", u: "教授", cat: "职业" }, { c: "碗", u: "盘子", cat: "餐具" },
  { c: "雨鞋", u: "雨靴", cat: "雨具" }, { c: "马", u: "驴", cat: "动物" },
  { c: "夏天", u: "冬天", cat: "季节" }, { c: "周末", u: "假期", cat: "日子" },
  { c: "米饭", u: "面条", cat: "食物" }, { c: "桌子", u: "茶几", cat: "家具" },
  { c: "橡皮", u: "尺子", cat: "文具" }, { c: "贺卡", u: "鲜花", cat: "馈赠" },
  { c: "电影", u: "电视剧", cat: "影像" }, { c: "超市", u: "菜市场", cat: "场所" },
];

/** r26-a：词对库导出（smoke 断言库不变量用——40 对/类别数/相邻不重类） */
export function wordPairs(): readonly { c: string; u: string; cat: string }[] {
  return WORD_PAIRS;
}

interface State {
  seats: SeatId[];
  roles: Map<SeatId, Role>;
  words: Map<SeatId, string>;
  wordPair: { civilian: string; undercover: string; cat: string };
  alive: Map<SeatId, boolean>;
  round: number;
  phase: "describe" | "vote" | "finished";
  sayQueue: SeatId[];
  sayIndex: number;
  todayDescribes: { seat: SeatId; text: string }[];
  votes: Map<SeatId, SeatId | null>;
  pkCandidates: SeatId[] | null;
  winner: "civilians" | "undercover" | null;
  exiledLog: { seat: SeatId; role: Role }[];
  initEvents: GameEvent[];
}

function aliveSeats(s: State): SeatId[] {
  return s.seats.filter((t) => s.alive.get(t) === true);
}

function undercoverSeat(s: State): SeatId | undefined {
  return s.seats.find((t) => s.roles.get(t) === "undercover");
}

function checkWin(s: State, events: GameEvent[]): boolean {
  const uc = undercoverSeat(s);
  const ucAlive = uc !== undefined && s.alive.get(uc) === true;
  const aliveCount = aliveSeats(s).length;
  if (!ucAlive) {
    s.phase = "finished";
    s.winner = "civilians";
  } else if (aliveCount <= 3 || s.round > 3) {
    // 卧底撑到最后三人 / 三轮描述-投票打完仍存活
    s.phase = "finished";
    s.winner = "undercover";
  }
  if (s.winner) {
    events.push({
      type: "game_won",
      data: {
        winner: s.winner,
        roles: Object.fromEntries([...s.roles.entries()]),
        word_pair: s.wordPair,
        reason: s.winner === "civilians" ? "卧底被揪出" : "卧底存活到最后",
      },
    });
    return true;
  }
  return false;
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
    if (n > max) { max = n; tied = [t]; } else if (n === max) { tied.push(t); }
  }
  if (max > 0 && tied.length > 1 && s.pkCandidates === null) {
    s.pkCandidates = tied;
    s.votes = new Map();
    events.push({ type: "vote_pk", data: { candidates: tied, tally: Object.fromEntries([...tally.entries()]) } });
    return;
  }
  const exiled: SeatId | null = max > 0 && tied.length === 1 ? tied[0] : null;
  const passed = aliveSeats(s).filter((t) => s.votes.get(t) === null);
  events.push({
    type: "vote_result",
    data: { tally: Object.fromEntries([...tally.entries()]), exiled, passed, pk: s.pkCandidates !== null },
  });
  s.pkCandidates = null;
  if (exiled !== null) {
    const role = s.roles.get(exiled) as Role;
    s.alive.set(exiled, false);
    s.exiledLog.push({ seat: exiled, role });
    events.push({ type: "player_exiled", data: { seat: exiled, role, was_undercover: role === "undercover" } });
  }
  if (checkWin(s, events)) return;
  s.round += 1;
  s.phase = "describe";
  s.sayQueue = aliveSeats(s);
  s.sayIndex = 0;
  s.todayDescribes = [];
}

export function createUndercover(): GameModule<State> {
  const game: GameModule<State> = {
    meta: { id: "undercover", name: "谁是卧底", minSeats: 6, maxSeats: 6, defaultTimeoutMs: 60_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 6) throw new Error("undercover 需要 6 席");
      const pairIdx = Math.floor(rng() * WORD_PAIRS.length);
      const pair = WORD_PAIRS[pairIdx]!;
      const civilianWord = pair.c;
      const undercoverWord = pair.u;
      const ucSeat = seats[Math.floor(rng() * seats.length)]!;
      const roles = new Map<SeatId, Role>();
      const words = new Map<SeatId, string>();
      for (const t of seats) {
        const isUC = t === ucSeat;
        roles.set(t, isUC ? "undercover" : "civilian");
        words.set(t, isUC ? undercoverWord : civilianWord);
      }
      const s: State = {
        seats: [...seats],
        roles,
        words,
        wordPair: { civilian: civilianWord, undercover: undercoverWord, cat: pair.cat },
        alive: new Map(seats.map((t) => [t, true])),
        round: 1,
        phase: "describe",
        sayQueue: [...seats],
        sayIndex: 0,
        todayDescribes: [],
        votes: new Map(),
        pkCandidates: null,
        winner: null,
        exiledLog: [],
        initEvents: [],
      };
      return s;
    },

    initialEvents(state) {
      // 发词事件：逐席位私有（word 内容仅本人可见——身份与词均不泄）
      const evs: GameEvent[] = state.seats.map((seat) => ({
        type: "word_assigned",
        data: { seat, word: state.words.get(seat), round: 1 },
        visibility: { seats: [seat] },
      }));
      return state.initEvents.splice(0).concat(evs);
    },

    phase(s) { return s.phase; },
    round(s) { return s.round; },

    activeSeats(s) {
      if (s.phase === "finished") return [];
      if (s.phase === "describe") return [s.sayQueue[s.sayIndex]];
      return aliveSeats(s); // vote
    },

    legalActions(s, seat) {
      if (s.phase === "finished") return [];
      const alive = (t: SeatId) => s.alive.get(t) === true;
      if (s.phase === "describe") {
        return s.sayQueue[s.sayIndex] === seat
          ? [{ type: "describe", schema: { text: "string 1-120" }, hint: "一句话描述你的词（不得含词本身）" }]
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
      if (s.phase === "describe") {
        if (s.sayQueue[s.sayIndex] !== seat) return { ok: false, error: "NOT_YOUR_TURN：未到你描述" };
        if (action.type !== "describe") return { ok: false, error: "ILLEGAL_ACTION：描述阶段仅可 describe" };
        const text = action.text;
        if (typeof text !== "string" || text.length < 1 || text.length > 120) {
          return { ok: false, error: `ILLEGAL_ACTION：text 须为 1-120 字符（当前 ${typeof text === "string" ? text.length : typeof text}）` };
        }
        const myWord = s.words.get(seat) ?? "";
        if (myWord && text.includes(myWord)) {
          return { ok: false, error: `ILLEGAL_ACTION：描述不得包含词本身（${"*".repeat(myWord.length)}）` };
        }
        return { ok: true };
      }
      if (s.alive.get(seat) !== true) return { ok: false, error: "NOT_YOUR_TURN：已出局" };
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

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase === "describe") {
        const text = String(action.text ?? "");
        s.todayDescribes.push({ seat, text });
        events.push({ type: "described", data: { seat, text, round: s.round } });
        s.sayIndex += 1;
        if (s.sayIndex >= s.sayQueue.length) {
          s.phase = "vote";
          s.votes = new Map();
        }
      } else if (s.phase === "vote") {
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
        today_describes: s.todayDescribes,
        exiled_log: s.exiledLog,
        pk_candidates: s.pkCandidates,
        max_rounds: 3,
      };
      if (s.phase === "describe") {
        pub.speaking_seat = s.sayQueue[s.sayIndex];
        pub.pending_speakers = s.sayQueue.slice(s.sayIndex + 1);
      }
      if (s.phase === "vote") {
        const cast = ctx?.submittedSeats ?? [];
        pub.votes_cast = [...cast].sort((a, b) => a - b);
        pub.pending_voters = aliveSeats(s).filter((t) => !cast.includes(t));
      }
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      return {
        public: pub,
        private: {
          word: s.words.get(viewer) ?? null,
          is_undercover: s.roles.get(viewer) === "undercover",
          alive: s.alive.get(viewer) === true,
        },
      };
    },

    timeoutAction(s) {
      if (s.phase === "describe") return { type: "describe", text: "（超时未描述）" };
      return { type: "pass" }; // 弃票——绝不代投
    },

    actionVisibility(s, seat) {
      // word_assignment 均为私有；describe/vote 的 acted 公开（描述内容与投票本身就是公开行为）
      void s; void seat;
      return "all";
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      const civWin = s.winner === "civilians";
      for (const t of s.seats) {
        const isUC = s.roles.get(t) === "undercover";
        out[t] = s.winner !== null && (civWin ? !isUC : isUC) ? 1 : 0;
      }
      return out;
    },
  };

  return game;
}
