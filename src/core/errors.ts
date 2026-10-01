import type { SlackClient } from "../slack";
import type { Db } from "./db";
import type { Logger } from "./log";
import type { Clock } from "./time";

export type ErrorContext = { source: string } & Record<string, unknown>;

/** Logs an error and alerts the admin channel at most once per hour per (source, message). Never throws. */
export type ReportError = (error: unknown, context: ErrorContext) => Promise<void>;

export const ALERT_DEDUPE_MS = 60 * 60 * 1000;
/** Keeps alerts well under Slack's message length limit. */
export const MAX_ALERT_DETAILS_CHARS = 2000;

/** Thrown by job handlers that know when a retry can succeed (e.g. a rate limit reset). */
export class RetryAfterError extends Error {
  override name = "RetryAfterError";

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

export interface ErrorReporterDeps {
  log: Logger;
  db: Db;
  clock: Clock;
  slack: SlackClient;
  adminChannel: string;
  envName: string;
}

export function createErrorReporter({ log, db, clock, slack, adminChannel, envName }: ErrorReporterDeps): ReportError {
  return async (error, context) => {
    const message = errorMessage(error);
    log.error(message, { ...context, error });
    try {
      const now = clock.now().toMillis();
      const key = await sha256Hex(`${context.source}\n${message}`);
      const claim = await db.run(
        `INSERT INTO admin_alerts (key, last_posted_at) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET last_posted_at = excluded.last_posted_at
         WHERE admin_alerts.last_posted_at <= ?3`,
        key,
        now,
        now - ALERT_DEDUPE_MS,
      );
      if (claim.changes === 0) return;
      try {
        await slack.postMessage({ channel: adminChannel, text: formatAlert(envName, message, context) });
      } catch (postError) {
        // Release the slot so the next occurrence can try again.
        await db.run("DELETE FROM admin_alerts WHERE key = ? AND last_posted_at = ?", key, now);
        throw postError;
      }
    } catch (alertError) {
      log.error("Failed to post admin alert", { source: context.source, error: alertError });
    }
  };
}

/** Runs `fn`, reporting anything it throws instead of propagating it. */
export async function runIsolated(source: string, fn: () => Promise<void>, reportError: ReportError): Promise<void> {
  try {
    await fn();
  } catch (error) {
    await reportError(error, { source });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAlert(envName: string, message: string, { source, ...details }: ErrorContext): string {
  const lines = [`:rotating_light: [${envName}] \`${source}\` failed: ${message}`];
  if (Object.keys(details).length > 0) {
    let json: string;
    try {
      json = JSON.stringify(details);
    } catch {
      json = "(details not serializable)";
    }
    lines.push(`\`\`\`${truncate(json)}\`\`\``);
  }
  return lines.join("\n");
}

function truncate(text: string): string {
  return text.length <= MAX_ALERT_DETAILS_CHARS ? text : `${text.slice(0, MAX_ALERT_DETAILS_CHARS)}… (truncated)`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
