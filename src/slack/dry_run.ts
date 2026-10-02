import {
  channelLink,
  context,
  MAX_CONTEXT_ELEMENTS,
  MAX_MESSAGE_BLOCKS,
  MAX_SECTION_TEXT,
  mrkdwn,
  truncate,
} from "./blocks";
import type { MessageBlock, SlackClient } from "./types";

export interface DryRunOptions {
  testChannel: string;
  /** A plain display name for a Slack user ID, or undefined when unknown. */
  nameOf: (slackUserId: string) => string | undefined;
}

/**
 * Dry run (architecture §4.8): every message goes to the test channel, labelled with where it
 * would have gone, with mentions rewritten so nobody is pinged. Views, ephemeral replies and
 * reads only reach the person interacting, so they pass through.
 */
export function createDryRunSlackClient(inner: SlackClient, { testChannel, nameOf }: DryRunOptions): SlackClient {
  const defuse = (text: string) => defuseMentions(text, nameOf);
  const label = (prefix: string, text: string, blocks: MessageBlock[] | undefined) => ({
    text: `${prefix} ${defuse(text)}`,
    blocks: blocks && labelBlocks(prefix, defuseBlocks(blocks, defuse)),
  });
  const channelPrefix = (channel: string) => `[dry-run → ${channelLink(channel)}]`;

  return {
    postMessage: ({ channel, text, blocks, thread_ts }) =>
      inner.postMessage({ channel: testChannel, thread_ts, ...label(channelPrefix(channel), text, blocks) }),
    updateMessage: ({ channel, ts, text, blocks }) =>
      inner.updateMessage({ channel: testChannel, ts, ...label(channelPrefix(channel), text, blocks) }),
    addReaction: (reaction) => inner.addReaction({ ...reaction, channel: testChannel }),
    sendDirectMessage: (userId, { text, blocks }) =>
      inner.postMessage({
        channel: testChannel,
        ...label(`[dry-run → DM @${nameOf(userId) ?? userId}]`, text, blocks),
      }),
    respond: (responseUrl, reply) => inner.respond(responseUrl, reply),
    openView: (triggerId, view) => inner.openView(triggerId, view),
    updateView: (update) => inner.updateView(update),
    publishHome: (userId, view) => inner.publishHome(userId, view),
    userTimeZone: (userId) => inner.userTimeZone(userId),
    userName: (userId) => inner.userName(userId),
    authTest: () => inner.authTest(),
  };
}

/**
 * Puts the label in front of the blocks without exceeding Slack's 50-block limit: a full message
 * gets the label folded into its first section or context block instead. When the first block is
 * neither, the label stays only in the notification text.
 */
function labelBlocks(prefix: string, blocks: MessageBlock[]): MessageBlock[] {
  if (blocks.length < MAX_MESSAGE_BLOCKS) return [context(prefix), ...blocks];
  const [first, ...rest] = blocks;
  if (first?.type === "section" && first.text) {
    const text = { ...first.text, text: truncate(`${prefix}\n${first.text.text}`, MAX_SECTION_TEXT) };
    return [{ ...first, text }, ...rest];
  }
  if (first?.type === "context" && first.elements.length < MAX_CONTEXT_ELEMENTS) {
    return [{ ...first, elements: [mrkdwn(prefix), ...first.elements] }, ...rest];
  }
  return blocks;
}

// Only mrkdwn/plain-text strings are rewritten: rich_text `user` and `broadcast` elements would
// still notify people, so dry-run-safe features must not use them. Only `richText.user` builds one,
// and it is meant only for the App Home and ephemeral replies, which never notify.
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|@?([^>]*))?>/g;

/** Rewrites Slack mention syntax into plain text that doesn't notify anyone. */
export function defuseMentions(text: string, nameOf: (slackUserId: string) => string | undefined): string {
  return text
    .replace(USER_MENTION, (_match, id: string, label: string | undefined) => `@${nameOf(id) ?? (label || id)}`)
    .replace(SPECIAL_MENTION, (_match, name: string) => `@${name}`)
    .replace(GROUP_MENTION, (_match, id: string, label: string | undefined) => `@${label || id}`);
}

function defuseBlocks(blocks: MessageBlock[], defuse: (text: string) => string): MessageBlock[] {
  return mapStrings(blocks, defuse) as MessageBlock[];
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}
