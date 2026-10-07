/**
 * 比赛工厂 / 大厅雏形
 * 真正的匹配池（lobby/join、bot 补位、30s 等待）在 HTTP 网关层补充
 */

import type { GameModule } from "../games/types.ts";
import type { SeatId } from "../protocol.ts";
import { Match } from "./match.ts";
import type { SeatDriver } from "./match.ts";

export interface CreateMatchOptions {
  game: GameModule<unknown>;
  drivers: SeatDriver[];
  seed?: number;
  id?: string;
  timeoutMs?: number;
  graceMs?: number;
  minPhaseMs?: number;
}

/** 按驱动列表创建比赛（座位号 1..N），校验游戏座位数约束 */
export function createMatch(opts: CreateMatchOptions): Match {
  const { minSeats, maxSeats } = opts.game.meta;
  const n = opts.drivers.length;
  if (n < minSeats || n > maxSeats) {
    throw new Error(`${opts.game.meta.name} 需要 ${minSeats}-${maxSeats} 个座位，当前 ${n}`);
  }
  const map = new Map<SeatId, SeatDriver>();
  opts.drivers.forEach((d, i) => map.set(i + 1, d));
  return new Match({
    id: opts.id,
    game: opts.game,
    drivers: map,
    seed: opts.seed,
    timeoutMs: opts.timeoutMs,
    graceMs: opts.graceMs,
    minPhaseMs: opts.minPhaseMs,
  });
}
