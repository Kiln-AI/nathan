import { normalizeGithubLogin } from "../../core/directory";
import type { PRData, Review, ReviewState } from "../../github";
import type { People } from "./people";
import { isFinal, type PRStatus, type PRStatusState, STATE_INFO, sameOwners } from "./status";
import type { PREvent } from "./store";

// Handoff notifications (spec §4.5): when a PR's owners change, tag the new owners in the card
// thread with what happened and what's needed. The person who acted is never tagged.

export interface HandoffInput {
  before: PRStatus;
  after: PRStatus;
  pr: PRData;
  /** Webhook events since the last refresh, oldest first. */
  events: readonly PREvent[];
  people: People;
}

interface Happening {
  /** GitHub login of whoever caused it, when known. */
  actor: string | null;
  sentence: string;
}

/** The thread reply to post, or null when nothing should be posted. */
export function describeHandoff({ before, after, pr, events, people }: HandoffInput): string | null {
  if (!getsHandoffs(after.state) || sameOwners(before.owners, after.owners)) return null;
  const newOwners = after.owners.filter((owner) => !before.owners.some((previous) => sameLogin(previous, owner)));
  const { actor, sentence } =
    before.state === "in_merge_queue" ? dequeued(after.state, events) : describe(after.state, pr, events, newOwners);
  const actorTag = actor ? people.label(actor) : null;
  const tags = people
    .tags(newOwners.filter((owner) => !actor || !sameLogin(owner, actor)))
    .filter((tag) => tag !== actorTag);
  return tags.length > 0 ? `${tags.join(" ")} — ${sentence}` : null;
}

function describe(state: PRStatusState, pr: PRData, events: readonly PREvent[], newOwners: string[]): Happening {
  switch (state) {
    case "approved":
      return byReviewer(pr, ["approved"], "approved ✅. Ready to merge.");
    case "changes_requested":
      return byReviewer(pr, ["changes_requested"], "requested changes 🔁. Over to you.");
    case "needs_rerequest":
      return byReviewer(
        pr,
        ["approved", "changes_requested", "commented", "dismissed"],
        "reviewed 💬. Re-request review or merge.",
      );
    case "awaiting_review":
      return reviewRequest(pr, events, newOwners);
    case "ci_failing":
      return { actor: null, sentence: "CI is failing on the latest push ❌. Fix CI." };
    case "conflict":
      return { actor: null, sentence: "This PR has merge conflicts ⚠️. Resolve them." };
    case "wip_title":
      // Usually the author retitling their own PR: they mustn't be tagged for it.
      return {
        actor: latest(events, "edited")?.actor ?? null,
        sentence: 'The title says WIP 🚧. Convert it to a draft, or drop "WIP" from the title.',
      };
    default:
      // Usually someone removing the last requested reviewer: they mustn't be tagged for it.
      return {
        actor: latest(events, "review_request_removed")?.actor ?? null,
        sentence: "No reviewers are requested 🙋. Request a reviewer.",
      };
  }
}

/** Drafts aren't handed off (spec §4.5); merged, closed and queued PRs have nobody to hand off to. */
function getsHandoffs(state: PRStatusState): boolean {
  return state !== "draft" && state !== "in_merge_queue" && !isFinal(state);
}

/**
 * Taken out of the merge queue without merging (its merge group failed CI, or someone removed it).
 * The review that led here is old news, so say what happened instead.
 */
function dequeued(state: PRStatusState, events: readonly PREvent[]): Happening {
  return {
    actor: latest(events, "dequeued")?.actor ?? null,
    sentence: `Removed from the merge queue 🚂. Next: ${STATE_INFO[state].nextStep}.`,
  };
}

function byReviewer(pr: PRData, states: readonly ReviewState[], what: string): Happening {
  const review = newest(pr.reviews.filter((r) => states.includes(r.state) && !sameLogin(r.author, pr.author)));
  return review
    ? { actor: review.author, sentence: `${review.author} ${what}` }
    : { actor: null, sentence: capitalize(what) };
}

function reviewRequest(pr: PRData, events: readonly PREvent[], newOwners: string[]): Happening {
  const again = newOwners.some((owner) => pr.reviews.some((review) => sameLogin(review.author, owner)));
  const verb = again ? "re-requested" : "requested";
  const request = latest(events, "review_requested");
  if (request?.actor) return { actor: request.actor, sentence: `${request.actor} ${verb} your review 👀.` };
  const ready = latest(events, "ready_for_review");
  if (ready?.actor) return { actor: ready.actor, sentence: `${ready.actor} marked this ready for review 👀.` };
  return { actor: null, sentence: `Your review is ${verb} 👀.` };
}

function latest(events: readonly PREvent[], action: string): PREvent | undefined {
  return events.filter((event) => event.event === "pull_request" && event.action === action).at(-1);
}

function newest(reviews: readonly Review[]): Review | undefined {
  return reviews.reduce<Review | undefined>(
    (best, review) => (!best || review.submittedAt > best.submittedAt ? review : best),
    undefined,
  );
}

function sameLogin(a: string, b: string): boolean {
  return normalizeGithubLogin(a) === normalizeGithubLogin(b);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
