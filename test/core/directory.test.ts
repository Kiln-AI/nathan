import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../../src/core/db";
import { createUserDirectory, normalizeGithubLogin, TZ_CACHE_TTL_MS } from "../../src/core/directory";
import { FakeClock } from "../fakes/clock";
import { MemoryLogger } from "../fakes/log";
import { FakeSlack } from "../fakes/slack";

const users = [
  { github: "Alice", slack: "UALICE" },
  { github: "bob", slack: "UBOB", tz: "Asia/Shanghai" },
  { github: "dependabot", slack: "UDEPS" },
];

function directory() {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const log = new MemoryLogger();
  const db = createDb(env.DB);
  const dir = createUserDirectory({ users, defaultTimezone: "America/Toronto", db, clock, slack, log });
  return { dir, slack, clock, log };
}

const cachedRows = () => env.DB.prepare("SELECT slack_id, tz, fetched_at FROM slack_user_tz").all();
const seedCache = (slackId: string, tz: string, fetchedAt: number) =>
  env.DB.prepare("INSERT INTO slack_user_tz (slack_id, tz, fetched_at) VALUES (?, ?, ?)")
    .bind(slackId, tz, fetchedAt)
    .run();

describe("lookups", () => {
  it("finds users by Slack ID and by GitHub login, ignoring case and a [bot] suffix", () => {
    const { dir } = directory();
    expect(dir.bySlack("UBOB")?.github).toBe("bob");
    expect(dir.bySlack("UNOBODY")).toBeUndefined();
    expect(dir.byGithub("alice")?.slack).toBe("UALICE");
    expect(dir.byGithub("ALICE")?.slack).toBe("UALICE");
    expect(dir.byGithub("dependabot[bot]")?.slack).toBe("UDEPS");
    expect(dir.byGithub("stranger")).toBeUndefined();
  });

  it("lists every user in config order", () => {
    expect(directory().dir.users()).toEqual(users);
  });

  it("mentions mapped logins only", () => {
    const { dir } = directory();
    expect(dir.slackMention("BOB")).toBe("<@UBOB>");
    expect(dir.slackMention("stranger")).toBeNull();
  });

  it("normalizes logins", () => {
    expect(normalizeGithubLogin("Dependabot[bot]")).toBe("dependabot");
    expect(normalizeGithubLogin("bot[bot]x")).toBe("bot[bot]x");
  });
});

describe("timezone", () => {
  it("uses the config override without asking Slack", async () => {
    const { dir, slack } = directory();
    expect(await dir.timezone("UBOB")).toBe("Asia/Shanghai");
    expect(slack.timeZoneLookups).toEqual([]);
  });

  it("fetches the Slack profile zone once and caches it", async () => {
    const { dir, slack, clock } = directory();
    slack.timeZones.set("UALICE", "America/Los_Angeles");
    expect(await dir.timezone("UALICE")).toBe("America/Los_Angeles");
    clock.advance({ hours: 23 });
    expect(await dir.timezone("UALICE")).toBe("America/Los_Angeles");
    expect(slack.timeZoneLookups).toEqual(["UALICE"]);
    expect((await cachedRows()).results).toEqual([
      { slack_id: "UALICE", tz: "America/Los_Angeles", fetched_at: Date.parse("2026-10-05T14:00:00Z") },
    ]);
  });

  it("refreshes a stale cache entry", async () => {
    const { dir, slack, clock } = directory();
    await seedCache("UALICE", "Europe/London", clock.now().toMillis() - TZ_CACHE_TTL_MS);
    slack.timeZones.set("UALICE", "Asia/Tokyo");
    expect(await dir.timezone("UALICE")).toBe("Asia/Tokyo");
    expect((await cachedRows()).results).toEqual([
      { slack_id: "UALICE", tz: "Asia/Tokyo", fetched_at: clock.now().toMillis() },
    ]);
  });

  it("works for Slack users who aren't in the config", async () => {
    const { dir, slack } = directory();
    slack.timeZones.set("UGUEST", "Europe/Paris");
    expect(await dir.timezone("UGUEST")).toBe("Europe/Paris");
  });

  it.each([
    ["no time zone", undefined],
    ["an invalid time zone", "Mars/Olympus_Mons"],
  ])("falls back to the default when the profile has %s, without caching", async (_name, tz) => {
    const { dir, slack } = directory();
    if (tz) slack.timeZones.set("UALICE", tz);
    expect(await dir.timezone("UALICE")).toBe("America/Toronto");
    expect((await cachedRows()).results).toEqual([]);
  });

  it("falls back to a stale cache entry when Slack fails, and logs a warning", async () => {
    const { dir, slack, clock, log } = directory();
    await seedCache("UALICE", "Europe/London", clock.now().toMillis() - 2 * TZ_CACHE_TTL_MS);
    slack.fail();
    expect(await dir.timezone("UALICE")).toBe("Europe/London");
    expect(log.at("warn").map((e) => [e.msg, e.fields.slackId])).toEqual([["Slack time zone lookup failed", "UALICE"]]);
  });

  it("falls back to the default when Slack fails and nothing is cached", async () => {
    const { dir, slack } = directory();
    slack.fail();
    expect(await dir.timezone("UALICE")).toBe("America/Toronto");
  });
});
