import type {
  BotIdentity,
  DirectMessage,
  EphemeralReply,
  HomeTabView,
  MessageUpdate,
  ModalView,
  OpenedView,
  PostedMessage,
  Reaction,
  SlackClient,
  SlackMessage,
  ViewUpdate,
} from "../../src/slack";

export const FAKE_BOT: BotIdentity = { botId: "BNATHAN", botUserId: "UNATHAN" };

/** Records outbound Slack calls and generates message timestamps and view IDs. */
export class FakeSlack implements SlackClient {
  readonly posts: SlackMessage[] = [];
  readonly updates: MessageUpdate[] = [];
  readonly reactions: Reaction[] = [];
  readonly dms: { userId: string; message: DirectMessage }[] = [];
  readonly responses: { responseUrl: string; reply: EphemeralReply }[] = [];
  readonly openedViews: { triggerId: string; view: ModalView }[] = [];
  readonly updatedViews: ViewUpdate[] = [];
  readonly homes: { userId: string; view: HomeTabView }[] = [];
  /** Slack profile time zones by user ID; users missing here have none. */
  readonly timeZones = new Map<string, string>();
  timeZoneLookups: string[] = [];
  authTests = 0;
  private nextTs = 1_000_000;
  private nextView = 0;
  private failure: Error | undefined;

  /** Makes every call throw `error` until `succeed()` is called. */
  fail(error = new Error("slack is down")): void {
    this.failure = error;
  }

  succeed(): void {
    this.failure = undefined;
  }

  async postMessage(message: SlackMessage): Promise<PostedMessage> {
    this.check();
    this.posts.push(message);
    return { channel: message.channel, ts: this.ts() };
  }

  async updateMessage(update: MessageUpdate): Promise<void> {
    this.check();
    this.updates.push(update);
  }

  async addReaction(reaction: Reaction): Promise<void> {
    this.check();
    this.reactions.push(reaction);
  }

  async sendDirectMessage(userId: string, message: DirectMessage): Promise<PostedMessage> {
    this.check();
    this.dms.push({ userId, message });
    return { channel: `D${userId}`, ts: this.ts() };
  }

  async respond(responseUrl: string, reply: EphemeralReply): Promise<void> {
    this.check();
    this.responses.push({ responseUrl, reply });
  }

  async openView(triggerId: string, view: ModalView): Promise<OpenedView> {
    this.check();
    this.openedViews.push({ triggerId, view });
    this.nextView += 1;
    return { viewId: `V${this.nextView}`, hash: `hash-${this.nextView}` };
  }

  async updateView(update: ViewUpdate): Promise<void> {
    this.check();
    this.updatedViews.push(update);
  }

  async publishHome(userId: string, view: HomeTabView): Promise<void> {
    this.check();
    this.homes.push({ userId, view });
  }

  async userTimeZone(userId: string): Promise<string | null> {
    this.check();
    this.timeZoneLookups.push(userId);
    return this.timeZones.get(userId) ?? null;
  }

  async authTest(): Promise<BotIdentity> {
    this.authTests += 1;
    this.check();
    return FAKE_BOT;
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }

  private ts(): string {
    this.nextTs += 1;
    return `${this.nextTs}.000100`;
  }
}
