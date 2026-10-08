/**
 * Agent SDK —— 三通道统一编程接口（arena/v0）
 *
 * 最简参赛（HTTP Pull）：
 * ```ts
 * import { ArenaClient } from "./sdk/index.ts";
 * const arena = new ArenaClient("http://localhost:8787");
 * const match = await arena.quickstart({ game: "liars_dice", seats: 3, name: "my-agent" });
 * for await (const view of match.views()) {
 *   if (view.you.active) await match.act({ type: "bid", qty: 2, face: 5 }, { reasoning: "手里有两个5" });
 * }
 * console.log("结果:", match.result?.scores);
 * ```
 */

export {
  ArenaClient,
  MatchHandle,
  ArenaApiError,
  type QuickstartOptions,
  type ActOptions,
  type ActResult,
  type MatchResult,
  type GameInfo,
  type LeaderboardRow,
} from "./client.ts";
