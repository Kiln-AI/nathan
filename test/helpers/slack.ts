import { env } from "cloudflare:workers";

const EVENTS_URL = "https://nathan.test/slack/events";

/** A request to /slack/events signed like Slack does (HMAC-SHA256 of `v0:{ts}:{body}`). */
export async function signedSlackRequest(
  body: string,
  options: { contentType?: string; secret?: string; timestamp?: number } = {},
): Promise<Request> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(EVENTS_URL, {
    method: "POST",
    body,
    headers: {
      "Content-Type": options.contentType ?? "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${signature}`,
    },
  });
}

/** Interactivity payloads arrive form-encoded as `payload=<json>`. */
export function interactivityBody(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const team = { id: "T1", domain: "kiln" };

export function shortcutBody(callbackId: string, userId = "UALICE"): string {
  return interactivityBody({
    type: "shortcut",
    callback_id: callbackId,
    trigger_id: "trigger-1",
    user: { id: userId, username: "alice", team_id: "T1" },
    team,
    token: "legacy",
    action_ts: "1.2",
  });
}

export function viewSubmissionBody(
  callbackId: string,
  values: Record<string, Record<string, unknown>> = {},
  options: { userId?: string; privateMetadata?: string } = {},
): string {
  return interactivityBody({
    type: "view_submission",
    team,
    user: { id: options.userId ?? "UALICE", name: "alice" },
    api_app_id: "A1",
    token: "legacy",
    trigger_id: "trigger-2",
    view: {
      id: "V1",
      hash: "hash-1",
      callback_id: callbackId,
      private_metadata: options.privateMetadata ?? "",
      team_id: "T1",
      app_id: "A1",
      bot_id: "BNATHAN",
      type: "modal",
      title: { type: "plain_text", text: "Form" },
      blocks: [],
      close: null,
      submit: null,
      state: { values },
    },
  });
}

export function blockActionBody(
  action: { action_id: string; block_id?: string; type?: string; value?: string },
  container: {
    view?: {
      callbackId: string;
      values?: Record<string, Record<string, unknown>>;
      type?: "modal" | "home";
      privateMetadata?: string;
    };
    channel?: string;
  } = {},
): string {
  const base = {
    type: "block_actions",
    team,
    user: { id: "UALICE", name: "alice" },
    api_app_id: "A1",
    token: "legacy",
    trigger_id: "trigger-3",
    actions: [{ type: "button", block_id: "b1", action_ts: "1.3", ...action }],
    state: { values: {} },
  };
  if (container.view) {
    return interactivityBody({
      ...base,
      container: { type: "view", view_id: "V9" },
      view: {
        id: "V9",
        hash: "hash-9",
        callback_id: container.view.callbackId,
        private_metadata: container.view.privateMetadata ?? "meta",
        type: container.view.type ?? "modal",
        state: { values: container.view.values ?? {} },
      },
    });
  }
  const channel = container.channel ?? "CPRS";
  return interactivityBody({
    ...base,
    container: { type: "message", message_ts: "111.222", channel_id: channel, is_ephemeral: false },
    channel: { id: channel, name: "prs" },
    message: { type: "message", ts: "111.222", text: "card" },
  });
}

export function commandBody(text: string, command = "/nathan"): string {
  return new URLSearchParams({
    token: "legacy",
    command,
    text,
    response_url: "https://hooks.slack.test/commands/1",
    trigger_id: "trigger-4",
    user_id: "UALICE",
    user_name: "alice",
    team_id: "T1",
    team_domain: "kiln",
    channel_id: "CPRS",
    channel_name: "prs",
    api_app_id: "A1",
  }).toString();
}

export function appHomeOpenedBody(userId = "UALICE", tab: "home" | "messages" = "home"): string {
  return JSON.stringify({
    token: "legacy",
    team_id: "T1",
    api_app_id: "A1",
    type: "event_callback",
    event_id: "Ev1",
    event_time: 1,
    event: { type: "app_home_opened", user: userId, channel: "DHOME", tab, event_ts: "1.4" },
  });
}
