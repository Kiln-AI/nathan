// Small Block Kit builders. They cover what Nathan's messages, modals and App Home use, and
// enforce the Slack length limits that would otherwise make an API call fail.
import type {
  ActionsBlock,
  AnyDescriptionOption,
  AnyRichTextSectionElement,
  Button,
  Checkboxes,
  ContextBlock,
  DividerBlock,
  HeaderBlock,
  MrkdwnTextField,
  MultiUsersSelect,
  PlainTextField,
  PlainTextInput,
  RichTextBlock,
  RichTextSectionText,
  SectionBlock,
  URLInput,
  ViewInputBlock,
} from "slack-edge";
import type { HomeBlock, HomeTabView, ModalBlock, ModalView } from "./types";

export const MAX_SECTION_TEXT = 3000;
export const MAX_HEADER_TEXT = 150;
export const MAX_BUTTON_TEXT = 75;
export const MAX_VIEW_TITLE = 24;
export const MAX_CONTEXT_ELEMENTS = 10;
export const MAX_MESSAGE_BLOCKS = 50;
export const MAX_VIEW_BLOCKS = 100;

// ---- Text ---------------------------------------------------------------------------------

/** Escapes the three characters mrkdwn treats as control characters. */
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function link(url: string, label: string): string {
  return `<${url}|${escapeText(label)}>`;
}

/** A mention that notifies the user when posted in a new message. */
export function mention(slackUserId: string): string {
  return `<@${slackUserId}>`;
}

export function channelLink(channelId: string): string {
  return `<#${channelId}>`;
}

/** Cuts `text` to at most `max` UTF-16 code units, ending with "…" when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  // Don't split an emoji or other astral character, which would leave a lone surrogate.
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return `${text.slice(0, end)}…`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function mrkdwn(text: string): MrkdwnTextField {
  return { type: "mrkdwn", text: truncate(text, MAX_SECTION_TEXT) };
}

export function plainText(text: string, max = MAX_SECTION_TEXT): PlainTextField {
  return { type: "plain_text", text: truncate(text, max), emoji: true };
}

// ---- Blocks -------------------------------------------------------------------------------

export function header(text: string): HeaderBlock {
  return { type: "header", text: plainText(text, MAX_HEADER_TEXT) };
}

export function section(
  text: string,
  options: { accessory?: SectionBlock["accessory"]; fields?: string[]; blockId?: string } = {},
): SectionBlock {
  const block: SectionBlock = { type: "section", text: mrkdwn(text) };
  if (options.fields) block.fields = options.fields.map(mrkdwn);
  if (options.accessory) block.accessory = options.accessory;
  if (options.blockId) block.block_id = options.blockId;
  return block;
}

/** Small grey text. Slack allows at most 10 elements; extras are dropped. */
export function context(...texts: string[]): ContextBlock {
  return { type: "context", elements: texts.slice(0, MAX_CONTEXT_ELEMENTS).map(mrkdwn) };
}

/**
 * Lines (joined with newlines) packed into as few sections as Slack's text limit allows. A line is
 * never split across sections; one longer than the limit on its own is truncated.
 */
export function sectionsFromLines(lines: readonly string[]): SectionBlock[] {
  const texts: string[] = [];
  let current: string | undefined;
  for (const line of lines) {
    const fitted = truncate(line, MAX_SECTION_TEXT);
    if (current !== undefined && current.length + 1 + fitted.length <= MAX_SECTION_TEXT) {
      current = `${current}\n${fitted}`;
    } else {
      if (current !== undefined) texts.push(current);
      current = fitted;
    }
  }
  if (current !== undefined) texts.push(current);
  return texts.map((text) => section(text));
}

/** Splits blocks into consecutive groups of at most `size`, e.g. one message each. */
export function chunkBlocks<B>(blocks: readonly B[], size = MAX_MESSAGE_BLOCKS): B[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const chunks: B[][] = [];
  for (let start = 0; start < blocks.length; start += size) chunks.push(blocks.slice(start, start + size));
  return chunks;
}

// ---- Rich text ----------------------------------------------------------------------------

export type RichTextElement = AnyRichTextSectionElement;
type RichTextStyle = NonNullable<RichTextSectionText["style"]>;

export const richText = {
  text(text: string, style?: RichTextStyle): RichTextElement {
    return style ? { type: "text", text, style } : { type: "text", text };
  },
  link(url: string, text: string, style?: RichTextStyle): RichTextElement {
    return style ? { type: "link", url, text, style } : { type: "link", url, text };
  },
  /**
   * A user pill. Unlike mrkdwn mentions, dry run can't defuse it, so use it only where it never
   * notifies: the App Home and ephemeral replies.
   */
  user(slackUserId: string): RichTextElement {
    return { type: "user", user_id: slackUserId };
  },
};

/** A bulleted list, one item per entry. */
export function richTextList(items: readonly (readonly RichTextElement[])[]): RichTextBlock {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_list",
        style: "bullet",
        elements: items.map((elements) => ({ type: "rich_text_section", elements: [...elements] })),
      },
    ],
  };
}

export function divider(): DividerBlock {
  return { type: "divider" };
}

export function actions(elements: ActionsBlock["elements"], blockId?: string): ActionsBlock {
  return blockId ? { type: "actions", block_id: blockId, elements } : { type: "actions", elements };
}

export interface InputOptions {
  blockId: string;
  label: string;
  element: ViewInputBlock["element"];
  optional?: boolean;
  hint?: string;
  /** Sends a block_actions payload as the user fills the input (e.g. to look something up). */
  dispatchAction?: boolean;
}

export function input({ blockId, label, element, optional, hint, dispatchAction }: InputOptions): ViewInputBlock {
  const block: ViewInputBlock = { type: "input", block_id: blockId, label: plainText(label, 2000), element };
  if (optional) block.optional = true;
  if (hint) block.hint = plainText(hint, 2000);
  if (dispatchAction) block.dispatch_action = true;
  return block;
}

// ---- Elements -----------------------------------------------------------------------------

export function button(options: {
  text: string;
  actionId: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
}): Button {
  const element: Button = {
    type: "button",
    action_id: options.actionId,
    text: plainText(options.text, MAX_BUTTON_TEXT),
  };
  if (options.value !== undefined) element.value = options.value;
  if (options.url) element.url = options.url;
  if (options.style) element.style = options.style;
  return element;
}

export function urlInput(options: { actionId: string; placeholder?: string; initialValue?: string }): URLInput {
  const element: URLInput = { type: "url_text_input", action_id: options.actionId };
  if (options.placeholder) element.placeholder = plainText(options.placeholder, 150);
  if (options.initialValue) element.initial_value = options.initialValue;
  return element;
}

export function textInput(options: {
  actionId: string;
  multiline?: boolean;
  placeholder?: string;
  initialValue?: string;
  maxLength?: number;
}): PlainTextInput {
  const element: PlainTextInput = { type: "plain_text_input", action_id: options.actionId };
  if (options.multiline) element.multiline = true;
  if (options.placeholder) element.placeholder = plainText(options.placeholder, 150);
  if (options.initialValue) element.initial_value = options.initialValue;
  if (options.maxLength) element.max_length = options.maxLength;
  return element;
}

export function multiUsersSelect(options: {
  actionId: string;
  placeholder?: string;
  initialUsers?: string[];
}): MultiUsersSelect {
  const element: MultiUsersSelect = { type: "multi_users_select", action_id: options.actionId };
  if (options.placeholder) element.placeholder = plainText(options.placeholder, 150);
  if (options.initialUsers?.length) element.initial_users = options.initialUsers;
  return element;
}

export interface CheckboxOption {
  value: string;
  text: string;
  description?: string;
}

export function checkboxes(options: {
  actionId: string;
  options: CheckboxOption[];
  initialValues?: string[];
}): Checkboxes {
  const toOption = ({ value, text, description }: CheckboxOption): AnyDescriptionOption => {
    const option: AnyDescriptionOption = { value, text: plainText(text, 75) };
    if (description) option.description = plainText(description, 75);
    return option;
  };
  const element: Checkboxes = {
    type: "checkboxes",
    action_id: options.actionId,
    options: options.options.map(toOption),
  };
  const initial = options.options.filter((o) => options.initialValues?.includes(o.value));
  if (initial.length > 0) element.initial_options = initial.map(toOption);
  return element;
}

// ---- Views --------------------------------------------------------------------------------

export function modal(options: {
  callbackId: string;
  title: string;
  blocks: ModalBlock[];
  submit?: string;
  close?: string;
  privateMetadata?: string;
}): ModalView {
  const view: ModalView = {
    type: "modal",
    callback_id: options.callbackId,
    title: plainText(options.title, MAX_VIEW_TITLE),
    blocks: options.blocks,
  };
  if (options.submit) view.submit = plainText(options.submit, MAX_VIEW_TITLE);
  if (options.close) view.close = plainText(options.close, MAX_VIEW_TITLE);
  if (options.privateMetadata !== undefined) view.private_metadata = options.privateMetadata;
  return view;
}

export function homeView(blocks: HomeBlock[], privateMetadata?: string): HomeTabView {
  return privateMetadata ? { type: "home", blocks, private_metadata: privateMetadata } : { type: "home", blocks };
}
