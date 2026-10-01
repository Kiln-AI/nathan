import { DateTime, IANAZone } from "luxon";

/** The only source of "now". Production uses `systemClock`; tests inject a fake. */
export interface Clock {
  now(): DateTime;
}

export const systemClock: Clock = {
  now: () => DateTime.utc(),
};

const MS_PER_HOUR = 3_600_000;

export function isValidTimeZone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

/**
 * Hours in [start, end) that fall on Monday–Friday in `tz`.
 * Walks local calendar days, so 23h and 25h DST days count their real length.
 */
export function weekendExcludedHours(start: DateTime, end: DateTime, tz: string): number {
  if (!isValidTimeZone(tz)) throw new Error(`Invalid time zone "${tz}"`);
  if (end <= start) return 0;
  const endLocal = end.setZone(tz);
  let day = start.setZone(tz).startOf("day");
  let weekdayMs = 0;
  while (day < endLocal) {
    const nextDay = day.plus({ days: 1 });
    if (day.weekday <= 5) {
      const from = Math.max(day.toMillis(), start.toMillis());
      const to = Math.min(nextDay.toMillis(), end.toMillis());
      weekdayMs += Math.max(0, to - from);
    }
    day = nextDay;
  }
  return weekdayMs / MS_PER_HOUR;
}

/** Compact age using the two largest units: "<1h", "3h", "2d 4h", "1w 3d", "5w". */
export function formatAge(hours: number): string {
  if (!(hours >= 1)) return "<1h";
  const totalHours = Math.floor(hours);
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  if (days < 7) return joinUnits(days, "d", totalHours % 24, "h");
  return joinUnits(Math.floor(days / 7), "w", days % 7, "d");
}

function joinUnits(major: number, majorUnit: string, minor: number, minorUnit: string): string {
  return minor > 0 ? `${major}${majorUnit} ${minor}${minorUnit}` : `${major}${majorUnit}`;
}
