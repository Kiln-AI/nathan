import type { JobMessage, JobQueue } from "../../src/core/jobs";

export interface SentJob {
  body: JobMessage;
  delaySeconds: number | undefined;
}

/** Records enqueued jobs instead of delivering them; `take()` hands them to a test. */
export class RecordingQueue implements JobQueue {
  sent: SentJob[] = [];
  private failure: Error | undefined;

  fail(error = new Error("queue unavailable")): void {
    this.failure = error;
  }

  succeed(): void {
    this.failure = undefined;
  }

  async send(body: JobMessage, options?: QueueSendOptions): Promise<QueueSendResponse> {
    if (this.failure) throw this.failure;
    this.sent.push({ body: structuredClone(body), delaySeconds: options?.delaySeconds });
    return { metadata: { metrics: { backlogCount: this.sent.length, backlogBytes: 0 } } };
  }

  /** Removes and returns everything sent so far. */
  take(): SentJob[] {
    const taken = this.sent;
    this.sent = [];
    return taken;
  }

  jobNames(): string[] {
    return this.sent.map((s) => s.body.job);
  }
}
