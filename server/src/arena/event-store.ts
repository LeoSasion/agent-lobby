/**
 * 事件库：追加式事件日志（事件溯源，规划 §5.2 决策 1）
 * Match 状态 = 初始态 + 事件重放；回放/审计/观战进度条全部依赖这里
 */

import type { MatchEvent, SeatId } from "../protocol.ts";

export class EventStore {
  private events: MatchEvent[] = [];

  append(
    type: string,
    data: Record<string, unknown> = {},
    visibility: MatchEvent["visibility"] = "all",
  ): MatchEvent {
    const ev: MatchEvent = { seq: this.events.length, type, data, visibility };
    this.events.push(ev);
    return ev;
  }

  all(): readonly MatchEvent[] {
    return this.events;
  }

  since(cursor: number): MatchEvent[] {
    return this.events.filter((e) => e.seq > cursor);
  }

  /** 按 viewer 可见性过滤（观战者只看公共事件） */
  visibleTo(viewer: SeatId | "spectator"): MatchEvent[] {
    return this.events.filter((e) => {
      if (e.visibility === "all") return true;
      if (viewer === "spectator") return false;
      return e.visibility.seats.includes(viewer);
    });
  }

  countOf(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }

  /** 确定性比对用：事件序列（不含 seq 之外的运行时字段）的稳定哈希 */
  hash(): string {
    return hashEvents(this.events);
  }
}

export function hashEvents(events: readonly MatchEvent[]): string {
  let h = 5381;
  const s = JSON.stringify(
    events.map((e) => [e.type, e.data, e.visibility === "all" ? 0 : e.visibility.seats]),
  );
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
