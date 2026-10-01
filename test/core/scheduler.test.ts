import { env } from "cloudflare:workers";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { createDb } from "../../src/core/db";
import type { ReportError } from "../../src/core/errors";
import {
  floorToTick,
  latestFireAtOrBefore,
  type Schedule,
  type ScheduledTask,
  Scheduler,
  validateSchedule,
} from "../../src/core/scheduler";

const utc = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });
const REPORT: Schedule = { at: "09:30", tz: "America/New_York", days: "weekdays" };

describe("latestFireAtOrBefore", () => {
  it("everyHour: the top of the current UTC hour", () => {
    expect(latestFireAtOrBefore({ everyHour: true }, utc("2026-10-05T14:45:00")).toISO()).toBe(
      "2026-10-05T14:00:00.000Z",
    );
  });

  it("at: today's slot once it has passed, otherwise the previous matching day", () => {
    // Tue 2026-10-06; 09:30 EDT = 13:30 UTC.
    expect(latestFireAtOrBefore(REPORT, utc("2026-10-06T13:30:00")).toISO()).toBe("2026-10-06T13:30:00.000Z");
    expect(latestFireAtOrBefore(REPORT, utc("2026-10-06T13:29:00")).toISO()).toBe("2026-10-05T13:30:00.000Z");
  });

  it("weekdays: skips back over the weekend", () => {
    // Mon 2026-10-12 08:00 EDT → Friday's slot. Sunday → Friday too.
    expect(latestFireAtOrBefore(REPORT, utc("2026-10-12T12:00:00")).toISO()).toBe("2026-10-09T13:30:00.000Z");
    expect(latestFireAtOrBefore(REPORT, utc("2026-10-11T20:00:00")).toISO()).toBe("2026-10-09T13:30:00.000Z");
  });

  it("everyday: includes weekends", () => {
    const daily: Schedule = { at: "09:30", tz: "America/New_York", days: "everyday" };
    expect(latestFireAtOrBefore(daily, utc("2026-10-11T20:00:00")).toISO()).toBe("2026-10-11T13:30:00.000Z");
  });

  it("follows local time across daylight saving changes", () => {
    // 09:30 EST is 14:30 UTC; the switch back to EST happens on Sunday 2026-11-01.
    expect(latestFireAtOrBefore(REPORT, utc("2026-10-30T23:00:00")).toISO()).toBe("2026-10-30T13:30:00.000Z");
    expect(latestFireAtOrBefore(REPORT, utc("2026-11-02T23:00:00")).toISO()).toBe("2026-11-02T14:30:00.000Z");
  });

  it("uses the schedule's own time zone for the day of week", () => {
    // 01:00 Saturday in Shanghai is still Friday in UTC; the weekday slot is Friday's.
    const shanghai: Schedule = { at: "00:30", tz: "Asia/Shanghai", days: "weekdays" };
    expect(latestFireAtOrBefore(shanghai, utc("2026-10-09T17:00:00")).toISO()).toBe("2026-10-08T16:30:00.000Z");
  });
});

describe("validateSchedule", () => {
  it.each(["9:30", "24:00", "09:60", "0930", ""])("rejects the time %j", (at) => {
    expect(() => validateSchedule({ at, tz: "UTC", days: "everyday" })).toThrow("expected HH:MM");
  });

  it("rejects an unknown time zone", () => {
    expect(() => validateSchedule({ at: "09:30", tz: "Eastern", days: "everyday" })).toThrow("time zone");
  });

  it("accepts valid schedules", () => {
    expect(() => validateSchedule({ everyHour: true })).not.toThrow();
    expect(() => validateSchedule({ at: "23:59", tz: "UTC", days: "weekdays" })).not.toThrow();
  });
});

describe("floorToTick", () => {
  it("floors to the 15-minute tick", () => {
    expect(floorToTick(utc("2026-10-05T14:29:59.999")).toISO()).toBe("2026-10-05T14:15:00.000Z");
    expect(floorToTick(utc("2026-10-05T14:30:00")).toISO()).toBe("2026-10-05T14:30:00.000Z");
  });
});

describe("Scheduler.tick", () => {
  function setup() {
    const reported: { error: unknown; source: string }[] = [];
    const reportError: ReportError = async (error, { source }) => {
      reported.push({ error, source });
    };
    const scheduler = new Scheduler({ db: createDb(env.DB), reportError });
    const runs: Record<string, string[]> = {};
    const add = (name: string, when: Schedule, run?: ScheduledTask["run"]) => {
      runs[name] = [];
      scheduler.add({
        name,
        when,
        run:
          run ??
          (async ({ firedAt }) => {
            runs[name]?.push(firedAt.toISO() ?? "");
          }),
      });
    };
    const tick = (iso: string) => scheduler.tick(utc(iso));
    return { scheduler, add, tick, runs, reported };
  }

  it("rejects duplicate names and invalid schedules", () => {
    const { scheduler, add } = setup();
    add("a", { everyHour: true });
    expect(() => scheduler.add({ name: "a", when: { everyHour: true }, run: async () => {} })).toThrow(
      'Scheduled task "a" is already defined',
    );
    expect(() =>
      scheduler.add({ name: "b", when: { at: "25:00", tz: "UTC", days: "everyday" }, run: async () => {} }),
    ).toThrow();
  });

  it("runs an hourly task on the top-of-hour tick, once", async () => {
    const { add, tick, runs } = setup();
    add("hourly", { everyHour: true });
    await tick("2026-10-05T14:00:07");
    await tick("2026-10-05T14:15:00");
    await tick("2026-10-05T14:45:00");
    await tick("2026-10-05T15:00:00");
    expect(runs.hourly).toEqual(["2026-10-05T14:00:00.000Z", "2026-10-05T15:00:00.000Z"]);
  });

  it("catches up a missed slot once on the next tick", async () => {
    const { add, tick, runs } = setup();
    add("hourly", { everyHour: true });
    await tick("2026-10-05T13:00:00");
    // The 14:00, 15:00 and 16:00 ticks failed; the 16:15 tick runs the latest slot once.
    await tick("2026-10-05T16:15:00");
    await tick("2026-10-05T16:30:00");
    expect(runs.hourly).toEqual(["2026-10-05T13:00:00.000Z", "2026-10-05T16:00:00.000Z"]);
  });

  it("doesn't run a newly added task for a slot that passed before its first tick", async () => {
    const { add, tick, runs } = setup();
    add("hourly", { everyHour: true });
    add("report", REPORT);
    await tick("2026-10-05T14:15:00"); // Monday, after both slots
    expect(runs).toEqual({ hourly: [], report: [] });
    await tick("2026-10-05T15:00:00");
    expect(runs.hourly).toEqual(["2026-10-05T15:00:00.000Z"]);
  });

  it("runs the 09:30 ET weekday task on its tick, and not on Saturday", async () => {
    const { add, tick, runs } = setup();
    add("report", REPORT);
    await tick("2026-10-09T13:15:00"); // Fri 09:15 EDT
    await tick("2026-10-09T13:30:00"); // Fri 09:30 EDT
    await tick("2026-10-09T13:45:00");
    await tick("2026-10-10T13:30:00"); // Sat
    await tick("2026-10-12T13:30:00"); // Mon
    expect(runs.report).toEqual(["2026-10-09T13:30:00.000Z", "2026-10-12T13:30:00.000Z"]);
  });

  it("runs a task once when two ticks overlap", async () => {
    const { add, tick, runs } = setup();
    add("hourly", { everyHour: true });
    await tick("2026-10-05T13:00:00");
    await Promise.all([tick("2026-10-05T14:00:00"), tick("2026-10-05T14:00:00"), tick("2026-10-05T14:00:00")]);
    expect(runs.hourly).toEqual(["2026-10-05T13:00:00.000Z", "2026-10-05T14:00:00.000Z"]);
  });

  it("reports a failing task and still runs the others", async () => {
    const { add, tick, runs, reported } = setup();
    add("broken", { everyHour: true }, async () => {
      throw new Error("kaboom");
    });
    add("fine", { everyHour: true });
    await expect(tick("2026-10-05T14:00:00")).resolves.toBeUndefined();
    expect(reported).toEqual([{ error: expect.objectContaining({ message: "kaboom" }), source: "broken" }]);
    expect(runs.fine).toHaveLength(1);
  });

  it("reports a failed claim without running the task", async () => {
    const reported: string[] = [];
    const brokenDb = createDb({
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database);
    const scheduler = new Scheduler({
      db: brokenDb,
      reportError: async (_error, { source }) => {
        reported.push(source);
      },
    });
    let ran = false;
    scheduler.add({
      name: "hourly",
      when: { everyHour: true },
      run: async () => {
        ran = true;
      },
    });
    await scheduler.tick(utc("2026-10-05T14:00:00"));
    expect(ran).toBe(false);
    expect(reported).toEqual(["scheduler.hourly"]);
  });
});
