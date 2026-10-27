import { env } from "cloudflare:workers";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../src/core/db";
import { createPRStore } from "../../../src/features/pr_management/store";
import { aRecord } from "../../builders/pr_record";
import { MORE_THAN_D1_BINDS, REPO, recordCheckRuns } from "../../helpers/pr";

const store = () => createPRStore(createDb(env.DB));
const NOW = DateTime.fromISO("2026-10-05T14:00:00Z", { zone: "utc" });

describe("PR store: lists longer than D1 binds to one statement", () => {
  it("deletes exactly the given events of the PR", async () => {
    const s = store();
    await recordCheckRuns(s, MORE_THAN_D1_BINDS + 1, NOW);
    await recordCheckRuns(s, 1, NOW, 102);
    const [kept, ...consumed] = await s.events(REPO, 101, NOW);

    await s.deleteEvents(
      REPO,
      101,
      consumed.map((event) => event.id),
    );

    expect(await s.events(REPO, 101, NOW)).toEqual([kept]);
    expect(await s.events(REPO, 102, NOW)).toHaveLength(1);
  });

  it("reads the open records of every repo, ordered by repo then number", async () => {
    const s = store();
    const repos = Array.from({ length: MORE_THAN_D1_BINDS }, (_, i) => `Kiln-AI/repo-${String(i).padStart(3, "0")}`);
    // Inserted last repo first, so the order can only come from sorting across the chunks.
    for (const repo of repos.toReversed()) {
      await s.insert(aRecord({ repo, number: 2 }));
      await s.insert(aRecord({ repo, number: 1 }));
    }
    await s.insert(aRecord({ repo: repos[0], number: 3, state: "merged" }));
    await s.insert(aRecord({ repo: "Kiln-AI/untracked", number: 1 }));

    const records = await s.openRecords(repos.toReversed());

    expect(records.map(({ repo, number }) => `${repo}#${number}`)).toEqual(
      repos.flatMap((repo) => [`${repo}#1`, `${repo}#2`]),
    );
  });

  it("reads no records for no repos", async () => {
    const s = store();
    await s.insert(aRecord());
    expect(await s.openRecords([])).toEqual([]);
  });
});
