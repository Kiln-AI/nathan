import { DateTime, type DurationLike } from "luxon";
import type { Clock } from "../../src/core/time";

/** Monday 2026-10-05 14:00 UTC (10:00 in Toronto). */
export const DEFAULT_NOW = "2026-10-05T14:00:00Z";

export class FakeClock implements Clock {
  private current: DateTime;

  constructor(start: string | DateTime = DEFAULT_NOW) {
    this.current = toUtc(start);
  }

  now(): DateTime {
    return this.current;
  }

  set(time: string | DateTime): void {
    this.current = toUtc(time);
  }

  advance(duration: DurationLike): void {
    this.current = this.current.plus(duration);
  }
}

function toUtc(time: string | DateTime): DateTime {
  const parsed = typeof time === "string" ? DateTime.fromISO(time, { setZone: true }) : time;
  if (!parsed.isValid) throw new Error(`Invalid time: ${String(time)}`);
  return parsed.toUTC();
}
