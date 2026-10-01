import { context, divider, homeView, MAX_VIEW_BLOCKS, section } from "./blocks";
import type { HomeSection, Registered } from "./registry";
import type { HomeBlock, HomeTabView } from "./types";

export const EMPTY_HOME_TEXT = "Nothing to show here yet. Run my slash command with `help` to see what I can do.";
export const SECTION_FAILED_TEXT = ":warning: This section couldn't load. The Nathan admins have been told.";
export const TRUNCATED_TEXT = "_Some items are hidden: the App Home has a 100-block limit._";

/** Reports a section's error with the owning feature as the source. */
export type ReportSectionError = (featureId: string, error: unknown) => Promise<void>;

/**
 * The App Home is each feature's section, in ascending `order` (ties keep registration order),
 * separated by dividers. A failing section is replaced by a notice, so others still show.
 */
export async function composeHome(
  sections: readonly Registered<HomeSection>[],
  userId: string,
  reportError: ReportSectionError,
): Promise<HomeTabView> {
  const ordered = [...sections].sort((a, b) => a.handler.order - b.handler.order);
  const rendered = await Promise.all(
    ordered.map(async ({ featureId, handler }): Promise<HomeBlock[]> => {
      try {
        return await handler.render({ userId });
      } catch (error) {
        await reportError(featureId, error);
        return [context(SECTION_FAILED_TEXT)];
      }
    }),
  );

  const blocks = rendered
    .filter((part) => part.length > 0)
    .flatMap((part, index): HomeBlock[] => (index === 0 ? part : [divider(), ...part]));
  if (blocks.length === 0) return homeView([section(EMPTY_HOME_TEXT)]);
  if (blocks.length <= MAX_VIEW_BLOCKS) return homeView(blocks);
  const kept = blocks.slice(0, MAX_VIEW_BLOCKS - 1);
  if (kept.at(-1)?.type === "divider") kept.pop();
  return homeView([...kept, context(TRUNCATED_TEXT)]);
}
