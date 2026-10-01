import { HELP_COMMAND } from "./registry";

export interface ParsedCommand {
  /** Lowercased first word, or "" when the command had no text. */
  subcommand: string;
  args: string;
}

export function parseCommandText(text: string): ParsedCommand {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  if (space === -1) return { subcommand: trimmed.toLowerCase(), args: "" };
  return { subcommand: trimmed.slice(0, space).toLowerCase(), args: trimmed.slice(space).trim() };
}

export interface HelpEntry {
  name: string;
  description: string;
  usage?: string;
}

/** `/nathan help`, generated from the registered subcommands. */
export function helpText(command: string, entries: readonly HelpEntry[]): string {
  const all = [{ name: HELP_COMMAND, description: "Show this list" }, ...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const lines = all.map(
    ({ name, usage, description }) => `• \`${command} ${name}${usage ? ` ${usage}` : ""}\` — ${description}`,
  );
  return [`*What I can do* (\`${command} <command>\`):`, ...lines].join("\n");
}

export function unknownCommandText(command: string, subcommand: string, entries: readonly HelpEntry[]): string {
  return `I don't know \`${command} ${subcommand}\`.\n\n${helpText(command, entries)}`;
}
