import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { formatAge, isValidTimeZone, systemClock, weekendExcludedHours } from "../../src/core/time";

const at = (iso: string) => DateTime.fromISO(iso, { setZone: true });
const TORONTO = "America/Toronto";

describe("weekendExcludedHours", () => {
  it("counts a full weekday", () => {
    expect(weekendExcludedHours(at("2026-10-05T00:00-04:00"), at("2026-10-06T00:00-04:00"), TORONTO)).toBe(24);
  });

  it("excludes a whole weekend", () => {
    expect(weekendExcludedHours(at("2026-10-10T00:00-04:00"), at("2026-10-12T00:00-04:00"), TORONTO)).toBe(0);
  });

  it("spans Friday afternoon to Monday morning counting only weekday hours", () => {
    // Fri 16:00 → Sat 00:00 = 8h, Mon 00:00 → 10:00 = 10h
    expect(weekendExcludedHours(at("2026-10-09T16:00-04:00"), at("2026-10-12T10:00-04:00"), TORONTO)).toBe(18);
  });

  it("counts partial hours within a single day", () => {
    expect(weekendExcludedHours(at("2026-10-07T09:30-04:00"), at("2026-10-07T11:00-04:00"), TORONTO)).toBe(1.5);
  });

  it("returns 0 when end is not after start", () => {
    const t = at("2026-10-07T09:00-04:00");
    expect(weekendExcludedHours(t, t, TORONTO)).toBe(0);
    expect(weekendExcludedHours(t, t.minus({ hours: 5 }), TORONTO)).toBe(0);
  });

  it("counts a weekday's real length on DST change days", () => {
    // Jerusalem springs forward on Friday 2026-03-27 (23h day); Cairo falls back on Thursday 2026-10-29 (25h day).
    expect(weekendExcludedHours(at("2026-03-27T00:00+02:00"), at("2026-03-28T00:00+03:00"), "Asia/Jerusalem")).toBe(23);
    expect(weekendExcludedHours(at("2026-10-29T00:00+03:00"), at("2026-10-30T00:00+02:00"), "Africa/Cairo")).toBe(25);
  });

  it("is unaffected by a weekend DST change", () => {
    // Toronto springs forward on Sunday 2027-03-14: Sat 00:00 → Tue 00:00 holds exactly Mon's 24h.
    expect(weekendExcludedHours(at("2027-03-13T00:00-05:00"), at("2027-03-16T00:00-04:00"), TORONTO)).toBe(24);
  });

  it("throws on an invalid time zone instead of returning 0", () => {
    expect(() => weekendExcludedHours(at("2026-10-05T00:00Z"), at("2026-10-06T00:00Z"), "Eastern")).toThrow(
      'Invalid time zone "Eastern"',
    );
  });

  it("uses the owner's time zone for weekend boundaries", () => {
    // Fri 20:00 in Toronto is Sat 08:00 in Shanghai.
    const start = at("2026-10-09T20:00-04:00");
    const end = at("2026-10-09T22:00-04:00");
    expect(weekendExcludedHours(start, end, TORONTO)).toBe(2);
    expect(weekendExcludedHours(start, end, "Asia/Shanghai")).toBe(0);
  });
});

describe("formatAge", () => {
  it.each([
    [0, "<1h"],
    [0.99, "<1h"],
    [-3, "<1h"],
    [Number.NaN, "<1h"],
    [1, "1h"],
    [23.9, "23h"],
    [24, "1d"],
    [52, "2d 4h"],
    [24 * 7 - 1, "6d 23h"],
    [24 * 7, "1w"],
    [24 * 10, "1w 3d"],
    [24 * 35 + 5, "5w"],
  ])("formats %s hours as %s", (hours, expected) => {
    expect(formatAge(hours)).toBe(expected);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects anything else", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("systemClock", () => {
  it("returns the current time in UTC", () => {
    const now = systemClock.now();
    expect(now.zoneName).toBe("UTC");
    expect(Math.abs(now.toMillis() - Date.now())).toBeLessThan(60_000);
  });
});
