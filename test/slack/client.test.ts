import { describe, expect, it, vi } from "vitest";
import { context, modal, section } from "../../src/slack";
import { createSlackApiClient } from "../../src/slack/client";

interface ApiCall {
  method: string;
  params: Record<string, string>;
  auth: string | null;
}

/** Stubs fetch with a Slack Web API that answers each method from `responses`. */
function stubSlackApi(responses: Record<string, Record<string, unknown>>) {
  const calls: ApiCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input as Request;
    const method = new URL(request.url).pathname.replace("/api/", "");
    calls.push({
      method,
      params: Object.fromEntries(new URLSearchParams(await (await request.blob()).text())),
      auth: request.headers.get("Authorization"),
    });
    return Response.json(responses[method] ?? { ok: false, error: "unknown_method" });
  });
  return { client: createSlackApiClient("xoxb-123"), calls };
}

describe("createSlackApiClient", () => {
  it("posts a message and returns where it landed", async () => {
    const { client, calls } = stubSlackApi({ "chat.postMessage": { ok: true, channel: "C1", ts: "1.1" } });
    const posted = await client.postMessage({ channel: "C1", text: "hi", blocks: [section("hi")], thread_ts: "0.9" });
    expect(posted).toEqual({ channel: "C1", ts: "1.1" });
    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        params: { channel: "C1", text: "hi", blocks: JSON.stringify([section("hi")]), thread_ts: "0.9" },
        auth: "Bearer xoxb-123",
      },
    ]);
  });

  it("throws when a post comes back without a ts", async () => {
    const { client } = stubSlackApi({ "chat.postMessage": { ok: true, channel: "C1" } });
    await expect(client.postMessage({ channel: "C1", text: "hi" })).rejects.toThrow("chat.postMessage returned no ts");
  });

  it("throws Slack API errors", async () => {
    const { client } = stubSlackApi({ "chat.postMessage": { ok: false, error: "channel_not_found" } });
    await expect(client.postMessage({ channel: "C1", text: "hi" })).rejects.toThrow("channel_not_found");
  });

  it("updates a message", async () => {
    const { client, calls } = stubSlackApi({ "chat.update": { ok: true } });
    await client.updateMessage({ channel: "C1", ts: "1.1", text: "new" });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["chat.update", { channel: "C1", ts: "1.1", text: "new" }],
    ]);
  });

  it("adds a reaction, treating already_reacted as success", async () => {
    const { client, calls } = stubSlackApi({ "reactions.add": { ok: false, error: "already_reacted" } });
    await client.addReaction({ channel: "C1", ts: "1.1", name: "tada" });
    expect(calls[0]?.params).toEqual({ channel: "C1", timestamp: "1.1", name: "tada" });
  });

  it("rethrows other reaction errors", async () => {
    const { client } = stubSlackApi({ "reactions.add": { ok: false, error: "message_not_found" } });
    await expect(client.addReaction({ channel: "C1", ts: "1.1", name: "tada" })).rejects.toThrow("message_not_found");
  });

  it("opens the DM channel before sending a direct message", async () => {
    const { client, calls } = stubSlackApi({
      "conversations.open": { ok: true, channel: { id: "D1" } },
      "chat.postMessage": { ok: true, channel: "D1", ts: "2.2" },
    });
    expect(await client.sendDirectMessage("U1", { text: "psst" })).toEqual({ channel: "D1", ts: "2.2" });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["conversations.open", { users: "U1" }],
      ["chat.postMessage", { channel: "D1", text: "psst" }],
    ]);
  });

  it("opens, updates and publishes views", async () => {
    const { client, calls } = stubSlackApi({
      "views.open": { ok: true, view: { id: "V1", hash: "h1" } },
      "views.update": { ok: true },
      "views.publish": { ok: true },
    });
    const view = modal({ callbackId: "form", title: "Form", blocks: [] });
    expect(await client.openView("trig", view)).toEqual({ viewId: "V1", hash: "h1" });
    await client.updateView({ viewId: "V1", hash: "h1", view });
    await client.publishHome("U1", { type: "home", blocks: [context("hi")] });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["views.open", { trigger_id: "trig", view: JSON.stringify(view) }],
      ["views.update", { view_id: "V1", hash: "h1", view: JSON.stringify(view) }],
      ["views.publish", { user_id: "U1", view: JSON.stringify({ type: "home", blocks: [context("hi")] }) }],
    ]);
  });

  it("reads a user's time zone, or null when the profile has none", async () => {
    const withTz = stubSlackApi({ "users.info": { ok: true, user: { id: "U1", tz: "Asia/Shanghai" } } });
    expect(await withTz.client.userTimeZone("U1")).toBe("Asia/Shanghai");
    expect(withTz.calls[0]?.params).toEqual({ user: "U1" });
    vi.restoreAllMocks();
    const withoutTz = stubSlackApi({ "users.info": { ok: true, user: { id: "U2" } } });
    expect(await withoutTz.client.userTimeZone("U2")).toBeNull();
  });

  it("reads a user's display name, falling back to real name, then username, then null", async () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [{ name: "alice", real_name: "Alice R", profile: { display_name: "Al", real_name: "Alice P" } }, "Al"],
      [{ name: "alice", real_name: "Alice R", profile: { display_name: "", real_name: "Alice P" } }, "Alice P"],
      [{ name: "alice", real_name: "Alice R", profile: {} }, "Alice R"],
      [{ name: "alice" }, "alice"],
      [{}, null],
    ];
    for (const [user, expected] of cases) {
      vi.restoreAllMocks();
      const { client, calls } = stubSlackApi({ "users.info": { ok: true, user: { id: "U1", ...user } } });
      expect(await client.userName("U1")).toBe(expected);
      expect(calls[0]?.params).toEqual({ user: "U1" });
    }
  });

  it("returns the bot identity from auth.test", async () => {
    const { client } = stubSlackApi({ "auth.test": { ok: true, bot_id: "B1", user_id: "U9" } });
    expect(await client.authTest()).toEqual({ botId: "B1", botUserId: "U9" });
  });

  it("sends ephemeral replies to a response_url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await createSlackApiClient("xoxb").respond("https://hooks.slack.test/r", { text: "only you" });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.slack.test/r");
    expect(JSON.parse(String(init?.body))).toEqual({ response_type: "ephemeral", text: "only you" });
  });

  it("throws when a response_url rejects the reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("expired_url", { status: 404 }));
    await expect(createSlackApiClient("xoxb").respond("https://hooks.slack.test/r", { text: "x" })).rejects.toThrow(
      "response_url returned HTTP 404",
    );
  });
});
