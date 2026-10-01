import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../../src/core/db";

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
