/**
 * House Bot（海龟汤）—— 主持人用关键词查表，猜题者用通用问题序列
 *
 * 必须说清楚的一件事：**这两个 bot 的对局质量注定不高**。
 * 海龟汤的核心是语义理解（「他打嗝」要能从任意措辞的提问里认出来），
 * 规则 bot 做不到——它只能拿谜题库的关键词表做字面匹配。
 * 因此 house bot 在这里的定位是「补位占坑」，让 quickstart 能开一局；
 * 真正的对局质量依赖 LLM agent 或真人（BYOA 的本意）。
 *
 * 主持人 bot 靠 `public.surface` 反查谜题库拿关键词——这是在利用「谜面公开」这一点，
 * 对真实 agent 不成立，所以不构成信息优势。
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { PUZZLES } from "../games/turtle-soup.ts";

/** 猜题者 bot 的通用提问池（不含任何谜题专属信息） */
const QUESTIONS = [
  "这件事涉及别人吗？",
  "是一瞬间发生的吗？",
  "跟他的职业有关吗？",
  "跟他家人有关吗？",
  "是他自己造成的吗？",
  "跟钱有关吗？",
  "他当时害怕吗？",
  "是意外吗？",
  "跟天气有关吗？",
  "他身体有毛病吗？",
  "跟他过去经历有关吗？",
  "发生地点重要吗？",
];

/** 猜题者 bot 的猜测池（泛泛而谈，命中率低——这才是规则 bot 的真实水平） */
const GUESSES = [
  "我想不出来，但应该跟他的过去经历有关。",
  "大概是他误会了什么。",
  "可能跟某个人的离开有关。",
];

interface SoupPublic {
  surface?: string;
  expecting?: string | null;
  asks_used?: number;
  max_asks?: number;
  guesses_used?: number;
  max_guesses?: number;
  pending_guess?: string | null;
  transcript?: { kind: string; text?: string }[];
}

export function createTurtleBot(name: string, idx: number): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = (view.public ?? {}) as SoupPublic;
      const role = (view.private as { role?: string } | undefined)?.role;
      const expecting = pub.expecting ?? null;

      if (role === "host") {
        const puzzle = PUZZLES.find((p) => p.surface === pub.surface);
        if (expecting === "answer") {
          const lastAsk = [...(pub.transcript ?? [])].reverse().find((t) => t.kind === "ask");
          const q = String(lastAsk?.text ?? "");
          const yes = puzzle?.yesWords.some((w) => q.includes(w)) ?? false;
          const no = puzzle?.noWords.some((w) => q.includes(w)) ?? false;
          submit({ type: "answer", verdict: yes ? "yes" : no ? "no" : "irrelevant" });
          return;
        }
        if (expecting === "judge") {
          const g = String(pub.pending_guess ?? "");
          const correct = puzzle?.yesWords.some((w) => g.includes(w)) ?? false;
          submit({ type: "judge", correct });
          return;
        }
        submit({ type: "answer", verdict: "irrelevant" });
        return;
      }

      // —— 猜题者 ——
      if (expecting === "ask") {
        const used = pub.asks_used ?? 0;
        const maxA = pub.max_asks ?? 12;
        const gUsed = pub.guesses_used ?? 0;
        const maxG = pub.max_guesses ?? 3;
        const remainingAsks = maxA - used;
        const remainingGuesses = maxG - gUsed;
        // 提问额度快见底时才动猜测：剩余提问数 ≤ 剩余猜测数，说明再问下去就没机会猜了。
        // 反例（早期实现）：一过 70% 就连续猜，三次猜完只剩提问额度没用——那是在浪费决策权。
        if (remainingGuesses > 0 && remainingAsks <= remainingGuesses) {
          submit({ type: "guess", text: GUESSES[(idx + gUsed * 2) % GUESSES.length]! });
          return;
        }
        submit({ type: "ask", text: QUESTIONS[(idx * 3 + used) % QUESTIONS.length]! });
        return;
      }

      // 兜底：不该走到这里（说明相位与角色错配），提交一个安全动作避免挂起
      submit({ type: "ask", text: "（等待）" });
    },
  };
}
