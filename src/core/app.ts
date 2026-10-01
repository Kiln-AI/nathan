import { DateTime } from "luxon";
import rawConfig from "../../nathan.config";
import { features as registeredFeatures } from "../features";
import { type SlackClient, unwiredSlackClient } from "../slack";
import { type LoadedConfig, loadConfig } from "./config";
import { createDb, type Db } from "./db";
import type { Env } from "./env";
import { createErrorReporter } from "./errors";
import type { AnyFeature, Registrar, Services } from "./feature";
import { Router } from "./http";
import {
  createDebounce,
  createDebouncedHandler,
  createEnqueue,
  DEBOUNCED_JOB_NAME,
  debouncedPayloadSchema,
  dispatchBatch,
  drainDeadLetters,
  type JobQueue,
  JobRegistry,
} from "./jobs";
import { createConsoleLogger, type Logger } from "./log";
import { Scheduler } from "./scheduler";
import { type Clock, systemClock } from "./time";

/** Reserved for the platform's own jobs and tasks. */
export const CORE_ID = "core";
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;
export const STALE_DEBOUNCE_HOURS = 24;

/** Test seam: replace any external dependency. */
export interface AppOverrides {
  config?: unknown;
  features?: readonly AnyFeature[];
  clock?: Clock;
  slack?: SlackClient;
  queue?: JobQueue;
  log?: Logger;
}

export interface App {
  config: LoadedConfig;
  services: Services;
  fetch(request: Request, ctx: ExecutionContext): Promise<Response>;
  /** Runs one scheduler tick; never throws. */
  scheduled(scheduledTimeMs: number): Promise<void>;
  queue(batch: MessageBatch<unknown>): Promise<void>;
}

export function createApp(env: Env, overrides: AppOverrides = {}): App {
  const features = overrides.features ?? registeredFeatures;
  assertFeatureIds(features);
  const config = loadConfig(overrides.config ?? rawConfig, env.NATHAN_ENV, features);

  const log = overrides.log ?? createConsoleLogger({ env: config.env });
  const clock = overrides.clock ?? systemClock;
  const db = createDb(env.DB);
  const slack = overrides.slack ?? unwiredSlackClient;
  const reportError = createErrorReporter({
    log,
    db,
    clock,
    slack,
    adminChannel: config.platform.admin.slackChannel,
    envName: config.env,
  });

  const jobs = new JobRegistry();
  const enqueue = createEnqueue(overrides.queue ?? env.JOBS);
  const debouncedJob = jobs.define(
    `${CORE_ID}.${DEBOUNCED_JOB_NAME}`,
    debouncedPayloadSchema,
    createDebouncedHandler({ db, clock, registry: jobs, enqueue }),
  );
  const debounce = createDebounce({ db, clock, enqueue, debouncedJob });
  const services: Services = { slack, db, clock, log, reportError, enqueue, debounce };

  const scheduler = new Scheduler({ db, reportError });
  const router = new Router();
  router.on("GET", "/healthz", () => Response.json({ env: config.env, version: env.CF_VERSION_METADATA?.id ?? "dev" }));

  const registrarFor = <C>(featureId: string, featureConfig: C): Registrar<C> => ({
    config: featureConfig,
    services: { ...services, log: log.child({ feature: featureId }) },
    jobs: {
      define: (name, schema, handler, options) => jobs.define(`${featureId}.${name}`, schema, handler, options),
    },
    schedule: (task) => scheduler.add({ ...task, name: `${featureId}.${task.name}` }),
  });

  registerCoreTasks(registrarFor(CORE_ID, null), db);
  for (const feature of features) {
    if (config.features.has(feature.id)) feature.register(registrarFor(feature.id, config.features.get(feature.id)));
  }

  return {
    config,
    services,
    fetch: async (request, ctx) => {
      try {
        return await router.handle(request, ctx);
      } catch (error) {
        ctx.waitUntil(reportError(error, { source: "http", path: new URL(request.url).pathname }));
        return new Response("Internal error", { status: 500 });
      }
    },
    scheduled: (scheduledTimeMs) => scheduler.tick(DateTime.fromMillis(scheduledTimeMs, { zone: "utc" })),
    queue: (batch) =>
      isDeadLetterQueue(batch.queue)
        ? drainDeadLetters(batch, reportError)
        : dispatchBatch(batch, { registry: jobs, reportError, log }),
  };
}

function registerCoreTasks(registrar: Registrar<null>, db: Db): void {
  registrar.schedule({
    name: "prune",
    when: { everyHour: true },
    run: async ({ firedAt }) => {
      await db.batch([
        db.statement(
          "DELETE FROM webhook_deliveries WHERE received_at < ?",
          firedAt.minus({ days: WEBHOOK_DELIVERY_RETENTION_DAYS }).toMillis(),
        ),
        // Live debounce rows last minutes; older ones were orphaned by a failed enqueue.
        db.statement(
          "DELETE FROM debounce WHERE first_at < ?",
          firedAt.minus({ hours: STALE_DEBOUNCE_HOURS }).toMillis(),
        ),
      ]);
    },
  });
}

function isDeadLetterQueue(queueName: string): boolean {
  return queueName.endsWith("-dlq");
}

function assertFeatureIds(features: readonly AnyFeature[]): void {
  const seen = new Set<string>([CORE_ID]);
  for (const { id } of features) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Feature id "${id}" must be snake_case`);
    if (seen.has(id)) throw new Error(`Feature id "${id}" is reserved or already registered`);
    seen.add(id);
  }
}

let cached: { env: Env; app: App } | undefined;

/** One app per isolate. Throws (on every call) when the config is invalid. */
export function getApp(env: Env): App {
  if (cached?.env !== env) cached = { env, app: createApp(env) };
  return cached.app;
}
