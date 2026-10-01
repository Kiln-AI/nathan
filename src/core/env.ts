import type { JobMessage } from "./jobs";

/** Worker bindings, declared in wrangler.jsonc. Secrets are read with `requireSecret`. */
export interface Env {
  DB: D1Database;
  NATHAN_KV: KVNamespace;
  JOBS: Queue<JobMessage>;
  NATHAN_ENV: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export function requireSecret(env: object, name: string): string {
  const value: unknown = (env as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing secret ${name}. Set it with: wrangler secret put ${name} --env <env>`);
  }
  return value;
}
