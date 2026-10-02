import { context, divider, homeView, MAX_VIEW_BLOCKS, section } from "./blocks";
import type { HomeSection, Registered } from "./registry";
import type { HomeBlock, HomeTabView } from "./types";

export const EMPTY_HOME_TEXT = "Nothing to show here yet. Run my slash command with `help` to see what I can do.";
export const SECTION_FAILED_TEXT = ":warning: This section couldn't load. The Nathan admins have been told.";
export const TRUNCATED_TEXT = "_Some items are hidden: the App Home has a 100-block limit._";

/** Reports a section's error with the owning feature as the source. */
export type ReportSectionError = (featureId: string, error: unknown) => Promise<void>;

/** Each feature's section state (the value of its last-clicked home button), by feature ID. */
export type HomeStates = Readonly<Record<string, string>>;

/** Home states round-trip through the view's private_metadata; anything unreadable is no state. */
export function parseHomeStates(privateMetadata: string | undefined): HomeStates {
  if (!privateMetadata) return {};
  try {
    const parsed: unknown = JSON.parse(privateMetadata);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/**
 * The App Home is each feature's section, in ascending `order` (ties keep registration order),
 * separated by dividers. A failing section is replaced by a notice, so others still show. The
 * states are stored in the view, so a home button can change one section and keep the others.
 */
export async function composeHome(
  sections: readonly Registered<HomeSection>[],
  userId: string,
  reportError: ReportSectionError,
  states: HomeStates = {},
): Promise<HomeTabView> {
  const ordered = [...sections].sort((a, b) => a.handler.order - b.handler.order);
  const rendered = await Promise.all(
    ordered.map(async ({ featureId, handler }): Promise<HomeBlock[]> => {
      try {
        const state = states[featureId];
        return await handler.render(state === undefined ? { userId } : { userId, state });
      } catch (error) {
        await reportError(featureId, error);
        return [context(SECTION_FAILED_TEXT)];
      }
    }),
  );

  const blocks = rendered
    .filter((part) => part.length > 0)
    .flatMap((part, index): HomeBlock[] => (index === 0 ? part : [divider(), ...part]));
  const metadata = Object.keys(states).length > 0 ? JSON.stringify(states) : undefined;
  if (blocks.length === 0) return homeView([section(EMPTY_HOME_TEXT)], metadata);
  if (blocks.length <= MAX_VIEW_BLOCKS) return homeView(blocks, metadata);
  const kept = blocks.slice(0, MAX_VIEW_BLOCKS - 1);
  if (kept.at(-1)?.type === "divider") kept.pop();
  return homeView([...kept, context(TRUNCATED_TEXT)], metadata);
}
