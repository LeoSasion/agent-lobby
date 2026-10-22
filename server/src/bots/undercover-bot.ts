/**
 * 谁是卧底 House Bot —— 类别模板描述 + 确定性启发投票
 * 描述：从词的类别生成模糊描述（「跟吃的有关」「一种动物」…）——近似词对天然同类，
 *   平民与卧底的描述风格一致（模拟真人模糊表达，且绝不泄词）
 * 投票：无语义理解——hash(seat:round:候选) 确定性选择 + 卧底自保偏置（不投自己）；
 *   平民 bot 有小概率投「被放逐者已证实为平民后仍在票池的怪异目标」？v0 从简：确定性 hash
 * 全部确定性（禁 Math.random 纪律），同 seed 回放逐字一致
 */

import type { Action, AgentView } from "../protocol.ts";
import type { SeatDriver } from "../arena/match.ts";
import { wordPairs } from "../games/undercover.ts";

interface UCViewPublic {
  round: number;
  phase: "describe" | "vote" | "finished";
  seats: number[];
  alive_seats: number[];
  today_describes: { seat: number; text: string }[];
  exiled_log: { seat: number; role: string }[];
  pk_candidates: number[] | null;
}

/** 类别 → 模糊描述模板（不泄词） */
const CAT_TEMPLATES: Record<string, string[]> = {
  "水果": ["跟吃的有关，甜的", "树上长的，能吃", "水果摊上常见"],
  "饮品": ["喝的东西", "提神用的", "杯子里的东西"],
  "运动": ["跟体育有关", "要用到球", "出汗的活动"],
  "交通": ["出行工具", "每天通勤会用", "路上常见的"],
  "电子设备": ["带屏幕的", "要充电的", " modern 的玩意儿"],
  "职业": ["一种工作", "穿特定服装的", "跟医院/学校沾边"],
  "餐具": ["吃饭用的", "餐桌上的物件", "跟嘴有关"],
  "雨具": ["下雨天用的", "防水的", "包里常备"],
  "动物": ["一种动物", "有毛的", "会叫的生物"],
  "季节": ["一年里的某段时光", "跟天气有关", "有特有的风景"],
  "日子": ["一年里的特别一天", "会有活动", "值得纪念"],
  "食物": ["能吃的", "跟烘焙有关", "甜品店的货"],
  "家具": ["家里的物件", "能坐能躺", "客厅常见"],
  "文具": ["学习用品", "写字画画的", "文具店有卖"],
  "馈赠": ["表达心意的东西", "喜庆场合出现", "包起来的"],
  "影像": ["屏幕上看的", "实时或不实时", "跟画面有关"],
  "场所": ["一个地方", "室内空间", "要安静待着"],
  "垂直通行": ["上下楼用的", "跟高度有关", "建筑里常见"],
  "日用品": ["每天用的", "洗漱相关", "浴室里的"],
  /* r26-a 词对库扩容新增类别 */
  "服饰": ["身上穿戴的", "保暖或装饰用", "衣柜里的"],
  "家电": ["家里的大件电器", "要插电的", "客厅卧室都可能有"],
  "乐器": ["跟音乐有关", "要用手或嘴演奏", "会出声的物件"],
};

/** 全类别模板池：词未被词对库收录时退化用它（模块级常量——此前每次描述都 flat 一遍 66 条） */
const ALL_TEMPLATES = Object.values(CAT_TEMPLATES).flat();

/** 词 → 类别（词对里的两个词同类别）。用于让 bot 的描述与自己的词同域——
 *  此前描述从 22 个类别的 66 条模板里全池抽，约 95% 的概率描述与自己词的类别无关
 *  （拿到「电梯」却描述「一种动物」），对真人观战是纯噪声。 */
const WORD_CAT = new Map<string, string>(
  wordPairs().flatMap((p) => [[p.c, p.cat], [p.u, p.cat]] as [string, string][]),
);

/** 同类别模板只有 3 条，6 席必撞车；座位化语气前缀拉开区分度（不含词、不泄密） */
const WRAPPERS = ["", "嗯——", "简单说，", "让我想想，", "大概就是", "我这么说吧，"];

/** 简单确定性 hash（同 seed 回放一致） */
function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0) / 4294967295;
}

export function createUndercoverBot(name: string, idx: number): SeatDriver {
  const myCatKey = `cat-${idx}`;

  return {
    name,
    act: async (view: AgentView, submit) => {
      const pub = view.public as unknown as UCViewPublic;
      const me = view.you.seat;
      const priv = view.private as { word?: string };

      if (pub.phase === "describe") {
        // 描述：按自己词的类别取模板池（词对两词同类别，故平民/卧底同池——不构成身份泄露），
        // 未收录的词退化到全池。绝不出现词本身（description 含词会被内核 422）。
        const word = priv.word ?? "";
        const cat = WORD_CAT.get(word);
        const pool = (cat !== undefined ? CAT_TEMPLATES[cat] : undefined) ?? ALL_TEMPLATES;
        const core = pool[Math.floor(h(`${myCatKey}:${cat ?? "-"}:${word.length}:${pub.round}`) * pool.length)]
          ?? "跟我拿到的词有关";
        const wrapper = WRAPPERS[Math.floor(h(`${cat ?? "-"}:${me}:${pub.round}`) * WRAPPERS.length)] ?? "";
        return void (await submit({ type: "describe", text: wrapper + core } satisfies Action, {
          reasoning: "按词的类别作模糊联想描述（只知道自己拿到的词，不预设身份）",
        }));
      }

      if (pub.phase === "vote") {
        const pool = pub.pk_candidates ?? pub.alive_seats.filter((t) => t !== me);
        if (pool.length === 0) return void (await submit({ type: "pass" } satisfies Action, { reasoning: "无可投目标" }));
        // 确定性 hash 投票 + 卧底自保（绝不投自己）；被证实为平民的出局者天然不在存活池
        const target = pool[Math.floor(h(`${me}:${pub.round}:${pool.join(",")}`) * pool.length)]!;
        return void (await submit({ type: "vote", target } satisfies Action, {
          reasoning: "凭描述的直觉投票（谁的描述最含糊投谁）",
        }));
      }

      await submit({ type: "pass" } satisfies Action, { reasoning: "非行动相位" });
    },
  };
}
