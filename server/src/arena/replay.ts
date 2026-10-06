/**
 * 事件重放：match_started(seed) + acted 序列 → 重建终局与游戏事件
 * 确定性验证的依据（规划 §5.2 决策 1/2：事件溯源 + 确定性随机）
 */

import type { Action, MatchEvent, SeatId } from "../protocol.ts";
import type { GameModule } from "../games/types.ts";
import { mulberry32 } from "../rng.ts";
import type { RecordedGameEvent } from "./match.ts";

export interface ReplayResult {
  scores: Record<SeatId, number>;
  gameEvents: RecordedGameEvent[];
}

export function replayEvents(
  game: GameModule<unknown>,
  events: readonly MatchEvent[],
): ReplayResult {
  const started = events.find((e) => e.type === "match_started");
  if (!started) throw new Error("回放失败：缺少 match_started 事件");
  const seed = started.data.seed as number;
  const seats = started.data.seats as SeatId[];
  const rng = mulberry32(seed);
  let state: unknown = game.init(seats, rng);
  const gameEvents: RecordedGameEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "acted") continue;
    const seat = ev.data.seat as SeatId;
    const action = ev.data.action as Action;
    const res = game.apply(state, seat, action, rng);
    state = res.state;
    for (const g of res.events) {
      gameEvents.push({ type: g.type, data: g.data ?? {} });
    }
  }
  return { scores: game.scores(state), gameEvents };
}

/** 回放到指定事件序号（含），返回该时刻的状态——视角切换回放的服务端基础 */
export function replayToState(
  game: GameModule<unknown>,
  events: readonly MatchEvent[],
  uptoSeq: number,
): { state: unknown; terminal: boolean } {
  const started = events.find((e) => e.type === "match_started");
  if (!started) throw new Error("回放失败：缺少 match_started 事件");
  const rng = mulberry32(started.data.seed as number);
  const seats = started.data.seats as SeatId[];
  let state: unknown = game.init(seats, rng);
  for (const ev of events) {
    if (ev.seq > uptoSeq) break;
    if (ev.type !== "acted") continue;
    const res = game.apply(state, ev.data.seat as SeatId, ev.data.action as Action, rng);
    state = res.state;
  }
  return { state, terminal: game.isTerminal(state) };
}
