import { DateTime } from "luxon";
import type { Db } from "./db";
import { type ReportError, runIsolated } from "./errors";
import { isValidTimeZone } from "./time";

/** `everyHour` fires at the top of each UTC hour; `at` fires at a local wall-clock time in `tz`. */
export type Schedule = { everyHour: true } | { at: string; tz: string; days: "weekdays" | "everyday" };

export interface TaskContext {
  /** The slot this run is for (UTC). Later than the slot if the run is catching up. */
  firedAt: DateTime;
}

export interface ScheduledTask {
  name: string;
  when: Schedule;
  /** May run up to 15 minutes. Must catch its own expected errors. */
  run(context: TaskContext): Promise<void>;
}

/** Wrangler's single cron trigger runs every TICK_MINUTES. */
export const TICK_MINUTES = 15;
const TICK_MS = TICK_MINUTES * 60 * 1000;

export function validateSchedule(when: Schedule): void {
  if ("everyHour" in when) return;
  parseTimeOfDay(when.at);
  if (!isValidTimeZone(when.tz)) throw new Error(`Invalid schedule time zone "${when.tz}"`);
}

/** The most recent fire time of `when` that is at or before `time`, in UTC. */
export function latestFireAtOrBefore(when: Schedule, time: DateTime): DateTime {
  if ("everyHour" in when) return time.toUTC().startOf("hour");
  const { hour, minute } = parseTimeOfDay(when.at);
  const local = time.setZone(when.tz);
  // Within any 8 consecutive local days there is a matching weekday at or before `time`.
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const candidate = local.minus({ days: daysBack }).set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= time && (when.days === "everyday" || candidate.weekday <= 5)) return candidate.toUTC();
  }
  throw new Error(`No fire time found for ${JSON.stringify(when)}`);
}

export function floorToTick(time: DateTime): DateTime {
  return DateTime.fromMillis(Math.floor(time.toMillis() / TICK_MS) * TICK_MS, { zone: "utc" });
}

export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly deps: { db: Db; reportError: ReportError }) {}

  add(task: ScheduledTask): void {
    validateSchedule(task.when);
    if (this.tasks.has(task.name)) throw new Error(`Scheduled task "${task.name}" is already defined`);
    this.tasks.set(task.name, task);
  }

  /** Runs every task whose latest fire time hasn't been claimed yet. Never throws. */
  async tick(scheduledTime: DateTime): Promise<void> {
    const tickTime = floorToTick(scheduledTime);
    await Promise.all([...this.tasks.values()].map((task) => this.runIfDue(task, tickTime)));
  }

  private async runIfDue(task: ScheduledTask, tickTime: DateTime): Promise<void> {
    const { reportError } = this.deps;
    const firedAt = latestFireAtOrBefore(task.when, tickTime);
    let claimed: boolean;
    try {
      claimed = await this.claim(task.name, firedAt, tickTime);
    } catch (error) {
      await reportError(error, { source: `scheduler.${task.name}` });
      return;
    }
    if (claimed) await runIsolated(task.name, () => task.run({ firedAt }), reportError);
  }

  /**
   * Claims the fire time with a compare-and-set on `job_runs`, so overlapping ticks never double-run
   * a task. A task's first tick records a baseline row, and runs it only if its fire time is within
   * that tick, so a new task doesn't immediately run for a slot that passed before it was deployed.
   */
  private async claim(name: string, firedAt: DateTime, tickTime: DateTime): Promise<boolean> {
    const { db } = this.deps;
    const fire = firedAt.toMillis();
    const row = await db.first<{ last_run_at: number }>("SELECT last_run_at FROM job_runs WHERE name = ?", name);
    if (!row) {
      const insert = await db.run(
        "INSERT INTO job_runs (name, last_run_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING",
        name,
        fire,
      );
      const isCurrentSlot = fire > tickTime.toMillis() - TICK_MS;
      return insert.changes === 1 && isCurrentSlot;
    }
    if (fire <= row.last_run_at) return false;
    const update = await db.run(
      "UPDATE job_runs SET last_run_at = ? WHERE name = ? AND last_run_at = ?",
      fire,
      name,
      row.last_run_at,
    );
    return update.changes === 1;
  }
}

function parseTimeOfDay(at: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) throw new Error(`Invalid schedule time "${at}"; expected HH:MM (24h)`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
