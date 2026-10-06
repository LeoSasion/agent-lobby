/**
 * 狼人杀角色感知 House Bot
 * 同一段驱动代码按 view.private.role 适配行为：狼装民、预言家报查验、村民归票
 * 确定性策略（无随机），bias 用于打散不同 bot 的目标选择
 */

import type { AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";

interface WWPrivate {
  role?: "werewolf" | "seer" | "villager";
  alive?: boolean;
  teammates?: number[];
  checks?: { target: number; is_wolf: boolean }[];
}

interface WWPublic {
  round: number;
  phase: string;
  alive_seats: number[];
  today_says: { seat: number; text: string }[];
}

export function createWerewolfBot(name: string, bias = 0): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const priv = view.private as WWPrivate;
      const pub = view.public as WWPublic;
      const role = priv.role ?? "villager";
      const la = view.legal_actions;
      const values = (t: string): number[] =>
        ((la.find((a) => a.type === t)?.schema?.values ?? []) as unknown[]).filter(
          (v): v is number => typeof v === "number",
        );

      // 夜间：狼出刀
      if (la.some((a) => a.type === "kill")) {
        const targets = values("kill");
        if (targets.length === 0) return submit({ type: "pass" });
        return submit({ type: "kill", target: targets[bias % targets.length] });
      }
      // 夜间：预言家验人（优先验未验过的）
      if (la.some((a) => a.type === "check")) {
        const checked = new Set((priv.checks ?? []).map((c) => c.target));
        const t = values("check").find((x) => !checked.has(x));
        if (t === undefined) return submit({ type: "pass" });
        return submit({ type: "check", target: t });
      }
      // 白天发言
      if (la.some((a) => a.type === "say")) {
        if (role === "seer") {
          const cs = priv.checks ?? [];
          const c = cs[cs.length - 1];
          const text = c
            ? `我是预言家，昨晚验了 ${c.target} 号，${c.is_wolf ? "是狼人！" : "是好人。"}`
            : "我是预言家，昨晚没有验人。";
          return submit({ type: "say", text });
        }
        if (role === "werewolf") {
          return submit({ type: "say", text: `我是个平民。现在 ${pub.alive_seats.length} 人存活，我认为信息太少，先听大家怎么说。` });
        }
        return submit({ type: "say", text: "我是好人。昨天场上发生的事我需要再想想，谨慎投票。" });
      }
      // 投票
      if (la.some((a) => a.type === "vote")) {
        const me = view.you.seat;
        const mates = new Set(priv.teammates ?? []);
        const targets = values("vote").filter((t) => t !== me);
        if (role === "werewolf") {
          const t = targets.find((x) => !mates.has(x));
          if (t !== undefined) return submit({ type: "vote", target: t });
          return submit({ type: "pass" });
        }
        if (role === "seer") {
          const wolf = (priv.checks ?? []).find((c) => c.is_wolf && pub.alive_seats.includes(c.target));
          if (wolf) return submit({ type: "vote", target: wolf.target });
        }
        if (targets.length === 0) return submit({ type: "pass" });
        return submit({ type: "vote", target: targets[(me + pub.round + bias) % targets.length] });
      }
      return submit({ type: "pass" });
    },
  };
}
