import type {
  AnyHomeTabBlock,
  AnyMessageBlock,
  AnyModalBlock,
  HomeTabView,
  ModalView,
  ViewStateValue as SlackEdgeViewStateValue,
} from "slack-edge";

// Block Kit types come from slack-edge's client library (type-only). If slack-edge is ever
// replaced, vendor these types here; nothing outside src/slack/ imports the library.
export type MessageBlock = AnyMessageBlock;
export type ModalBlock = AnyModalBlock;
export type HomeBlock = AnyHomeTabBlock;
export type { HomeTabView, ModalView };
export type ViewStateValue = SlackEdgeViewStateValue;
/** Submitted input values: block_id → action_id → value. */
export type ViewValues = Record<string, Record<string, ViewStateValue>>;

export interface SlackMessage {
  channel: string;
  text: string;
  blocks?: MessageBlock[];
  thread_ts?: string;
}

export interface PostedMessage {
  channel: string;
  ts: string;
}

export interface MessageUpdate {
  channel: string;
  ts: string;
  text: string;
  blocks?: MessageBlock[];
}

export interface Reaction {
  channel: string;
  ts: string;
  /** Emoji name without colons, e.g. "large_purple_circle". */
  name: string;
}

export interface DirectMessage {
  text: string;
  blocks?: MessageBlock[];
}

/** A message only the requesting user sees. */
export interface EphemeralReply {
  text: string;
  blocks?: MessageBlock[];
}

export interface OpenedView {
  viewId: string;
  hash: string;
}

export interface ViewUpdate {
  viewId: string;
  /** Pass the hash from the last view state to avoid overwriting a newer update. */
  hash?: string;
  view: ModalView;
}

export interface BotIdentity {
  botId: string;
  botUserId: string;
}

/** Outbound Slack API, as features see it (`services.slack`). */
export interface SlackClient {
  postMessage(message: SlackMessage): Promise<PostedMessage>;
  updateMessage(update: MessageUpdate): Promise<void>;
  /** Adding a reaction that is already there is not an error. */
  addReaction(reaction: Reaction): Promise<void>;
  sendDirectMessage(userId: string, message: DirectMessage): Promise<PostedMessage>;
  /** Replies through an interaction's `response_url`. */
  respond(responseUrl: string, reply: EphemeralReply): Promise<void>;
  /** `triggerId` expires 3s after the interaction, so call this from an ack handler. */
  openView(triggerId: string, view: ModalView): Promise<OpenedView>;
  updateView(update: ViewUpdate): Promise<void>;
  publishHome(userId: string, view: HomeTabView): Promise<void>;
  /** The user's IANA time zone from their Slack profile, or null when it has none. */
  userTimeZone(userId: string): Promise<string | null>;
  authTest(): Promise<BotIdentity>;
}
