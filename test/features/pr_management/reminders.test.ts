import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_TEMPLATES, type ReminderConfig } from "../../../src/features/pr_management/config";
import {
  currentReminders,
  type OwnerWait,
  pickTemplate,
  planReminder,
  reminderText,
  thresholdHours,
} from "../../../src/features/pr_management/reminders";
import { NO_REMINDERS } from "../../../src/features/pr_management/store";

const config: ReminderConfig = {
  thresholdHours: 24,
  thresholdHoursByState: { approved: 8, ci_failing: 2 },
  urgentThresholdHours: 4,
  templates: DEFAULT_REMINDER_TEMPLATES,
};

const wait = (login: string, workingHours: number, recipient = `U${login.toUpperCase()}`): OwnerWait => ({
  login,
  recipient,
  workingHours,
});

describe("thresholdHours", () => {
  it("uses the default, or the state's own threshold", () => {
    expect(thresholdHours("awaiting_review", [], config)).toBe(24);
    expect(thresholdHours("approved", ["quick"], config)).toBe(8);
  });

  it("shortens it for urgent PRs, but never lengthens a shorter one", () => {
    expect(thresholdHours("awaiting_review", ["urgent"], config)).toBe(4);
    expect(thresholdHours("ci_failing", ["urgent"], config)).toBe(2);
  });
});

describe("currentReminders", () => {
  const since = DateTime.fromISO("2026-10-05T14:00:00Z", { zone: "utc" });
  const reminders = { sent: { bob: { level: 2, at: since.plus({ days: 2 }) } }, for: since, lastVariant: "1:0" };

  it("keeps the reminders sent in the current state", () => {
    expect(currentReminders({ stateSince: since, reminders })).toEqual(reminders.sent);
  });

  it("starts over once the state or owners changed, or when nothing was sent", () => {
    expect(currentReminders({ stateSince: since.plus({ hours: 1 }), reminders })).toEqual({});
    expect(currentReminders({ stateSince: since, reminders: NO_REMINDERS })).toEqual({});
  });
});

describe("planReminder", () => {
  const now = DateTime.fromISO("2026-10-08T14:00:00Z", { zone: "utc" });
  const earlier = now.minus({ days: 1 });
  const sentAt = (level: number) => ({ level, at: earlier });

  it("is null until an owner has waited a full threshold", () => {
    expect(planReminder([wait("bob", 23.9)], {}, 24, now)).toBeNull();
    expect(planReminder([], {}, 24, now)).toBeNull();
  });

  it("reminds at level 1 first, recording when", () => {
    expect(planReminder([wait("bob", 24)], {}, 24, now)).toEqual({
      recipients: ["UBOB"],
      level: 1,
      sent: { bob: { level: 1, at: now } },
    });
  });

  it("starts at level 1 however long the PR has waited", () => {
    expect(planReminder([wait("bob", 120)], {}, 4, now)).toMatchObject({ level: 1, sent: { bob: { level: 1 } } });
  });

  it("goes one level above the owner's last reminder, never skipping one", () => {
    expect(planReminder([wait("bob", 24)], { bob: sentAt(1) }, 24, now)).toMatchObject({
      level: 2,
      sent: { bob: { level: 2, at: now } },
    });
    expect(planReminder([wait("bob", 500)], { bob: sentAt(4) }, 24, now)).toMatchObject({ level: 5 });
    expect(planReminder([wait("bob", 23)], { bob: sentAt(1) }, 24, now)).toBeNull();
  });

  it("tags only due owners, at the highest level among them, keeping the others' records", () => {
    const plan = planReminder(
      [wait("Bob", 30), wait("carol", 30), wait("dan", 10)],
      { bob: sentAt(1), dan: sentAt(1) },
      24,
      now,
    );
    expect(plan).toEqual({
      recipients: ["UBOB", "UCAROL"],
      level: 2,
      sent: { bob: { level: 2, at: now }, carol: { level: 1, at: now }, dan: sentAt(1) },
    });
  });

  it("tags a shared recipient once", () => {
    const plan = planReminder([wait("outsider", 24, "UDAN"), wait("stranger", 24, "UDAN")], {}, 24, now);
    expect(plan).toMatchObject({ recipients: ["UDAN"], level: 1 });
  });
});

describe("pickTemplate", () => {
  const templates = [["a0", "a1", "a2"], ["b0", "b1"], ["c0"]];
  const at = (value: number) => () => value;

  it("picks from the level's group; the last group serves every higher level", () => {
    expect(pickTemplate(templates, 1, null, at(0.5))).toEqual({ text: "a1", variant: "0:1" });
    expect(pickTemplate(templates, 2, null, at(0.99))).toEqual({ text: "b1", variant: "1:1" });
    expect(pickTemplate(templates, 7, null, at(0.5))).toEqual({ text: "c0", variant: "2:0" });
  });

  it("never repeats the PR's last variant in the same group", () => {
    for (const value of [0, 0.4, 0.99]) {
      expect(pickTemplate(templates, 1, "0:1", at(value)).variant).not.toBe("0:1");
    }
    expect(pickTemplate(templates, 2, "1:0", at(0)).variant).toBe("1:1");
  });

  it("may reuse a variant last used in another group, and repeats a group's only variant", () => {
    expect(pickTemplate(templates, 1, "1:0", at(0)).variant).toBe("0:0");
    expect(pickTemplate(templates, 3, "2:0", at(0.5)).variant).toBe("2:0");
  });
});

describe("reminderText", () => {
  it("tags the owners, then states the next step, the wait and the PR's age", () => {
    const text = reminderText({
      recipients: ["UBOB", "UCAROL"],
      template: "Friendly nudge 👋",
      nextStep: "Review",
      waitingHours: 26,
      ageHours: 100,
    });
    expect(text).toBe("<@UBOB> <@UCAROL> — Friendly nudge 👋\n*Next step:* Review · waiting 1d 2h · opened 4d 4h ago");
  });
});
