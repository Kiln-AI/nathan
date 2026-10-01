import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Every test starts from an empty, migrated database.
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  await env.DB.batch(tables.results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)));
});
