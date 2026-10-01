import { describe, expect, it } from "vitest";
import production from "../../slack-manifest.production.yaml?raw";
import staging from "../../slack-manifest.staging.yaml?raw";

const BOT_SCOPES = ["commands", "chat:write", "users:read", "reactions:write", "im:write"];

/** The "- item" lines of the YAML list under `key:` (enough for these flat manifests). */
function listUnder(manifest: string, key: string): string[] {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*- (\S+)$/.exec(line);
    if (!item?.[1]) break;
    items.push(item[1]);
  }
  return items;
}

const values = (manifest: string, key: string) =>
  [...manifest.matchAll(new RegExp(`^\\s*-?\\s*${key}: (.+)$`, "gm"))].map((m) => m[1]);

describe.each([
  ["production", production, "/nathan", "nathan-production"],
  ["staging", staging, "/nathan-staging", "nathan-staging"],
])("slack-manifest.%s.yaml", (_env, manifest, command, worker) => {
  it("sends events, interactivity and the slash command to the worker's /slack/events", () => {
    const urls = [...values(manifest, "url"), ...values(manifest, "request_url")];
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toBe(`https://${worker}.REPLACE_WITH_WORKERS_SUBDOMAIN.workers.dev/slack/events`);
    }
  });

  it("requests exactly the architecture's bot scopes and the app_home_opened event", () => {
    expect(listUnder(manifest, "bot")).toEqual(BOT_SCOPES);
    expect(listUnder(manifest, "bot_events")).toEqual(["app_home_opened"]);
  });

  it("defines the Request PR shortcut and its slash command", () => {
    expect(values(manifest, "callback_id")).toEqual(["request_pr"]);
    expect(values(manifest, "command")).toEqual([command]);
    expect(values(manifest, "home_tab_enabled")).toEqual(["true"]);
  });
});
