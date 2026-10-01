export type MessageOutcome =
  | { kind: "pending" }
  | { kind: "ack" }
  | { kind: "retry"; delaySeconds: number | undefined };

export interface FakeMessage extends Message<unknown> {
  outcome: MessageOutcome;
}

let nextId = 0;

export function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  nextId += 1;
  const message: FakeMessage = {
    id: `msg-${nextId}`,
    timestamp: new Date(0),
    body,
    attempts,
    outcome: { kind: "pending" },
    ack() {
      message.outcome = { kind: "ack" };
    },
    retry(options) {
      message.outcome = { kind: "retry", delaySeconds: options?.delaySeconds };
    },
  };
  return message;
}

export function fakeBatch(messages: FakeMessage[], queue = "nathan-jobs-dev"): MessageBatch<unknown> {
  return {
    messages,
    queue,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: undefined } },
    ackAll: () => {
      for (const m of messages) m.ack();
    },
    retryAll: (options) => {
      for (const m of messages) m.retry(options);
    },
  };
}
