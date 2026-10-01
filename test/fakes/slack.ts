import type { PostedMessage, SlackClient, SlackMessage } from "../../src/slack";

/** Records outbound Slack calls and generates message timestamps. */
export class FakeSlack implements SlackClient {
  readonly posts: SlackMessage[] = [];
  private nextTs = 1_000_000;
  private failure: Error | undefined;

  /** Makes every call throw `error` until `succeed()` is called. */
  fail(error = new Error("slack is down")): void {
    this.failure = error;
  }

  succeed(): void {
    this.failure = undefined;
  }

  async postMessage(message: SlackMessage): Promise<PostedMessage> {
    if (this.failure) throw this.failure;
    this.posts.push(message);
    this.nextTs += 1;
    return { channel: message.channel, ts: `${this.nextTs}.000100` };
  }
}
