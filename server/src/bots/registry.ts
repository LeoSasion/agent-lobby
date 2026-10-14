/**
 * House Bot 注册表：按游戏分配对应规则 bot（quickstart 补位用）
 * house bot 拥有固定 Agent 身份（house:<game>:<i>），参与 Elo 排名，作为实力基线
 */

import { createRuleBot } from "./rule-bot.ts";
import { createOthelloBot } from "./othello-bot.ts";
import { createWerewolfBot } from "./werewolf-bot.ts";
import { createHoldemBot } from "./holdem-bot.ts";
import { createDilemmaBot, type DilemmaStyle } from "./dilemma-bot.ts";
import type { SeatDriver } from "../arena/match.ts";

export interface HouseBot {
  driver: SeatDriver;
  agent: string;
  name: string;
}

const DICE_NAMES = ["谨慎", "均衡", "激进", "稳健", "灵活"];
const DICE_STYLES = [0.3, 0.5, 0.7, 0.45, 0.65];
const OTHELLO_NAMES = ["位置流", "吃子流", "蒸发流"];
const OTHELLO_STYLES: (0 | 1 | 2)[] = [0, 1, 2];
const WW_NAMES = ["冷静", "活跃", "沉默", "激进", "温和", "谨慎"];
const HOLDEM_NAMES = ["紧凶", "稳健", "松凶", "石墙"];
const HOLDEM_STYLES = [0.3, 0.5, 0.8, 0.15];
const DILEMMA_NAMES = ["一报还一报", "冷酷触发", "赢留输改", "老好人", "永久背叛"];
const DILEMMA_STYLES: DilemmaStyle[] = ["tft", "grim", "pavlov", "coop", "betray"];

export function houseBotsFor(gameId: string, count: number): HouseBot[] {
  const out: HouseBot[] = [];
  for (let i = 0; i < count; i++) {
    if (gameId === "othello") {
      const style = OTHELLO_STYLES[i % 3];
      const name = `house-othello-${i + 1}·${OTHELLO_NAMES[i % 3]}`;
      out.push({ driver: createOthelloBot(name, style), agent: `house:othello:${i + 1}`, name });
    } else if (gameId === "werewolf_lite") {
      const name = `house-ww-${i + 1}·${WW_NAMES[i % 6]}`;
      out.push({ driver: createWerewolfBot(name, i), agent: `house:werewolf_lite:${i + 1}`, name });
    } else if (gameId === "holdem_lite") {
      const name = `house-holdem-${i + 1}·${HOLDEM_NAMES[i % 4]}`;
      out.push({ driver: createHoldemBot(name, HOLDEM_STYLES[i % 4]), agent: `house:holdem_lite:${i + 1}`, name });
    } else if (gameId === "dilemma") {
      const style = DILEMMA_STYLES[i % 5];
      const name = `house-dilemma-${i + 1}·${DILEMMA_NAMES[i % 5]}`;
      out.push({ driver: createDilemmaBot(name, style), agent: `house:dilemma:${i + 1}`, name });
    } else {
      const name = `house-bot-${i + 1}·${DICE_NAMES[i % 5]}`;
      out.push({ driver: createRuleBot(name, DICE_STYLES[i % 5]), agent: `house:liars_dice:${i + 1}`, name });
    }
  }
  return out;
}
