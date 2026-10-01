import { env } from "cloudflare:workers";
import { type AppOverrides, createApp } from "../../src/core/app";
import { aConfig } from "../builders/config";
import { fakeBatch, fakeMessage } from "../fakes/batch";
import { FakeClock } from "../fakes/clock";
import { FakeGitHub } from "../fakes/github";
import { MemoryLogger } from "../fakes/log";
import { RecordingQueue } from "../fakes/queue";
import { FakeSlack } from "../fakes/slack";

/** Builds the app on the real (test) D1 with fake Slack, GitHub, queue, clock and logger. */
export function testApp(overrides: AppOverrides = {}) {
  const clock = new FakeClock();
  const slack = new FakeSlack();
  const github = new FakeGitHub();
  const queue = new RecordingQueue();
  const log = new MemoryLogger();
  const app = createApp(env, { config: aConfig(), features: [], clock, slack, github, queue, log, ...overrides });
  return { app, clock, slack, github, queue, log };
}

export type TestApp = ReturnType<typeof testApp>;

/** Delivers every job enqueued so far (ignoring delays) and returns the delivered messages. */
export async function deliverQueued({ app, queue }: Pick<TestApp, "app" | "queue">) {
  const messages = queue.take().map((sent) => fakeMessage(sent.body));
  await app.queue(fakeBatch(messages));
  return messages;
}
