// Public surface of the Slack gateway. Phase 2 grows this into the full client and registry
// over slack-edge; for now the platform core only needs to post messages (admin alerts).

export interface SlackMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}

export interface PostedMessage {
  channel: string;
  ts: string;
}

export interface SlackClient {
  postMessage(message: SlackMessage): Promise<PostedMessage>;
}

/** Production placeholder until the Slack gateway exists; `reportError` logs its failure. */
export const unwiredSlackClient: SlackClient = {
  postMessage: async () => {
    throw new Error("Slack gateway not wired yet");
  },
};
