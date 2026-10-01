import { SlackAPIClient, SlackAPIError } from "slack-edge";
import type { SlackClient } from "./types";

/** The production `SlackClient`. slack-web-api-client retries 429s itself, honouring Retry-After. */
export function createSlackApiClient(botToken: string): SlackClient {
  const api = new SlackAPIClient(botToken);

  const client: SlackClient = {
    async postMessage({ channel, text, blocks, thread_ts }) {
      const result = await api.chat.postMessage({ channel, text, blocks, thread_ts });
      return {
        channel: required(result.channel, "chat.postMessage", "channel"),
        ts: required(result.ts, "chat.postMessage", "ts"),
      };
    },

    async updateMessage({ channel, ts, text, blocks }) {
      await api.chat.update({ channel, ts, text, blocks });
    },

    async addReaction({ channel, ts, name }) {
      try {
        await api.reactions.add({ channel, timestamp: ts, name });
      } catch (error) {
        if (error instanceof SlackAPIError && error.error === "already_reacted") return;
        throw error;
      }
    },

    async sendDirectMessage(userId, { text, blocks }) {
      const opened = await api.conversations.open({ users: userId });
      const channel = required(opened.channel?.id, "conversations.open", "channel.id");
      return client.postMessage({ channel, text, blocks });
    },

    async respond(responseUrl, reply) {
      const response = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ response_type: "ephemeral", ...reply }),
      });
      if (!response.ok) throw new Error(`response_url returned HTTP ${response.status}`);
    },

    async openView(triggerId, view) {
      const result = await api.views.open({ trigger_id: triggerId, view });
      return {
        viewId: required(result.view?.id, "views.open", "view.id"),
        hash: required(result.view?.hash, "views.open", "view.hash"),
      };
    },

    async updateView({ viewId, hash, view }) {
      await api.views.update({ view_id: viewId, hash, view });
    },

    async publishHome(userId, view) {
      await api.views.publish({ user_id: userId, view });
    },

    async userTimeZone(userId) {
      const result = await api.users.info({ user: userId });
      return result.user?.tz || null;
    },

    async userName(userId) {
      const { user } = await api.users.info({ user: userId });
      return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || null;
    },

    async authTest() {
      const result = await api.auth.test();
      return {
        botId: required(result.bot_id, "auth.test", "bot_id"),
        botUserId: required(result.user_id, "auth.test", "user_id"),
      };
    },
  };
  return client;
}

function required<T>(value: T | undefined, method: string, field: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${method} returned no ${field}`);
  return value;
}
