import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";
import type { Db } from "../core/db";
import { type ReportError, runIsolated } from "../core/errors";
import type { Logger } from "../core/log";
import type { Clock } from "../core/time";
import { normalizeLogin } from "./normalize";

/** The events the GitHub App subscribes to (docs/setup.md). */
export const GITHUB_EVENTS = ["pull_request", "pull_request_review", "check_run", "status"] as const;
export type GitHubEventName = (typeof GITHUB_EVENTS)[number];

/**
 * A verified, deduplicated delivery. It says which PR(s) to recompute; the state itself is always
 * re-read from GitHub (spec §5), so handlers should not trust payload details for state.
 */
export interface GitHubWebhookEvent {
  deliveryId: string;
  name: GitHubEventName;
  action: string | null;
  /** Who caused the event; bots as "name[bot]". */
  sender: string | null;
  /** "owner/name". */
  repo: string | null;
  /**
   * PRs in `repo` the event is about. Empty for `status` events and for check runs on fork PRs:
   * resolve `headSha` with `reader.openPullRequestsForCommit` (or a stored head SHA index).
   */
  pullRequests: number[];
  /** The commit: the PR head, the check run's head, or the status's commit. */
  headSha: string | null;
  /** The raw payload, for details a handler records (e.g. the requested reviewer). */
  payload: Record<string, unknown>;
}

/**
 * Must only record and enqueue, and finish in well under a second: GitHub gives up after 10s and
 * never redelivers. The hourly sweep is the backstop for anything missed.
 */
export type GitHubWebhookHandler = (event: GitHubWebhookEvent) => Promise<void>;

/** What a feature declares through `registrar.github`. */
export interface GitHubRegistry {
  on(event: GitHubEventName, handler: GitHubWebhookHandler): void;
}

interface RegisteredHandler {
  featureId: string;
  handler: GitHubWebhookHandler;
}

/** All features' webhook handlers. Several features may handle the same event. */
export class GitHubHandlers {
  private readonly byEvent = new Map<string, RegisteredHandler[]>();

  forFeature(featureId: string): GitHubRegistry {
    return {
      on: (event, handler) => {
        if (!isGitHubEventName(event)) {
          throw new Error(`GitHub event "${event}" isn't one Nathan subscribes to (${GITHUB_EVENTS.join(", ")})`);
        }
        this.byEvent.set(event, [...this.handlersFor(event), { featureId, handler }]);
      },
    };
  }

  handlersFor(event: string): readonly RegisteredHandler[] {
    return this.byEvent.get(event) ?? [];
  }
}

function isGitHubEventName(name: string): name is GitHubEventName {
  return (GITHUB_EVENTS as readonly string[]).includes(name);
}

// ---- Payload parsing -----------------------------------------------------------------------

const account = z.object({ login: z.string(), type: z.string().optional() });
const common = z.object({
  action: z.string().optional(),
  sender: account.nullish(),
  repository: z.object({ id: z.number(), full_name: z.string() }).nullish(),
});
const pullRequestPayload = z.object({
  pull_request: z.object({ number: z.number().int(), head: z.object({ sha: z.string() }) }),
});
const checkRunPayload = z.object({
  check_run: z.object({
    head_sha: z.string(),
    pull_requests: z.array(
      z.object({ number: z.number().int(), base: z.object({ repo: z.object({ id: z.number() }) }).optional() }),
    ),
  }),
});
const statusPayload = z.object({ sha: z.string() });

/** Extracts the PR key(s) and commit. Fields that are missing or malformed come back empty. */
export function parseWebhookEvent(
  name: GitHubEventName,
  deliveryId: string,
  payload: Record<string, unknown>,
): GitHubWebhookEvent {
  const base = common.safeParse(payload).data;
  const repository = base?.repository ?? null;
  const target = extractTarget(name, payload, repository?.id ?? null);
  return {
    deliveryId,
    name,
    action: base?.action ?? null,
    sender: base?.sender ? normalizeLogin({ __typename: base.sender.type ?? "User", login: base.sender.login }) : null,
    repo: repository?.full_name ?? null,
    ...target,
    payload,
  };
}

function extractTarget(
  name: GitHubEventName,
  payload: unknown,
  repositoryId: number | null,
): { pullRequests: number[]; headSha: string | null } {
  const none = { pullRequests: [], headSha: null };
  switch (name) {
    case "pull_request":
    case "pull_request_review": {
      const pr = pullRequestPayload.safeParse(payload).data?.pull_request;
      return pr ? { pullRequests: [pr.number], headSha: pr.head.sha } : none;
    }
    case "check_run": {
      const run = checkRunPayload.safeParse(payload).data?.check_run;
      if (!run) return none;
      // Same-repo PRs only; fork PRs come with an empty list (research: webhooks §2).
      const prs = run.pull_requests.filter((pr) => pr.base === undefined || pr.base.repo.id === repositoryId);
      return { pullRequests: prs.map((pr) => pr.number), headSha: run.head_sha };
    }
    case "status": {
      const status = statusPayload.safeParse(payload).data;
      return status ? { pullRequests: [], headSha: status.sha } : none;
    }
  }
}

// ---- Route -----------------------------------------------------------------------------------

export interface GitHubWebhookRouteDeps {
  secret: string;
  handlers: GitHubHandlers;
  db: Db;
  clock: Clock;
  reportError: ReportError;
  log: Logger;
}

const SIGNATURE = /^sha256=[0-9a-f]{64}$/i;

/** `POST /github/webhooks`: verify, dedupe, hand the parsed event to each handler, answer 202. */
export function createGitHubWebhookRoute({ secret, handlers, db, clock, reportError, log }: GitHubWebhookRouteDeps) {
  return {
    async handle(request: Request): Promise<Response> {
      const body = await request.text();
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      // verify() needs the exact raw bytes, before any JSON parsing.
      if (!SIGNATURE.test(signature) || body === "" || !(await verify(secret, body, signature))) {
        log.warn("Rejected a GitHub webhook with a missing or bad signature");
        return new Response("Bad signature", { status: 401 });
      }
      const deliveryId = request.headers.get("x-github-delivery");
      const name = request.headers.get("x-github-event");
      if (!deliveryId || !name) return new Response("Missing X-GitHub-Delivery or X-GitHub-Event", { status: 400 });
      const payload = parseJsonObject(body);
      if (!payload) return new Response("Body is not a JSON object", { status: 400 });

      // `ping` and events nobody handles are acknowledged without recording them.
      const registered = handlers.handlersFor(name);
      if (!isGitHubEventName(name) || registered.length === 0) return new Response(null, { status: 202 });

      const claim = await db.run(
        "INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
        deliveryId,
        clock.now().toMillis(),
      );
      if (claim.changes === 0) return new Response("Already delivered", { status: 200 });

      const event = parseWebhookEvent(name, deliveryId, payload);
      await Promise.all(
        registered.map(({ featureId, handler }) =>
          runIsolated(`${featureId}.github:${name}`, () => handler(event), reportError),
        ),
      );
      return new Response(null, { status: 202 });
    },
  };
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
