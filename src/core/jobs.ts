import { z } from "zod";
import type { Db } from "./db";
import { type ReportError, RetryAfterError } from "./errors";
import type { Logger } from "./log";
import type { Clock } from "./time";

/** Every message on the jobs queue. `job` is "<featureId>.<name>". */
export interface JobMessage {
  job: string;
  payload: unknown;
}

const jobMessageSchema = z.object({ job: z.string().min(1), payload: z.unknown() });

export interface JobRef<P> {
  readonly name: string;
  readonly schema: z.ZodType<P>;
}

export interface JobContext {
  /** 1 on the first delivery. */
  attempt: number;
}

/** Must be idempotent: Queues deliver at least once. */
export type JobHandler<P> = (payload: P, context: JobContext) => Promise<void>;

export interface JobOptions<P> {
  /** Called once when the last attempt fails, before the error is reported. */
  onGiveUp?: (payload: P, error: unknown) => Promise<void>;
}

export interface EnqueueOptions {
  delaySeconds?: number;
}

/** The part of the Queue binding Nathan uses (a seam for tests). */
export type JobQueue = Pick<Queue<JobMessage>, "send">;

export type Enqueue = <P>(job: JobRef<P>, payload: P, options?: EnqueueOptions) => Promise<void>;

export interface DebounceOptions {
  /** Quiet period after the latest call before the job runs. */
  windowSeconds: number;
  /** The job runs at most this long after the first call, even if calls keep coming. */
  maxWaitSeconds: number;
}

/**
 * Trailing-edge debounce: the job runs once with the latest payload. Payloads must be JSON.
 * If the delayed check can't be enqueued the call throws and its row is left for the hourly
 * `core.prune` task (deleting it could drop an earlier caller's pending update).
 */
export type Debounce = <P>(job: JobRef<P>, key: string, payload: P, options: DebounceOptions) => Promise<void>;

export const MAX_ATTEMPTS = 3;
/** Cloudflare Queues' maximum message delay. */
export const MAX_DELAY_SECONDS = 12 * 60 * 60;
const BASE_RETRY_SECONDS = 30;

interface JobDefinition<P> {
  ref: JobRef<P>;
  handler: JobHandler<P>;
  options: JobOptions<P>;
}

export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition<unknown>>();

  define<P>(name: string, schema: z.ZodType<P>, handler: JobHandler<P>, options: JobOptions<P> = {}): JobRef<P> {
    if (this.definitions.has(name)) throw new Error(`Job "${name}" is already defined`);
    const ref: JobRef<P> = { name, schema };
    this.definitions.set(name, { ref, handler, options } as JobDefinition<unknown>);
    return ref;
  }

  get(name: string): JobDefinition<unknown> | undefined {
    return this.definitions.get(name);
  }
}

export function createEnqueue(queue: JobQueue): Enqueue {
  return async (job, payload, options = {}) => {
    assertValidPayload(job, payload);
    const delaySeconds = options.delaySeconds === undefined ? undefined : clampDelay(options.delaySeconds);
    await queue.send({ job: job.name, payload }, delaySeconds === undefined ? undefined : { delaySeconds });
  };
}

export interface DispatchDeps {
  registry: JobRegistry;
  reportError: ReportError;
  log: Logger;
}

export async function dispatchBatch(batch: MessageBatch<unknown>, deps: DispatchDeps): Promise<void> {
  for (const message of batch.messages) {
    await dispatchMessage(message, deps);
  }
}

async function dispatchMessage(message: Message<unknown>, { registry, reportError, log }: DispatchDeps): Promise<void> {
  const reject = async (problem: string, details: Record<string, unknown> = {}) => {
    await reportError(new Error(problem), { source: "jobs.dispatch", messageId: message.id, ...details });
    message.ack();
  };

  const envelope = jobMessageSchema.safeParse(message.body);
  if (!envelope.success) return reject("Malformed job message");
  const { job } = envelope.data;
  const definition = registry.get(job);
  if (!definition) return reject(`Unknown job "${job}"`);
  const payload = definition.ref.schema.safeParse(envelope.data.payload);
  if (!payload.success) return reject(`Invalid payload for job "${job}"`, { issues: payload.error.issues });

  try {
    await definition.handler(payload.data, { attempt: message.attempts });
    message.ack();
  } catch (error) {
    if (message.attempts < MAX_ATTEMPTS) {
      const delaySeconds = retryDelaySeconds(error, message.attempts);
      log.warn("Job failed; retrying", { job, attempt: message.attempts, delaySeconds, error });
      message.retry({ delaySeconds });
      return;
    }
    if (definition.options.onGiveUp) {
      try {
        await definition.options.onGiveUp(payload.data, error);
      } catch (giveUpError) {
        await reportError(giveUpError, { source: `${job}.onGiveUp` });
      }
    }
    await reportError(error, { source: job, attempts: message.attempts });
    // Deviation from the architecture (which sends given-up messages on to the DLQ): the give-up is
    // already handled and reported here, so the message is acked. The DLQ (max_retries 3 in
    // wrangler.jsonc) then only receives messages whose consumer crashed before acking or retrying.
    message.ack();
  }
}

function retryDelaySeconds(error: unknown, attempt: number): number {
  return clampDelay(error instanceof RetryAfterError ? error.retryAfterSeconds : BASE_RETRY_SECONDS * 2 ** attempt);
}

function clampDelay(seconds: number): number {
  return Math.min(Math.max(0, Math.ceil(seconds)), MAX_DELAY_SECONDS);
}

export async function drainDeadLetters(batch: MessageBatch<unknown>, reportError: ReportError): Promise<void> {
  for (const message of batch.messages) {
    const envelope = jobMessageSchema.safeParse(message.body);
    const job = envelope.success ? envelope.data.job : "unknown";
    await reportError(new Error(`Job "${job}" was dead-lettered`), {
      source: "jobs.dlq",
      messageId: message.id,
      attempts: message.attempts,
    });
    message.ack();
  }
}

// --- Debounce ---------------------------------------------------------------------------------

export const DEBOUNCED_JOB_NAME = "debounced";

export const debouncedPayloadSchema = z.object({
  key: z.string(),
  version: z.number().int(),
  maxWaitSeconds: z.number().nonnegative(),
});
export type DebouncedPayload = z.infer<typeof debouncedPayloadSchema>;

interface DebounceRow {
  job: string;
  version: number;
  first_at: number;
  payload: string;
}

export function createDebounce(deps: {
  db: Db;
  clock: Clock;
  enqueue: Enqueue;
  debouncedJob: JobRef<DebouncedPayload>;
}): Debounce {
  const { db, clock, enqueue, debouncedJob } = deps;
  return async (job, key, payload, { windowSeconds, maxWaitSeconds }) => {
    assertValidPayload(job, payload);
    const rowKey = `${job.name}:${key}`;
    const row = await db.first<{ version: number }>(
      `INSERT INTO debounce (key, job, version, first_at, payload) VALUES (?1, ?2, 1, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET version = version + 1, job = excluded.job, payload = excluded.payload
       RETURNING version`,
      rowKey,
      job.name,
      clock.now().toMillis(),
      JSON.stringify(payload),
    );
    if (!row) throw new Error(`Debounce upsert for "${rowKey}" returned no row`);
    await enqueue(debouncedJob, { key: rowKey, version: row.version, maxWaitSeconds }, { delaySeconds: windowSeconds });
  };
}

/**
 * Handles the delayed `core.debounced` message. Only the message carrying the latest version fires
 * (or any message once max wait has passed); it claims the row by deleting it, then enqueues the
 * target job. The architecture runs the target inline; enqueueing instead gives the target its own
 * retries and `onGiveUp`, since the claimed row can't be re-read by a retried debounce message.
 */
export function createDebouncedHandler(deps: {
  db: Db;
  clock: Clock;
  registry: JobRegistry;
  enqueue: Enqueue;
}): JobHandler<DebouncedPayload> {
  const { db, clock, registry, enqueue } = deps;
  return async ({ key, version, maxWaitSeconds }) => {
    const row = await db.first<DebounceRow>("SELECT job, version, first_at, payload FROM debounce WHERE key = ?", key);
    if (!row) return;
    const waitedMs = clock.now().toMillis() - row.first_at;
    if (row.version !== version && waitedMs < maxWaitSeconds * 1000) return;

    const target = registry.get(row.job);
    if (!target) throw new Error(`Debounced job "${row.job}" is not defined`);

    const claim = await db.run("DELETE FROM debounce WHERE key = ? AND version = ?", key, row.version);
    if (claim.changes === 0) return;
    try {
      await enqueue(target.ref, JSON.parse(row.payload));
    } catch (error) {
      await db.run(
        `INSERT INTO debounce (key, job, version, first_at, payload) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
        key,
        row.job,
        row.version,
        row.first_at,
        row.payload,
      );
      throw error;
    }
  };
}

function assertValidPayload<P>(job: JobRef<P>, payload: P): void {
  const result = job.schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid payload for job "${job.name}": ${result.error.message}`);
  }
}
