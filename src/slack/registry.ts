import type { EphemeralReply, HomeBlock, ModalView, ViewValues } from "./types";

// ---- Requests (Nathan's own shapes, mapped from slack-edge payloads by the gateway) --------

export interface ShortcutRequest {
  userId: string;
  /** Valid for 3 seconds: open a modal from the ack handler. */
  triggerId: string;
}

export interface ViewSubmissionRequest {
  userId: string;
  triggerId: string;
  callbackId: string;
  viewId: string;
  viewHash: string;
  privateMetadata: string;
  values: ViewValues;
}

export interface ActionRequest {
  userId: string;
  triggerId: string;
  actionId: string;
  blockId: string;
  /** The button's value, or the text of an input that dispatched the action. */
  value: string | undefined;
  /** Set when the action happened inside a modal or the App Home. */
  view?: { id: string; hash: string; callbackId: string; privateMetadata: string; values: ViewValues };
  /** Set when the action happened on a message. */
  message?: { channelId: string; ts: string };
}

export interface CommandRequest {
  userId: string;
  channelId: string;
  triggerId: string;
  /** The slash command as invoked, e.g. "/nathan" or "/nathan-staging". */
  command: string;
  /** Everything after the subcommand, trimmed. */
  args: string;
  /** Sends an ephemeral reply via the command's response_url (up to 5 times within 30 minutes). */
  respond(reply: EphemeralReply): Promise<void>;
}

export interface HomeRequest {
  userId: string;
  /** The value of the section's home button the user last clicked; undefined when the tab was just opened. */
  state?: string;
}

// ---- Handlers ------------------------------------------------------------------------------
//
// `ack` runs inside Slack's 3-second budget and must return in under 2.5s. `lazy` runs after a
// successful ack (via waitUntil, up to 30s, no retries): enqueue a job for anything that must
// not be lost. Errors in either are reported to the admin channel.

export interface ShortcutHandler {
  ack(request: ShortcutRequest): Promise<void>;
  lazy?(request: ShortcutRequest): Promise<void>;
}

/** No return value closes the modal; `errors` (block_id → message) shows inline errors and skips `lazy`. */
export type ViewSubmissionAck =
  | { errors: Record<string, string> }
  | { update: ModalView }
  | { push: ModalView }
  | { clear: true };

// biome-ignore lint/suspicious/noConfusingVoidType: lets an ack that returns nothing type-check
export type OrNothing<T> = T | void;

export interface ViewSubmissionHandler {
  ack(request: ViewSubmissionRequest): Promise<OrNothing<ViewSubmissionAck>>;
  lazy?(request: ViewSubmissionRequest): Promise<void>;
}

export interface ActionHandler {
  ack?(request: ActionRequest): Promise<void>;
  lazy?(request: ActionRequest): Promise<void>;
}

/** Shown only to the user who ran the command. */
export type CommandReply = string | EphemeralReply;

export interface CommandHandler {
  /** One line for `/nathan help`. */
  description: string;
  /** Arguments, shown after the subcommand in help, e.g. "<pr-url>". */
  usage?: string;
  ack?(request: CommandRequest): Promise<OrNothing<CommandReply>>;
  lazy?(request: CommandRequest): Promise<void>;
}

export interface HomeSection {
  /** Sections render in ascending order. */
  order: number;
  render(request: HomeRequest): Promise<HomeBlock[]>;
}

/** What a feature declares through `registrar.slack`. */
export interface SlackRegistry {
  /** A global shortcut, by its manifest callback_id. */
  shortcut(callbackId: string, handler: ShortcutHandler): void;
  /** A modal submission, by the view's callback_id. */
  viewSubmission(callbackId: string, handler: ViewSubmissionHandler): void;
  /** A block action (button, dispatched input…), by exact action_id. */
  action(actionId: string, handler: ActionHandler): void;
  /** `/nathan <name> [args]`. */
  command(name: string, handler: CommandHandler): void;
  homeSection(section: HomeSection): void;
  /**
   * A button in the feature's App Home section, by exact action_id. Clicking it re-renders the
   * App Home with the button's value as the section's `state` (e.g. a tab); opening the tab again
   * starts from no state.
   */
  homeButton(actionId: string): void;
}

// ---- Storage (core and gateway only) ----------------------------------------------------------

export interface Registered<H> {
  featureId: string;
  handler: H;
}

export const HELP_COMMAND = "help";
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;

/** All features' Slack registrations. IDs are global, so a clash between features fails at startup. */
export class SlackHandlers {
  readonly shortcuts = new Map<string, Registered<ShortcutHandler>>();
  readonly viewSubmissions = new Map<string, Registered<ViewSubmissionHandler>>();
  readonly actions = new Map<string, Registered<ActionHandler>>();
  readonly commands = new Map<string, Registered<CommandHandler>>();
  readonly homeSections: Registered<HomeSection>[] = [];
  /** Home buttons' action_ids → the feature whose section they belong to. */
  readonly homeButtons = new Map<string, Registered<null>>();

  forFeature(featureId: string): SlackRegistry {
    return {
      shortcut: (callbackId, handler) => add(this.shortcuts, "shortcut", callbackId, { featureId, handler }),
      viewSubmission: (callbackId, handler) =>
        add(this.viewSubmissions, "view submission", callbackId, { featureId, handler }),
      action: (actionId, handler) => {
        this.assertNoHomeButton(actionId);
        add(this.actions, "action", actionId, { featureId, handler });
      },
      command: (name, handler) => {
        if (!COMMAND_NAME.test(name))
          throw new Error(`Subcommand "${name}" must be lowercase letters, digits, _ and -`);
        if (name === HELP_COMMAND) throw new Error(`Subcommand "${HELP_COMMAND}" is built in`);
        add(this.commands, "subcommand", name, { featureId, handler });
      },
      homeSection: (section) => {
        this.homeSections.push({ featureId, handler: section });
      },
      homeButton: (actionId) => {
        const existing = this.actions.get(actionId);
        if (existing) throw new Error(`Slack action "${actionId}" is already registered by ${existing.featureId}`);
        add(this.homeButtons, "action", actionId, { featureId, handler: null });
      },
    };
  }

  private assertNoHomeButton(actionId: string): void {
    const existing = this.homeButtons.get(actionId);
    if (existing) throw new Error(`Slack action "${actionId}" is already registered by ${existing.featureId}`);
  }
}

function add<H>(map: Map<string, Registered<H>>, kind: string, id: string, entry: Registered<H>): void {
  const existing = map.get(id);
  if (existing) throw new Error(`Slack ${kind} "${id}" is already registered by ${existing.featureId}`);
  map.set(id, entry);
}
