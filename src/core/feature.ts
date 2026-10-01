import type { z } from "zod";
import type { SlackClient } from "../slack";
import type { Db } from "./db";
import type { ReportError } from "./errors";
import type { Debounce, Enqueue, JobHandler, JobOptions, JobRef } from "./jobs";
import type { Logger } from "./log";
import type { ScheduledTask } from "./scheduler";
import type { Clock } from "./time";

/**
 * A feature module. `id` is also its config key, its job/task name prefix and its table prefix.
 * Register it by adding it to `src/features/index.ts`.
 */
export interface Feature<C> {
  id: string;
  /** Validates the feature's config section (without `enabled`). */
  configSchema: z.ZodType<C>;
  /** Declares everything the feature does. Called once per isolate, only when enabled. No side effects. */
  register(registrar: Registrar<C>): void;
}

// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous list of features erases each config type
export type AnyFeature = Feature<any>;

/** Identity helper that infers `C` from `configSchema`. */
export function defineFeature<C>(feature: Feature<C>): Feature<C> {
  return feature;
}

export interface Registrar<C> {
  config: C;
  services: Services;
  jobs: {
    /** Registered as "<featureId>.<name>". */
    define<P>(name: string, schema: z.ZodType<P>, handler: JobHandler<P>, options?: JobOptions<P>): JobRef<P>;
  };
  /** Registered as "<featureId>.<name>". */
  schedule(task: ScheduledTask): void;
}

/** Shared services. The Slack and GitHub gateways and the user directory join in later phases. */
export interface Services {
  slack: SlackClient;
  db: Db;
  clock: Clock;
  log: Logger;
  reportError: ReportError;
  enqueue: Enqueue;
  debounce: Debounce;
}
