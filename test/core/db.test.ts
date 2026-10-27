import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb, inListChunks, MAX_BOUND_PARAMS } from "../../src/core/db";

describe("Db", () => {
  const db = createDb(env.DB);

  it("runs statements and reports changed rows", async () => {
    expect(await db.run("INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)", "a", 1)).toEqual({ changes: 1 });
    expect(await db.run("UPDATE job_runs SET last_run_at = 2 WHERE name = ?", "missing")).toEqual({ changes: 0 });
  });

  it("reads the first row, or null when there is none", async () => {
    await db.run("INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)", "a", 1);
    expect(await db.first("SELECT name, last_run_at FROM job_runs WHERE name = ?", "a")).toEqual({
      name: "a",
      last_run_at: 1,
    });
    expect(await db.first("SELECT name FROM job_runs WHERE name = ?", "missing")).toBeNull();
  });

  it("reads all rows", async () => {
    await db.run("INSERT INTO job_runs (name, last_run_at) VALUES ('a', 1), ('b', 2)");
    expect(await db.all<{ name: string }>("SELECT name FROM job_runs ORDER BY name")).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("runs a batch as one transaction", async () => {
    const results = await db
      .batch([
        db.statement("INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)", "a", 1),
        db.statement("INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)", "b", null),
      ])
      .catch((error: unknown) => error);
    expect(results).toBeInstanceOf(Error); // NOT NULL violation rolls back the whole batch
    expect(await db.all("SELECT * FROM job_runs")).toEqual([]);

    expect(
      await db.batch([
        db.statement("INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)", "a", 1),
        db.statement("UPDATE job_runs SET last_run_at = 5 WHERE name = ?", "a"),
      ]),
    ).toEqual([{ changes: 1 }, { changes: 1 }]);
  });
});

describe("inListChunks", () => {
  it("splits a list so each statement binds at most MAX_BOUND_PARAMS, other parameters included", () => {
    const values = Array.from({ length: 250 }, (_, i) => i);
    const chunks = inListChunks(values, 2);
    expect(chunks.map((chunk) => chunk.values.length)).toEqual([98, 98, 54]);
    expect(chunks.flatMap((chunk) => chunk.values)).toEqual(values);
    expect(chunks.at(-1)?.placeholders).toBe(Array(54).fill("?").join(", "));
  });

  it("keeps a short list in one chunk, and has none for an empty list", () => {
    expect(inListChunks(["a", "b"])).toEqual([{ placeholders: "?, ?", values: ["a", "b"] }]);
    expect(inListChunks([])).toEqual([]);
  });

  it("refuses when the other parameters leave no room", () => {
    expect(() => inListChunks([1], MAX_BOUND_PARAMS)).toThrow(RangeError);
  });

  // The regression tests for long lists rely on the local D1 enforcing production's cap.
  it("matches production D1, which binds MAX_BOUND_PARAMS parameters to a statement and no more", async () => {
    const db = createDb(env.DB);
    const count = (names: string[]) =>
      db.first(`SELECT COUNT(*) AS n FROM job_runs WHERE name IN (${names.map(() => "?").join(", ")})`, ...names);
    const names = (n: number) => Array.from({ length: n }, (_, i) => `job-${i}`);
    expect(await count(names(MAX_BOUND_PARAMS))).toEqual({ n: 0 });
    await expect(count(names(MAX_BOUND_PARAMS + 1))).rejects.toThrow("too many SQL variables");
  });
});
