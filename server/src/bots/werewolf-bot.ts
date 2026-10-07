/**
 * 狼人杀角色感知 House Bot —— 社交推理版
 * 升级点：
 *   1. 解析 today_says 中的预言家报查验，据此投票（村民跟查杀、狼人反跳）
 *   2. 狼人夜间优先刀已跳预言家的人
 *   3. 预言家报查验更清晰，投票带推理
 */

import type { Action, AgentView } from "../protocol.ts";
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
  last_day_says: { seat: number; text: string }[];
  pk_candidates: number[] | null;
}

interface SeerClaim {
  claimant: number;
  checked: number;
  isWolf: boolean;
}

function parseSeerClaims(says: { seat: number; text: string }[]): SeerClaim[] {
  const claims: SeerClaim[] = [];
  for (const s of says) {
    const m = /验了\s*(\d+)\s*号[，,]?\s*(?:是狼人|是好人)/.exec(s.text);
    if (m) {
      claims.push({ claimant: s.seat, checked: Number(m[1]), isWolf: s.text.includes("是狼人") });
    }
  }
  return claims;
}

/** 被查杀者是否明确自证（"不是狼"——仅自证格式触发，通用"我是好人"不算） */
function explicitSelfDefense(says: { seat: number; text: string }[], accused: number): boolean {
  return says.some((s) => s.seat === accused && s.text.includes("不是狼"));
}

/** 是否有对跳（两人都自称预言家且互相指控） */
function hasCounterClaim(claims: SeerClaim[]): boolean {
  const claimants = new Set(claims.map((c) => c.claimant));
  if (claimants.size < 2) return false;
  for (const a of claims) {
    for (const b of claims) {
      if (a.claimant !== b.claimant && a.checked === b.claimant && b.checked === a.claimant) return true;
    }
  }
  return false;
}

function done(
  submit: (a: Action, opts?: { reasoning?: string }) => { ok: boolean },
  action: Action,
): void {
  submit(action);
}

export function createWerewolfBot(name: string, bias = 0): SeatDriver {
  return {
    name,
    act: async (view: AgentView, submit) => {
      const priv = view.private as unknown as WWPrivate;
      const pub = view.public as unknown as WWPublic;
      const role = priv.role ?? "villager";
      const la = view.legal_actions;
      const values = (t: string): number[] =>
        ((la.find((a) => a.type === t)?.schema?.values ?? []) as unknown[]).filter(
          (v): v is number => typeof v === "number",
        );

      // 夜间：狼出刀（升级：优先刀已跳预言家的——看昨日发言）
      if (la.some((a) => a.type === "kill")) {
        const targets = values("kill");
        if (targets.length === 0) return done(submit, { type: "pass" });
        const allSays = [...(pub.last_day_says ?? []), ...(pub.today_says ?? [])];
        const claims = parseSeerClaims(allSays);
        const seerClaimants = claims.map((c) => c.claimant).filter((s) => targets.includes(s));
        if (seerClaimants.length > 0) {
          return done(submit, { type: "kill", target: seerClaimants[0] });
        }
        return done(submit, { type: "kill", target: targets[bias % targets.length] });
      }

      // 夜间：预言家验人
      if (la.some((a) => a.type === "check")) {
        const checked = new Set((priv.checks ?? []).map((c) => c.target));
        const t = values("check").find((x) => !checked.has(x));
        if (t === undefined) return done(submit, { type: "pass" });
        return done(submit, { type: "check", target: t });
      }

      // 白天发言
      if (la.some((a) => a.type === "say")) {
        const claims = parseSeerClaims(pub.today_says ?? []);
        const me = view.you.seat;
        if (role === "seer") {
          const cs = priv.checks ?? [];
          const c = cs[cs.length - 1];
          const text = c
            ? `我是预言家，昨晚验了 ${c.target} 号，${c.is_wolf ? "是狼人！" : "是好人。"}请大家认准我的查验。`
            : "我是预言家，昨晚没有验人。";
          return done(submit, { type: "say", text });
        }
        if (role === "werewolf") {
          const mates = new Set(priv.teammates ?? []);
          const killTarget = claims.find((c) => c.isWolf && mates.has(c.checked));
          if (killTarget) {
            return done(submit, {
              type: "say",
              text: `${killTarget.claimant} 号这个预言家查得太准了，可疑。我是个平民，${killTarget.claimant} 号可能是狼悍跳。`,
            });
          }
          return done(submit, {
            type: "say",
            text: `我是个平民。现在 ${pub.alive_seats.length} 人存活，我认为信息太少，先听大家怎么说。`,
          });
        }
        // 村民：被查杀 → 自证清白（不自认！）
        const accusedMe = claims.find((c) => c.isWolf && c.checked === me);
        if (accusedMe) {
          return done(submit, {
            type: "say",
            text: `${accusedMe.claimant} 号查杀我，我不是狼！我是好人，${accusedMe.claimant} 号可能是狼悍跳带偏节奏。`,
          });
        }
        // 村民：评估跳报可信度
        const allSays = pub.today_says ?? [];
        const counterClaim = hasCounterClaim(claims);
        const credibleKill = claims.find(
          (c) => c.isWolf && c.checked !== me && pub.alive_seats.includes(c.checked),
        );
        if (credibleKill) {
          if (counterClaim) {
            return done(submit, {
              type: "say",
              text: `有对跳，${credibleKill.claimant} 号和被查杀的 ${credibleKill.checked} 号各执一词，我先观望再投票。`,
            });
          }
          if (explicitSelfDefense(allSays, credibleKill.checked)) {
            return done(submit, {
              type: "say",
              text: `${credibleKill.claimant} 号查杀 ${credibleKill.checked} 号，但对方否认了。证据不够充分，我保持怀疑。`,
            });
          }
          return done(submit, {
            type: "say",
            text: `我认可 ${credibleKill.claimant} 号预言家的查验，${credibleKill.checked} 号是狼，请大家跟票放逐。`,
          });
        }
        return done(submit, { type: "say", text: "我是好人。昨天场上发生的事我需要再想想，谨慎投票。" });
      }

      // 投票
      if (la.some((a) => a.type === "vote")) {
        const me = view.you.seat;
        const mates = new Set(priv.teammates ?? []);
        const targets = values("vote").filter((t) => t !== me);
        const claims = parseSeerClaims(pub.today_says ?? []);

        if (role === "werewolf") {
          const seerTarget = claims
            .map((c) => c.claimant)
            .find((s) => !mates.has(s) && targets.includes(s));
          if (seerTarget !== undefined) {
            return done(submit, { type: "vote", target: seerTarget });
          }
          const t = targets.find((x) => !mates.has(x));
          if (t !== undefined) return done(submit, { type: "vote", target: t });
          return done(submit, { type: "pass" });
        }

        if (role === "seer") {
          const wolf = (priv.checks ?? []).find((c) => c.is_wolf && pub.alive_seats.includes(c.target));
          if (wolf) return done(submit, { type: "vote", target: wolf.target });
        }

        // 村民/预言家：投票——默认跟查杀；仅强证据（对跳+被查杀者明确自证）时反投跳报者
        const allSaysForVote = pub.today_says ?? [];
        const counterClaimForVote = hasCounterClaim(claims);
        const credibleKillForVote = claims.find(
          (c) => c.isWolf && c.checked !== me && pub.alive_seats.includes(c.checked),
        );
        if (credibleKillForVote) {
          const strongEvidence = counterClaimForVote && explicitSelfDefense(allSaysForVote, credibleKillForVote.checked);
          return done(submit, {
            type: "vote",
            target: strongEvidence ? credibleKillForVote.claimant : credibleKillForVote.checked,
          });
        }

        // 无狼查杀时：散票（集中投票会因 3/5 概率命中村民而恶化局势，66% 为散票基线）
        if (targets.length === 0) return done(submit, { type: "pass" });
        return done(submit, { type: "vote", target: targets[(me + pub.round + bias) % targets.length] });
      }

      return done(submit, { type: "pass" });
    },
  };
}
