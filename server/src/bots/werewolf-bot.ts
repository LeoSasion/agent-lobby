/**
 * 狼人杀角色感知 House Bot —— 社交推理 + 人格化发言版
 * 能力：
 *   1. 人格化发言：6 人格（冷静/活跃/沉默/激进/温和/谨慎，与 registry WW_NAMES 对齐）
 *      发言 = 情境语义核心（角色 × 场上态势 × 回合上下文）× 人格语气（垫语/句式/长短）
 *   2. 遗言：预言家遗言公开全部查验（好人信息补偿）；村民/狼各有遗言话术
 *   3. 解析 today_says 的报查验（含遗言中的查验），村民跟查杀、狼人反跳/搅局
 *   4. 狼人夜间优先刀已跳预言家的人
 * 确定性：所有模板选择走 hash(seat:round:情境) —— 不用 Math.random，同 seed 回放逐字一致
 * 正则契约：报查验句式「验了 N 号，是狼人/是好人」；自证句式必含「不是狼」——不得拆散改写
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
  today_says: { seat: number; text: string; kind?: string }[];
  last_day_says: { seat: number; text: string }[];
  pk_candidates: number[] | null;
}

interface SeerClaim {
  claimant: number;
  checked: number;
  isWolf: boolean;
}

/** ---------- 确定性选择器（FNV-1a；同 key 恒同结果，保回放确定性） ---------- */
function pick<T>(arr: T[], key: string): T {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return arr[Math.abs(h) % arr.length];
}

/** ---------- 解析 ---------- */

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

/** ---------- 人格语气库（index = bias % 6，与 registry WW_NAMES 对齐） ---------- */

interface Persona {
  /** 无信息填充话术：round 1 / round 2+ 各一组——这是最重复的场景，人格分化主战场 */
  fillerR1: string[];
  fillerR2: string[];
  /** 语气垫语（可叠加在语义核心前；留空占比高，避免句句带帽子） */
  openers: string[];
}

const PERSONAS: Persona[] = [
  {
    // 冷静：分析腔
    fillerR1: ["我是平民。目前公开信息有限，我倾向听完所有人发言再做判断。", "平民。第一天没有查验就是最大的信息，谁急着带节奏谁才可疑。"],
    fillerR2: ["我是平民。局面在收敛，我把昨天的发言和今天的遗言对照过了，暂时不站边。", "平民视角：存活人数越少，每一票越重。我不投没有证据的人。"],
    openers: ["从场面看，", "理性地说，", ""],
  },
  {
    // 活跃：热场腔
    fillerR1: ["大家好呀，我是普通村民！第一晚信息还很少，期待预言家站出来给信息！", "村民报到！昨晚的事大家都看到了吧，谁有查验赶紧说，别憋着！"],
    fillerR2: ["我是村民！场上人越来越少了，都别藏着掖着，有信息快摊开讲！", "嗨，还在的各位！我是好人，这轮必须投出个狼来，别再空过一天！"],
    openers: ["说真的，", "我直讲了啊——", ""],
  },
  {
    // 沉默：短句腔
    fillerR1: ["平民。先听。", "我好人。信息少，过。"],
    fillerR2: ["平民。还在听。", "好人。投票前给个查验，否则我弃。"],
    openers: ["", "", ""],
  },
  {
    // 激进：推进腔
    fillerR1: ["我是平民，别磨蹭——有查验就快点报，没有今天谁也别想混过去！", "平民。我话放这：第一天不敢表态的人，晚上最该被盯。"],
    fillerR2: ["我是好人，别再拖了！每空一轮狼就多刀一个，今天必须投出结果！", "平民。我都听够了，没有查验就全凭发言投票，谁虚谁出局！"],
    openers: ["我不想绕弯子，", "直接说——", ""],
  },
  {
    // 温和：软化腔
    fillerR1: ["我是好人哈，大家慢慢说，我都听着呢，别吵起来～", "平民一枚。第一天嘛，互相多包容，信息明天自然就出来了。"],
    fillerR2: ["我是好人哈。虽然局势紧，但也请大家别互相误伤，投票前多想一下～", "平民。大家都不容易，把信息摊开讲清楚，别凭感觉投人。"],
    openers: ["我个人觉得，", "这么说吧，", ""],
  },
  {
    // 谨慎：对冲腔
    fillerR1: ["我是平民……信息太少了，我先不站边，再观察一轮。", "好人。第一天的发言我都不敢全信，包括遗言，先留个心眼。"],
    fillerR2: ["我是平民……现在下结论还太早，我保守起见跟大方向，不带头。", "好人。局势扑朔迷离，我建议投票以查验为准，没查验宁可不投。"],
    openers: ["我拿不太准，", "保守一点讲，", ""],
  },
];

/** 语义核心前叠加人格垫语（契约短语不被拆散：垫语只出现在整句前） */
function flavor(p: Persona, core: string, key: string): string {
  const opener = pick(p.openers, key + "|op");
  return opener + core;
}

function done(
  submit: (a: Action, opts?: { reasoning?: string }) => { ok: boolean },
  action: Action,
): void {
  submit(action);
}

export function createWerewolfBot(name: string, bias = 0): SeatDriver {
  const persona = PERSONAS[((bias % PERSONAS.length) + PERSONAS.length) % PERSONAS.length];
  return {
    name,
    act: async (view: AgentView, submit) => {
      const priv = view.private as unknown as WWPrivate;
      const pub = view.public as unknown as WWPublic;
      const role = priv.role ?? "villager";
      const me = view.you.seat;
      const round = pub.round ?? 1;
      const mid = String(view.match_id ?? "m"); // 局标识入 salt：跨局话术分化、局内确定性
      const la = view.legal_actions;
      const values = (t: string): number[] =>
        ((la.find((a) => a.type === t)?.schema?.values ?? []) as unknown[]).filter(
          (v): v is number => typeof v === "number",
        );
      const k = (ctx: string): string => `${mid}:${me}:${round}:${ctx}`;

      // 夜间：狼出刀（优先刀已跳预言家的——含昨日发言与今日遗言）
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

      // 遗言：预言家公开全部查验（信息补偿核心）；狼搅局；村民托付
      if (la.some((a) => a.type === "last_words")) {
        if (role === "seer") {
          const cs = priv.checks ?? [];
          if (cs.length === 0) {
            return done(submit, {
              type: "last_words",
              text: "我是预言家……还没来得及验人。请大家警惕今天跳预言家的人，别让狼白刀我一场。",
            });
          }
          const detail = cs.map((c) => `验了 ${c.target} 号，${c.is_wolf ? "是狼人" : "是好人"}`).join("；");
          return done(submit, {
            type: "last_words",
            text: `我是预言家，这是我的遗言：我${detail}。好人阵营请记住这些信息，别让狼人白刀我。`,
          });
        }
        if (role === "werewolf") {
          return done(submit, {
            type: "last_words",
            text: pick(
              [
                "行，你们投吧。我是好人，投错我也不怪你们——反正狼今晚还会动手。",
                "我是普通村民……你们会后悔的。好人都沉默，狼在笑。",                "遗言就一句：带我走的人，今晚盯紧他。",
              ],
              k("lw-wolf"),
            ),
          });
        }
        return done(submit, {
          type: "last_words",
          text: pick(
            [
              "我平民一个，死得冤。别浪费我的遗言——把票投给真正可疑的人。",
              "我是好人……希望我的死能让你们看清谁是狼。",
              "平民遗言：别内耗，狼在看笑话。跟住查验信息。",
            ],
            k("lw-villager"),
          ),
        });
      }

      // 白天发言：情境 → 语义核心；人格 → 语气
      if (la.some((a) => a.type === "say")) {
        const claims = parseSeerClaims(pub.today_says ?? []);
        const hasLW = (pub.today_says ?? []).some((s) => s.kind === "last_words");

        if (role === "seer") {
          const cs = priv.checks ?? [];
          const c = cs[cs.length - 1];
          if (!c) {
            return done(submit, { type: "say", text: "我是预言家，昨晚没有验人。信息后续补上，请大家先稳住。" });
          }
          const verdict = c.is_wolf ? "是狼人！" : "是好人。";
          const core = pick(
            [
              `我是预言家。昨晚验了 ${c.target} 号，${verdict}这一票请大家跟我走。`,
              `预言家在此。我的查验：昨晚验了 ${c.target} 号，${verdict}之后每晚我都会更新信息。`,
              `听好——我是预言家，昨晚验了 ${c.target} 号，${verdict}请记下这条信息再投票。`,
            ],
            k("seer-claim"),
          );
          return done(submit, { type: "say", text: flavor(persona, core, k("seer-claim")) });
        }

        if (role === "werewolf") {
          const mates = new Set(priv.teammates ?? []);
          const killTarget = claims.find((c) => c.isWolf && mates.has(c.checked));

          // 狼本人被查杀：装村民自辩（沉默穿帮——契约句式「不是狼」必说）
          const accusedMeWolf = claims.find((c) => c.isWolf && c.checked === me);
          if (accusedMeWolf && !killTarget) {
            const core = pick(
              [
                `${accusedMeWolf.claimant} 号查杀我？我不是狼。我是好人，他这么急着定罪一个人，反而最像悍跳狼。`,
                `查杀到我头上了——我不是狼，真查验经不起对。${accusedMeWolf.claimant} 号，你敢不敢今晚让刀口证明？`,
                `我不是狼。${accusedMeWolf.claimant} 号的查验是编的，好人别内耗，真预言家应该能对出漏洞。`,
              ],
              k("wolf-self"),
            );
            return done(submit, { type: "say", text: flavor(persona, core, k("wolf-self")) });
          }
          if (killTarget) {
            const core = pick(
              [
                `我是个平民。${killTarget.claimant} 号这个"预言家"查得也太准了吧？我反而怀疑他是狼悍跳，${killTarget.checked} 号先别急着定罪。`,
                `有点意思，${killTarget.claimant} 号一跳就查杀，矛头直指 ${killTarget.checked} 号。真预言家会这么巧？我保留意见。`,
                `我是好人。这查验我不信——${killTarget.claimant} 号在带节奏，大家小心，别被一句话送走好人。`,
              ],
              k("wolf-deflect"),
            );
            return done(submit, { type: "say", text: flavor(persona, core, k("wolf-deflect")) });
          }
          // 无人被查杀时的填充话术：有跳报 → 围绕信息表态（不说"期待预言家站出来"这种穿帮句）
          if (claims.length > 0) {
            const claimer = claims[0]!.claimant;
            const core = pick(
              [
                `${claimer} 号跳了预言家。我是平民，先看他的查验内容经不经得起后面几晚的验证。`,
                `${claimer} 号自称预言家——我是好人，暂记这条信息，明晚的刀口会替我们分辨真假。`,
                `场上有人跳预言家了。我是平民，不急着站边，听完他的查验理由再说。`,
              ],
              k("wolf-claimed"),
            );
            return done(submit, { type: "say", text: flavor(persona, core, k("wolf-claimed")) });
          }
          const filler = round <= 1 ? persona.fillerR1 : persona.fillerR2;
          return done(submit, { type: "say", text: pick(filler, k("wolf-filler")) });
        }

        // 村民：被查杀 → 自证清白（契约：必含"不是狼"）
        const accusedMe = claims.find((c) => c.isWolf && c.checked === me);
        if (accusedMe) {
          const core = pick(
            [
              `${accusedMe.claimant} 号查杀我？我不是狼！我是好人，${accusedMe.claimant} 号八成是狼悍跳，大家别被带偏。`,
              `我真的不是狼。${accusedMe.claimant} 号这个查验有假——好人不要自相残杀，今天该查的是他。`,
              `被查杀了，我只能再说一次：我不是狼。真预言家若有别的查验，请立刻站出来对信息。`,
            ],
            k("v-defend"),
          );
          return done(submit, { type: "say", text: flavor(persona, core, k("v-defend")) });
        }

        // 村民：评估跳报可信度
        const allSays = pub.today_says ?? [];
        const counterClaim = hasCounterClaim(claims);
        const credibleKill = claims.find(
          (c) => c.isWolf && c.checked !== me && pub.alive_seats.includes(c.checked),
        );
        if (credibleKill) {
          if (counterClaim) {
            const core = pick(
              [
                `有对跳，${credibleKill.claimant} 号和被查杀的 ${credibleKill.checked} 号各执一词，必有至少一狼。我先各听一轮，票不慌投。`,
                `对跳局面最忌乱投：${credibleKill.claimant} 号与 ${credibleKill.checked} 号里藏狼，今天的信息还不够定罪。`,
                `${credibleKill.claimant} 号、${credibleKill.checked} 号互指——典型对跳。我观望，谁露破绽投谁。`,
              ],
              k("v-counter"),
            );
            return done(submit, { type: "say", text: flavor(persona, core, k("v-counter")) });
          }
          if (explicitSelfDefense(allSays, credibleKill.checked)) {
            const core = pick(
              [
                `${credibleKill.claimant} 号查杀 ${credibleKill.checked} 号，但对方明确否认了。单方面查验不足为凭，我再看看。`,
                `${credibleKill.checked} 号不认这个查杀，${credibleKill.claimant} 号也没第二验佐证。证据不够，我保持怀疑。`,
              ],
              k("v-skeptic"),
            );
            return done(submit, { type: "say", text: flavor(persona, core, k("v-skeptic")) });
          }
          const core = pick(
            [
              `我认可 ${credibleKill.claimant} 号的查验，${credibleKill.checked} 号是狼。今天这票请大家集中放逐，别分散。`,
              `信 ${credibleKill.claimant} 号。${credibleKill.checked} 号是狼，跟票，别让查验信息浪费掉。`,
              `${credibleKill.claimant} 号敢跳就有底气。我跟他：${credibleKill.checked} 号，出局。`,
            ],
            k("v-endorse"),
          );
          return done(submit, { type: "say", text: flavor(persona, core, k("v-endorse")) });
        }

        // 无信息填充：按场景分化——今日有遗言 / 已有人跳预言家 / 常规（round 1 vs 2+，人格话术）
        let text: string;
        if (hasLW && round <= 1) {
          text = pick(
            [
              "听完遗言了。我是好人——死者的信息要么是真相要么是圈套，投票前先对一对。",
              "刚听完遗言。预言家的查验遗言值得认真记下；假遗言也会露马脚。我是好人。",
              "遗言都收到了。我是好人，投票看查验不看嗓门，别让真信息被带跑。",
            ],
            k("v-lw"),
          );
        } else if (claims.length > 0) {
          const claimer = claims[0]!.claimant;
          text = pick(
            [
              `${claimer} 号跳了预言家。我是好人，先记下查验内容，跟信息投票，不跟感觉。`,
              `${claimer} 号站出来了——我是好人，这正是我们要的信息，先看他敢不敢连续两晚报查验。`,
              `有人跳预言家了，我是好人。信息已经开始流动，接下来对不上号的人最可疑。`,
            ],
            k("v-claimed"),
          );
        } else {
          const filler = round <= 1 ? persona.fillerR1 : persona.fillerR2;
          text = pick(filler, k("v-filler"));
        }
        return done(submit, { type: "say", text });
      }

      // 投票
      if (la.some((a) => a.type === "vote")) {
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

        // 村民/预言家：默认跟查杀；仅强证据（对跳+被查杀者明确自证）时反投跳报者
        const allSaysForVote = pub.today_says ?? [];
        const counterClaimForVote = hasCounterClaim(claims);
        const credibleKillForVote = claims.find(
          (c) => c.isWolf && c.checked !== me && pub.alive_seats.includes(c.checked),
        );
        if (credibleKillForVote) {
          const strongEvidence =
            counterClaimForVote && explicitSelfDefense(allSaysForVote, credibleKillForVote.checked);
          return done(submit, {
            type: "vote",
            target: strongEvidence ? credibleKillForVote.claimant : credibleKillForVote.checked,
          });
        }

        // 无狼查杀时：散票（集中投票会因 3/5 概率命中村民而恶化局势，66% 为散票基线）
        // 公式 (me+bias+round)%len：bot 席位间天然互碰撞最小（r4b 实测 hash 散票引发随机放逐 → 狼胜率 76%）
        if (targets.length === 0) return done(submit, { type: "pass" });
        return done(submit, { type: "vote", target: targets[(me + pub.round + bias) % targets.length] });
      }

      return done(submit, { type: "pass" });
    },
  };
}
