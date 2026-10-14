/**
 * 囚徒困境 House Bot —— 博弈论经典策略族（Axelrod 锦标赛阵容）
 * tit-for-tat（一报还一报，冠军策略）/ grim（冷酷触发）/ pavlov（赢留输改）/
 * cooperator（老好人）/ betrayer（永久背叛）
 * 全部确定性策略（无随机——回放逐字一致；「Bot 发言确定性」纪律自然满足）
 */

import type { Action, AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

type Choice = "cooperate" | "betray";

interface DilemmaPublic {
  round: number;
  total_rounds: number;
  phase: string;
  seats: number[];
  history: {
    round: number;
    choices: Record<string, Choice>;
    payoff: Record<string, number>;
  }[];
}

export type DilemmaStyle = "tft" | "grim" | "pavlov" | "coop" | "betray";

/** 解析视图：己方席位 + 对手上轮选择 + 己方上轮选择与收益 */
function parse(view: AgentView): { me: number; oppLast: Choice | null; myLast: Choice | null; myLastPayoff: number | null; finalRound: boolean } {
  const pub = view.public as unknown as DilemmaPublic;
  const me = view.you.seat;
  const opp = pub.seats.find((t) => t !== me);
  const last = pub.history[pub.history.length - 1] ?? null;
  return {
    me,
    oppLast: last && opp !== undefined ? (last.choices[String(opp)] ?? null) : null,
    myLast: last ? (last.choices[String(me)] ?? null) : null,
    myLastPayoff: last ? (last.payoff[String(me)] ?? null) : null,
    finalRound: pub.round >= pub.total_rounds,
  };
}

export function createDilemmaBot(name: string, style: DilemmaStyle): SeatDriver {
  /** grim 的记忆在驱动内跨 act 调用保持（被背叛过 = 永久背叛） */
  let betrayed = false;

  return {
    name,
    act: async (view: AgentView, submit) => {
      const { me, oppLast, myLast, myLastPayoff, finalRound } = parse(view);
      const c: Action = { type: "move", choice: "cooperate" };
      const d: Action = { type: "move", choice: "betray" };
      let reasoning = "";

      if (style === "coop") {
        reasoning = "老好人：无条件合作";
        return void (await submit(c, { reasoning }));
      }
      if (style === "betray") {
        reasoning = "背叛者：背叛是占优策略";
        return void (await submit(d, { reasoning }));
      }
      if (style === "tft") {
        // 一报还一报：首轮合作，之后复制对手上轮选择；末轮不额外背叛（经典 TFT 无末轮特判）
        const choice = oppLast === "betray" ? d : c;
        reasoning = oppLast === null
          ? "一报还一报：善意开局"
          : `一报还一报：对手上轮${oppLast === "betray" ? "背叛，回敬" : "合作，继续合作"}`;
        return void (await submit(choice, { reasoning }));
      }
      if (style === "grim") {
        // 冷酷触发：一旦被背叛永久背叛（驱动内记忆跨轮保持——视图历史亦可推导，双保险）
        if (oppLast === "betray") betrayed = true;
        if (view.public && (view.public as unknown as DilemmaPublic).history.some(
          (h) => h.choices[String(view.you.seat)] !== undefined && Object.entries(h.choices).some(
            ([seat, ch]) => Number(seat) !== me && ch === "betray",
          ),
        )) betrayed = true;
        const choice = betrayed ? d : c;
        reasoning = betrayed ? "冷酷触发：信任已破碎" : "冷酷触发：维持合作";
        return void (await submit(choice, { reasoning }));
      }

      // pavlov（赢留输改）：上轮收益 ≥3 重复自己的选择，否则切换
      if (myLast === null || myLastPayoff === null) {
        reasoning = "赢留输改：善意开局";
        return void (await submit(c, { reasoning }));
      }
      const keep = myLastPayoff >= 3; // R=3 或 T=5 = 赢
      const choice: Action = keep ? { type: "move", choice: myLast } : { type: "move", choice: myLast === "cooperate" ? "betray" : "cooperate" };
      reasoning = keep
        ? `赢留输改：上轮得 ${myLastPayoff} 分，保持${myLast === "cooperate" ? "合作" : "背叛"}`
        : `赢留输改：上轮只得 ${myLastPayoff} 分，改选${myLast === "cooperate" ? "背叛" : "合作"}`;
      if (finalRound && !keep) reasoning += "（末轮）";
      await submit(choice, { reasoning });
    },
  };
}
