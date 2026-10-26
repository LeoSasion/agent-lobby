/**
 * 海龟汤（turtle_soup）—— 中文社交推理经典 · 第八款游戏（r35 新增）
 *
 * 为什么是这款：现有七款里只有 undercover 的「描述」是自由文本，而
 * **「自由提问 → 主持人判定」**这一整类博弈从未出现。它同时是 README 路线图里
 * 一直挂着的「单人冷启动」缺口（一个人 + 一个 house bot 就能开一局）。
 *
 * 核心设计（决定了它为什么不违反「平台零 LLM 依赖」）：
 *   **判定权归选手，不归平台。** 平台只做三件事：发谜题、管流程（谁该说话、还剩几次）、
 *   记流水。主持人的「是/否/无关」与「猜中/没猜中」都是**选手的裁定**，平台原样记录。
 *   这与狼人杀「裁判由平台扮演」形成对照——海龟汤的裁判就是主持人本人。
 *   代价是社会契约风险（主持人可能放水或刁难），缓解手段是**终局公开真相 + 全程流水**，
 *   让观众能看出裁定是否公道；这不是平台能在协议层解决的，写在这里以免被当成漏洞。
 *
 * 规则：
 * - 2 席，角色由 seed 随机分配（主持人 host / 猜题者 guesser）——随机是为了让长期 Elo
 *   不带座位偏向；若固定谁当主持人，同一 seed 的胜负与实力无关
 * - 平台从谜题库随机一题：**谜面公开，真相只发给主持人**
 * - 严格交替：猜题者 `ask`（提问）→ 主持人 `answer`（yes/no/irrelevant/close）
 *   或 猜题者 `guess`（提交解答）→ 主持人 `judge`（correct: true/false）
 * - 提问上限 maxAsks（默认 12）、猜测上限 maxGuesses（默认 3）
 * - 猜中 → 猜题者胜；次数耗尽仍未猜中 → 主持人胜
 *
 * 超时兜底（确定性且可预期，绝不随机）：提问超时=记一条空提问并计次；
 * 回答超时=irrelevant；猜测超时=记空猜测并计次；判定超时=correct:false。
 */

import type { LegalAction, SeatId, Viewer } from "../protocol.ts";
import type { GameEvent, GameModule } from "./types.ts";
import type { Rng } from "../rng.ts";

export type Verdict = "yes" | "no" | "irrelevant" | "close";

export interface Puzzle {
  id: string;
  /** 谜面：发给所有人 */
  surface: string;
  /** 真相：只发给主持人，终局才公开 */
  truth: string;
  /** house bot 当主持人时的关键词表（真实对局由主持人 agent 自行判断，平台不参与判定） */
  yesWords: string[];
  noWords: string[];
}

/** 谜题库：简短、真相明确、能用是/否问题收敛。偏向温和题材（不写血腥/猎奇）。 */
export const PUZZLES: Puzzle[] = [
  {
    id: "elevator",
    surface: "他住在十楼。每天下楼都坐电梯到一楼，回家却只坐电梯到七楼，然后走楼梯上去。只有下雨天他会直接坐到十楼。",
    truth: "他个子很矮，只能够到七楼的按钮；下雨天手里有伞，可以用伞尖按到十楼的按钮。",
    yesWords: ["矮", "个子", "身高", "够不到", "够不着", "按钮", "伞", "下雨"],
    noWords: ["电梯坏", "锻炼", "减肥", "害怕", "停电"],
  },
  {
    id: "bar-water",
    surface: "他走进酒吧，向酒保要了一杯水。酒保却拔出一把枪指着他。他愣了一下，说了声谢谢，然后走了。",
    truth: "他当时在打嗝，想要一杯水止嗝。酒保看出他的窘境，用枪吓了他一跳，打嗝就好了。",
    yesWords: ["打嗝", "嗝", "吓", "惊吓", "害怕", "病"],
    noWords: ["抢劫", "仇人", "认识", "欠钱", "警察"],
  },
  {
    id: "two-breakfasts",
    surface: "他每天早上都买两份早餐，一份自己吃，一份放在对面的空椅子上。今天他只买了一份。",
    truth: "他的妻子每天陪他吃早餐。昨天她去世了。",
    yesWords: ["妻子", "老伴", "老婆", "去世", "死", "丧", "家人", "生病"],
    noWords: ["朋友", "同事", "减肥", "出差", "吵架"],
  },
  {
    id: "watering",
    surface: "他每天给阳台的花浇水，花却总是枯死。他很确定自己浇的确实是水。",
    truth: "邻居家的小孩每天趁他上班后，把花盆里的水换成盐水。",
    yesWords: ["邻居", "小孩", "孩子", "盐", "换", "别人", "恶作剧", "故意"],
    noWords: ["忘记", "太阳", "虫", "肥料", "土", "花盆"],
  },
  {
    id: "desert-parcel",
    surface: "一个人在沙漠里死去，身边有一个未拆封的包裹。",
    truth: "他是跳伞者。降落伞包出现故障没有打开，他直接坠落在沙漠里——包裹就是那个没来得及打开的伞包。",
    yesWords: ["跳伞", "伞", "飞机", "坠", "降落", "高空"],
    noWords: ["快递", "食物", "水", "迷路", "骆驼", "商队"],
  },
  {
    id: "three-knocks",
    surface: "她每天回家开门前，都要先敲三下门。",
    truth: "她和失明的母亲同住。母亲看不见，敲门三下是告诉她「是我回来了」，免得老人受惊。",
    yesWords: ["母亲", "妈妈", "盲", "看不见", "失明", "老人", "家人", "同住"],
    noWords: ["习惯", "迷信", "邻居", "小偷", "暗号", "强迫症"],
  },
];

type Turn =
  | { kind: "ask"; seat: SeatId; text: string; n: number }
  | { kind: "answer"; seat: SeatId; verdict: Verdict; n: number }
  | { kind: "guess"; seat: SeatId; text: string; n: number }
  | { kind: "judge"; seat: SeatId; correct: boolean; n: number };

interface State {
  seats: SeatId[];
  host: SeatId;
  guesser: SeatId;
  puzzle: Puzzle;
  maxAsks: number;
  maxGuesses: number;
  asksUsed: number;
  guessesUsed: number;
  transcript: Turn[];
  /** 此刻等谁出手 */
  awaiting: SeatId | null;
  /** 此刻等什么动作 */
  expecting: "ask" | "answer" | "guess" | "judge" | null;
  /** 猜题者刚提交的解答原文（等主持人判定；公开无害，观众也在猜） */
  pendingGuess: string | null;
  phase: "playing" | "finished";
  winner: SeatId | null;
  initEvents: GameEvent[];
}

export function createTurtleSoup(config: { maxAsks?: number; maxGuesses?: number; puzzle?: string } = {}): GameModule<State> {
  const maxAsks = Math.max(3, Math.min(40, config.maxAsks ?? 12));
  const maxGuesses = Math.max(1, Math.min(5, config.maxGuesses ?? 3));

  const game: GameModule<State> = {
    meta: { id: "turtle_soup", name: "海龟汤", minSeats: 2, maxSeats: 2, defaultTimeoutMs: 60_000 },

    init(seats: SeatId[], rng: Rng): State {
      if (seats.length !== 2) throw new Error("turtle_soup 需要 2 席");
      // 角色随机：长期 Elo 不带座位偏向（固定席位当主持人会让胜负与实力无关）
      const host = rng() < 0.5 ? seats[0]! : seats[1]!;
      const guesser = seats[0] === host ? seats[1]! : seats[0]!;
      const pool = config.puzzle ? PUZZLES.filter((p) => p.id === config.puzzle) : PUZZLES;
      const puzzle = (pool.length ? pool : PUZZLES)[Math.floor(rng() * (pool.length || PUZZLES.length))]!;
      const s: State = {
        seats: [...seats],
        host,
        guesser,
        puzzle,
        maxAsks,
        maxGuesses,
        asksUsed: 0,
        guessesUsed: 0,
        transcript: [],
        awaiting: guesser,
        expecting: "ask",
        pendingGuess: null,
        phase: "playing",
        winner: null,
        initEvents: [
          { type: "soup_served", data: { surface: puzzle.surface, host, guesser, max_asks: maxAsks, max_guesses: maxGuesses } },
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
      return s.asksUsed + s.guessesUsed + 1;
    },

    activeSeats(s) {
      return s.phase === "playing" && s.awaiting !== null ? [s.awaiting] : [];
    },

    legalActions(s, seat): LegalAction[] {
      if (s.phase !== "playing" || s.awaiting !== seat) return [];
      if (s.expecting === "ask") {
        return [
          { type: "ask", schema: { text: "string 1-200" }, hint: `提问（还剩 ${s.maxAsks - s.asksUsed} 次）。主持人只能答 是/否/无关/接近` },
          { type: "guess", schema: { text: "string 1-300" }, hint: `直接提交解答（还剩 ${s.maxGuesses - s.guessesUsed} 次）。猜错也消耗一次` },
        ];
      }
      if (s.expecting === "answer") {
        return [{ type: "answer", schema: { verdict: "enum yes/no/irrelevant/close" }, hint: "裁定这个问题：是 / 否 / 无关 / 接近" }];
      }
      if (s.expecting === "judge") {
        return [{ type: "judge", schema: { correct: "boolean" }, hint: "判定猜题者的解答是否说中了真相" }];
      }
      return [];
    },

    validate(s, seat, action) {
      if (s.phase === "finished") return { ok: false, error: "MATCH_FINISHED" };
      if (!s.seats.includes(seat)) return { ok: false, error: "NOT_YOUR_TURN：非本局席位" };
      if (s.awaiting !== seat) return { ok: false, error: "NOT_YOUR_TURN：现在等对手出手" };
      if (s.expecting === "ask") {
        if (action.type === "ask") {
          const t = action.text;
          if (typeof t !== "string" || t.length < 1 || t.length > 200) return { ok: false, error: "ILLEGAL_ACTION：提问须为 1-200 字符" };
          return { ok: true };
        }
        if (action.type === "guess") {
          const t = action.text;
          if (typeof t !== "string" || t.length < 1 || t.length > 300) return { ok: false, error: "ILLEGAL_ACTION：解答须为 1-300 字符" };
          return { ok: true };
        }
        return { ok: false, error: "ILLEGAL_ACTION：此相位仅可 ask 或 guess" };
      }
      if (s.expecting === "answer") {
        if (action.type !== "answer") return { ok: false, error: "ILLEGAL_ACTION：此相位仅可 answer" };
        if (!["yes", "no", "irrelevant", "close"].includes(String(action.verdict))) {
          return { ok: false, error: "ILLEGAL_ACTION：verdict 须为 yes|no|irrelevant|close" };
        }
        return { ok: true };
      }
      if (s.expecting === "judge") {
        if (action.type !== "judge") return { ok: false, error: "ILLEGAL_ACTION：此相位仅可 judge" };
        if (typeof action.correct !== "boolean") return { ok: false, error: "ILLEGAL_ACTION：correct 须为 boolean" };
        return { ok: true };
      }
      return { ok: false, error: "ILLEGAL_ACTION：当前无待处理动作" };
    },

    apply(s, seat, action) {
      const events: GameEvent[] = [];
      if (s.phase !== "playing") return { state: s, events };

      if (action.type === "ask") {
        s.asksUsed += 1;
        const t: Turn = { kind: "ask", seat, text: String(action.text), n: s.asksUsed };
        s.transcript.push(t);
        events.push({ type: "asked", data: { seat, text: t.text, n: s.asksUsed } });
        s.awaiting = s.host;
        s.expecting = "answer";
        return { state: s, events };
      }

      if (action.type === "answer") {
        const verdict = String(action.verdict) as Verdict;
        s.transcript.push({ kind: "answer", seat, verdict, n: s.asksUsed });
        events.push({ type: "answered", data: { seat, verdict, n: s.asksUsed } });
        if (s.asksUsed >= s.maxAsks) {
          return finish(s, events, s.host, "提问次数用尽，猜题者未能说中");
        }
        s.awaiting = s.guesser;
        s.expecting = "ask";
        return { state: s, events };
      }

      if (action.type === "guess") {
        s.guessesUsed += 1;
        s.pendingGuess = String(action.text);
        const t: Turn = { kind: "guess", seat, text: s.pendingGuess, n: s.guessesUsed };
        s.transcript.push(t);
        events.push({ type: "guessed", data: { seat, text: s.pendingGuess, n: s.guessesUsed } });
        s.awaiting = s.host;
        s.expecting = "judge";
        return { state: s, events };
      }

      if (action.type === "judge") {
        const correct = action.correct === true;
        s.transcript.push({ kind: "judge", seat, correct, n: s.guessesUsed });
        events.push({ type: "judged", data: { seat, correct, n: s.guessesUsed } });
        s.pendingGuess = null;
        if (correct) {
          return finish(s, events, s.guesser, "猜题者说中了真相");
        }
        if (s.guessesUsed >= s.maxGuesses) {
          return finish(s, events, s.host, "猜测次数用尽，猜题者未能说中");
        }
        s.awaiting = s.guesser;
        s.expecting = "ask";
        return { state: s, events };
      }

      return { state: s, events };
    },

    viewOf(s, viewer: Viewer, ctx) {
      const pub: Record<string, unknown> = {
        phase: s.phase,
        surface: s.puzzle.surface,
        host: s.host,
        guesser: s.guesser,
        awaiting: s.awaiting,
        expecting: s.expecting,
        asks_used: s.asksUsed,
        max_asks: s.maxAsks,
        guesses_used: s.guessesUsed,
        max_guesses: s.maxGuesses,
        transcript: s.transcript,
        pending_guess: s.pendingGuess,
        // 终局后真相转为公开信息（复盘必需——否则观众看完一整局也不知道谜底）。
        // 进行中绝不下发，否则观战即剧透。
        ...(s.phase === "finished" ? { truth: s.puzzle.truth } : {}),
        // 谁已出手（同时相位式进度；本游戏是顺序相位，主要用于观战对齐）
        submitted_seats: s.phase === "playing" ? [...(ctx?.submittedSeats ?? [])].sort((x, y) => x - y) : [],
      };
      if (viewer === "spectator") return { public: pub, private: {} };
      if (!s.seats.includes(viewer)) return { public: pub, private: {} };
      if (viewer === s.host) {
        // 真相只发给主持人：连观众都不能看，否则观战即剧透
        return { public: pub, private: { role: "host", truth: s.puzzle.truth } };
      }
      return { public: pub, private: { role: "guesser" } };
    },

    timeoutAction(s, seat) {
      // 确定性兜底，按「此刻等谁出手」给对应默认动作
      if (seat === s.host && s.expecting === "answer") return { type: "answer", verdict: "irrelevant" };
      if (seat === s.host && s.expecting === "judge") return { type: "judge", correct: false };
      return { type: "ask", text: "（超时未提问）" };
    },

    isTerminal(s) {
      return s.phase === "finished";
    },

    scores(s) {
      const out: Record<SeatId, number> = {};
      for (const t of s.seats) out[t] = s.winner === null ? 0 : t === s.winner ? 1 : 0;
      return out;
    },

    seatAlive() {
      return true;
    },

    placements(s) {
      if (s.winner === null) return s.seats.map((seat) => ({ seat, rank: 1 }));
      return [
        { seat: s.winner, rank: 1, note: s.winner === s.host ? "主持人守住了" : "猜题者说中" },
        { seat: s.winner === s.host ? s.guesser : s.host, rank: 2 },
      ];
    },
  };

  /** 终局收口：公开真相（复盘必需——否则观众永远不知道谜底） */
  function finish(s: State, events: GameEvent[], winner: SeatId, reason: string): { state: State; events: GameEvent[] } {
    s.phase = "finished";
    s.winner = winner;
    s.awaiting = null;
    s.expecting = null;
    events.push({
      type: "game_won",
      data: {
        winner,
        role: winner === s.host ? "host" : "guesser",
        truth: s.puzzle.truth,
        puzzle_id: s.puzzle.id,
        asks_used: s.asksUsed,
        guesses_used: s.guessesUsed,
        reason,
      },
    });
    return { state: s, events };
  }

  return game;
}
