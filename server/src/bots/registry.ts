/**
 * House Bot 注册表：按游戏分配对应规则 bot（quickstart 补位用）
 * house bot 拥有固定 Agent 身份（house:<game>:<i>），参与 Elo 排名，作为实力基线
 */

import { createRuleBot } from "./rule-bot.ts";
import { createOthelloBot } from "./othello-bot.ts";
import { createWerewolfBot } from "./werewolf-bot.ts";
import { createHoldemBot } from "./holdem-bot.ts";
import { createDilemmaBot, type DilemmaStyle } from "./dilemma-bot.ts";
import { createUndercoverBot } from "./undercover-bot.ts";
import { createAuctionBot } from "./auction-bot.ts";
import { createTurtleBot } from "./turtle-bot.ts";
import { createGomokuBot } from "./gomoku-bot.ts";
import { createJungleBot } from "./jungle-bot.ts";
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
const AUCTION_NAMES = ["谨慎", "均衡", "激进", "极限", "收敛", "试探"];
const AUCTION_RATIOS = [0.5, 0.75, 0.92, 1.0, 0.65, 0.85];
const TURTLE_NAMES = ["冷静", "好奇", "固执", "跳脱", "细致", "急躁"];
const GOMOKU_NAMES = ["沉稳", "进攻", "均衡"];
const GOMOKU_AGGRESSION = [0.7, 1.0, 0.9];
const JUNGLE_NAMES = ["稳健", "凶狠", "保守"];
const JUNGLE_CAUTION = [1.0, 0.6, 1.4];

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
    } else if (gameId === "undercover") {
      const name = `house-uc-${i + 1}·直觉${i + 1}`;
      out.push({ driver: createUndercoverBot(name, i), agent: `house:undercover:${i + 1}`, name });
    } else if (gameId === "jungle_chess") {
      const name = `house-jungle-${i + 1}·${JUNGLE_NAMES[i % 3]}`;
      out.push({ driver: createJungleBot(name, JUNGLE_CAUTION[i % 3]), agent: `house:jungle_chess:${i + 1}`, name });
    } else if (gameId === "gomoku") {
      const name = `house-gomoku-${i + 1}·${GOMOKU_NAMES[i % 3]}`;
      out.push({ driver: createGomokuBot(name, GOMOKU_AGGRESSION[i % 3]), agent: `house:gomoku:${i + 1}`, name });
    } else if (gameId === "turtle_soup") {
      const name = `house-turtle-${i + 1}·${TURTLE_NAMES[i % 6]}`;
      out.push({ driver: createTurtleBot(name, i), agent: `house:turtle_soup:${i + 1}`, name });
    } else if (gameId === "auction") {
      const ratio = AUCTION_RATIOS[i % 6];
      const name = `house-auction-${i + 1}·${AUCTION_NAMES[i % 6]}`;
      out.push({ driver: createAuctionBot(name, ratio), agent: `house:auction:${i + 1}`, name });
    } else {
      const name = `house-bot-${i + 1}·${DICE_NAMES[i % 5]}`;
      out.push({ driver: createRuleBot(name, DICE_STYLES[i % 5]), agent: `house:liars_dice:${i + 1}`, name });
    }
  }
  return out;
}
