import {
  type AnyViewResponse,
  type BlockAction,
  type BlockElementAction,
  type GlobalShortcut,
  SlackApp,
  type SlashCommand,
  type ViewSubmission,
} from "slack-edge";
import type { ReportError } from "../core/errors";
import { runIsolated } from "../core/errors";
import type { Logger } from "../core/log";
import { helpText, parseCommandText, unknownCommandText } from "./commands";
import { composeHome, type HomeStates, parseHomeStates } from "./home";
import {
  type ActionRequest,
  type CommandReply,
  type CommandRequest,
  HELP_COMMAND,
  type OrNothing,
  type ShortcutRequest,
  type SlackHandlers,
  type ViewSubmissionAck,
  type ViewSubmissionRequest,
} from "./registry";
import type { SlackClient } from "./types";

export interface SlackGatewayDeps {
  signingSecret: string;
  botToken: string;
  handlers: SlackHandlers;
  slack: SlackClient;
  reportError: ReportError;
  log: Logger;
}

export interface SlackGateway {
  /** Handles `POST /slack/events`: events, interactivity and the slash command share one URL. */
  handle(request: Request, ctx: ExecutionContext): Promise<Response>;
}

export const COMMAND_FAILED_TEXT = "Sorry, that failed. The Nathan admins have been told.";
const ACK_FAILED = { status: 500, body: "" } as const;

/** What happened in the ack, for the lazy listener that slack-edge runs right after it. */
type AckOutcome = { kind: "accepted" } | { kind: "rejected" } | { kind: "failed"; error: unknown };
const ACCEPTED: AckOutcome = { kind: "accepted" };
const REJECTED: AckOutcome = { kind: "rejected" };

/**
 * The slack-edge adapter. slack-edge is used directly rather than via slack-cloudflare-workers
 * (architecture §1): that package only re-exports slack-edge plus multi-workspace KV OAuth
 * stores, which a single-workspace app doesn't need. Rules (research: slack-app-framework):
 * - `authorize` is cached per isolate, because slack-edge's default calls auth.test before every ack.
 * - Lazy listeners start after the ack, and only run when it succeeded. slack-edge would run them
 *   even after a throwing ack or a view submission rejected with inline errors.
 * - A throwing ack is reported from the lazy phase, so reporting never delays Slack's 3s ack.
 */
export function createSlackGateway({
  signingSecret,
  botToken,
  handlers,
  slack,
  reportError,
  log,
}: SlackGatewayDeps): SlackGateway {
  const identity = memoizeUntilFailure(() => slack.authTest());
  const app = new SlackApp({
    env: { SLACK_SIGNING_SECRET: signingSecret, SLACK_LOGGING_LEVEL: "WARN" },
    startLazyListenerAfterAck: true,
    authorize: async () => {
      const { botId, botUserId } = await identity();
      return { botToken, botId, botUserId, botScopes: [] };
    },
  });

  // slack-edge passes the same request object to the ack and then to the lazy listener.
  const outcomes = new WeakMap<object, AckOutcome>();

  async function runAck<A>(key: object, ack: () => Promise<A>, isAccepted: (result: A) => boolean) {
    try {
      const result = await ack();
      outcomes.set(key, isAccepted(result) ? ACCEPTED : REJECTED);
      return { ok: true as const, result };
    } catch (error) {
      outcomes.set(key, { kind: "failed", error });
      return { ok: false as const };
    }
  }

  function afterAck(source: string, lazy: ((key: object) => Promise<void>) | undefined) {
    return async (key: object) => {
      const outcome = outcomes.get(key);
      if (outcome?.kind === "failed") return reportError(outcome.error, { source, phase: "ack" });
      if (outcome?.kind === "accepted" && lazy) await runIsolated(source, () => lazy(key), reportError);
    };
  }

  for (const [callbackId, { featureId, handler }] of handlers.shortcuts) {
    const lazy = handler.lazy?.bind(handler);
    app.globalShortcut(
      callbackId,
      async (req) => {
        const outcome = await runAck(
          req,
          () => handler.ack(toShortcutRequest(req.payload)),
          () => true,
        );
        return outcome.ok ? undefined : ACK_FAILED;
      },
      afterAck(`${featureId}.shortcut:${callbackId}`, lazy && ((req) => lazy(toShortcutRequest(shortcutPayload(req))))),
    );
  }

  for (const [callbackId, { featureId, handler }] of handlers.viewSubmissions) {
    const lazy = handler.lazy?.bind(handler);
    app.viewSubmission(
      callbackId,
      async (req) => {
        const outcome = await runAck(
          req,
          () => handler.ack(toViewSubmissionRequest(req.payload)),
          (ack) => !(ack && "errors" in ack),
        );
        return outcome.ok ? toViewResponse(outcome.result) : ACK_FAILED;
      },
      afterAck(
        `${featureId}.view:${callbackId}`,
        lazy && ((req) => lazy(toViewSubmissionRequest(viewSubmissionPayload(req)))),
      ),
    );
  }

  for (const [actionId, { featureId, handler }] of handlers.actions) {
    const lazy = handler.lazy?.bind(handler);
    app.action(
      actionId,
      async (req) => {
        const outcome = await runAck(
          req,
          async () => handler.ack?.(toActionRequest(req.payload, actionId)),
          () => true,
        );
        return outcome.ok ? undefined : ACK_FAILED;
      },
      afterAck(
        `${featureId}.action:${actionId}`,
        lazy && ((req) => lazy(toActionRequest(blockActionPayload(req), actionId))),
      ),
    );
  }

  async function publishHome(userId: string, states: HomeStates) {
    const view = await composeHome(
      handlers.homeSections,
      userId,
      (featureId, error) => reportError(error, { source: `${featureId}.home`, userId }),
      states,
    );
    await slack.publishHome(userId, view);
  }

  // A home button only re-renders the App Home, after the ack, with its value as its section's state.
  for (const [actionId, { featureId }] of handlers.homeButtons) {
    app.action(
      actionId,
      async () => undefined,
      async (req) => {
        const request = toActionRequest(blockActionPayload(req), actionId);
        const states = { ...parseHomeStates(request.view?.privateMetadata), [featureId]: request.value ?? "" };
        await runIsolated(
          `${featureId}.home_button:${actionId}`,
          () => publishHome(request.userId, states),
          reportError,
        );
      },
    );
  }

  // Every button sends block_actions, including link buttons nobody handles ("Open PR"). slack-edge
  // uses the first matching listener, so this catch-all only sees unregistered actions; without it
  // slack-edge would answer 404 (a warning icon in Slack) and console.log the whole payload.
  app.action(/.*/, async (req) => {
    log.debug("Ignored unhandled Slack action", { actionId: req.payload.actions[0]?.action_id });
  });

  const helpEntries = [...handlers.commands].map(([name, { handler }]) => ({
    name,
    description: handler.description,
    usage: handler.usage,
  }));
  const toCommandRequest = (payload: SlashCommand, args: string): CommandRequest => ({
    userId: payload.user_id,
    channelId: payload.channel_id,
    triggerId: payload.trigger_id,
    command: payload.command,
    args,
    respond: (reply) => slack.respond(payload.response_url, reply),
  });
  // The manifest defines one slash command (/nathan, or /nathan-staging), so match any.
  app.command(
    /.*/,
    async (req) => {
      const { command, text } = req.payload;
      const { subcommand, args } = parseCommandText(text);
      if (subcommand === "" || subcommand === HELP_COMMAND) return helpText(command, helpEntries);
      const registered = handlers.commands.get(subcommand);
      if (!registered) return unknownCommandText(command, subcommand, helpEntries);
      const { handler } = registered;
      const outcome = await runAck(
        req,
        async () => handler.ack?.(toCommandRequest(req.payload, args)),
        () => true,
      );
      return outcome.ok ? toCommandResponse(outcome.result) : COMMAND_FAILED_TEXT;
    },
    async (req) => {
      const { subcommand, args } = parseCommandText(req.payload.text);
      const registered = handlers.commands.get(subcommand);
      if (!registered) return;
      const { featureId, handler } = registered;
      const lazy = handler.lazy?.bind(handler);
      await afterAck(
        `${featureId}.command:${subcommand}`,
        lazy && (() => lazy(toCommandRequest(req.payload, args))),
      )(req);
    },
  );

  app.event("app_home_opened", async ({ payload }) => {
    if (payload.tab !== "home") return;
    await runIsolated("slack.app_home", () => publishHome(payload.user, {}), reportError);
  });

  return { handle: (request, ctx) => app.run(request, ctx) };
}

// slack-edge types the lazy argument per listener; afterAck works on the untyped request object.
const shortcutPayload = (req: object) => (req as { payload: GlobalShortcut }).payload;
const viewSubmissionPayload = (req: object) => (req as { payload: ViewSubmission }).payload;
const blockActionPayload = (req: object) => (req as { payload: BlockAction<BlockElementAction> }).payload;

function toShortcutRequest(payload: GlobalShortcut): ShortcutRequest {
  return { userId: payload.user.id, triggerId: payload.trigger_id };
}

function toViewSubmissionRequest(payload: ViewSubmission): ViewSubmissionRequest {
  return {
    userId: payload.user.id,
    triggerId: payload.trigger_id,
    callbackId: payload.view.callback_id,
    viewId: payload.view.id,
    viewHash: payload.view.hash,
    privateMetadata: payload.view.private_metadata ?? "",
    values: payload.view.state.values,
  };
}

function toViewResponse(ack: OrNothing<ViewSubmissionAck>): AnyViewResponse | undefined {
  if (!ack) return undefined;
  if ("errors" in ack) return { response_action: "errors", errors: ack.errors };
  if ("update" in ack) return { response_action: "update", view: ack.update };
  if ("push" in ack) return { response_action: "push", view: ack.push };
  return { response_action: "clear" };
}

function toActionRequest(payload: BlockAction<BlockElementAction>, actionId: string): ActionRequest {
  const action = payload.actions.find((a) => a.action_id === actionId) ?? payload.actions[0];
  const value = (action as { value?: unknown } | undefined)?.value;
  const request: ActionRequest = {
    userId: payload.user.id,
    triggerId: payload.trigger_id,
    actionId,
    blockId: action?.block_id ?? "",
    value: typeof value === "string" ? value : undefined,
  };
  if ("view" in payload && payload.view) {
    const { view } = payload;
    request.view = {
      id: view.id,
      hash: view.hash,
      callbackId: view.callback_id,
      privateMetadata: view.private_metadata ?? "",
      values: view.state.values,
    };
  }
  if ("channel" in payload && payload.channel && payload.message) {
    request.message = { channelId: payload.channel.id, ts: payload.message.ts };
  }
  return request;
}

function toCommandResponse(reply: OrNothing<CommandReply>) {
  if (reply === undefined) return undefined;
  return typeof reply === "string" ? reply : { response_type: "ephemeral" as const, ...reply };
}

/** Caches a successful result for the isolate's lifetime; a failure is retried on the next call. */
function memoizeUntilFailure<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
