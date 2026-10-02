import { DateTime } from "luxon";
import type { Services } from "../../core/feature";
import type { PRData } from "../../github";
import { type CardModel, type RenderedCard, renderCard, reviewerLines } from "./card";
import type { PRConfig } from "./config";
import { describeHandoff } from "./handoff";
import type { People } from "./people";
import { categorize, computeStatus, effectiveMergeable, isFinal, type PRStatusState, sameOwners } from "./status";
import { type CardLocation, NO_DRAFT_NUDGES, NO_REMINDERS, type PREvent, type PRRecord, type PRStore } from "./store";

/** PR data read earlier (by the sweep), and when the read started. */
export interface PRSnapshot {
  pr: PRData;
  readAt: DateTime;
}

/** What a Request PR form submission adds to the PR's record (spec §4.3A). */
export interface RequestFields {
  /** Empty keeps the modifiers from an earlier request. */
  modifiers: string[];
  /** Null keeps the note from an earlier request. */
  note: string | null;
  /** Slack user ID of the submitter. */
  submittedBy: string;
}

export interface PRContext {
  config: PRConfig;
  services: Services;
  store: PRStore;
  people: People;
}

/** How long a refresh may hold the lease to post a card before another may try. */
export const CARD_LEASE_MINUTES = 5;
/** Compare-and-set attempts before a refresh gives up (and its job retries). */
export const MAX_WRITE_ATTEMPTS = 3;

const FINAL_REACTION: Partial<Record<PRStatusState, string>> = {
  merged: "large_purple_circle",
  closed: "black_circle",
};

/**
 * Recomputes one PR from GitHub and brings Slack in line: store the status, then edit or create
 * the card and post any handoff. `snapshot` skips the GitHub read (the sweep already has the data).
 * `request` comes from the Request PR form: its fields are stored, an open non-draft PR always
 * gets a card, and the generic handoff is left to the request job's own reply.
 * Idempotent, so job retries are safe.
 */
export async function refreshPullRequest(
  ctx: PRContext,
  repo: string,
  number: number,
  snapshot?: PRSnapshot,
  request?: RequestFields,
): Promise<void> {
  const { store } = ctx;
  // When the GitHub data was read. Events after it aren't reflected in the data, so they're left
  // for the refresh they scheduled; the record's `refreshedAt` is this time, not the write time.
  const readAt = snapshot?.readAt ?? ctx.services.clock.now();
  const pr = snapshot ? snapshot.pr : await ctx.services.github.reader.pullRequest(repo, number);

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const before = await store.get(repo, number);
    // Compare-and-set orders writers, not data: a record from a later GitHub read is fresher, and
    // writing older data over it would undo it (e.g. un-merge a PR).
    if (before && before.refreshedAt > readAt) {
      if (!request) return;
      // The form's fields still need storing: the job's retry reads GitHub again.
      throw new Error(`A newer refresh of ${repo}#${number} overtook a review request; retrying`);
    }
    const events = await store.events(repo, number, readAt);
    const after = pr
      ? withRequest(fromPullRequest(ctx, repo, pr, before, readAt), request)
      : before && vanished(ctx, before, readAt);
    if (!after) {
      await consume(store, repo, number, events);
      return;
    }
    const written = before ? await store.update(after, before.version) : await store.insert(after);
    if (!written) continue;

    try {
      await applyEffects(ctx, before, after, pr, events, request !== undefined);
    } catch (error) {
      // Put the old status back so the retry sees the same change and redoes the effects. This is
      // compare-and-set too: if another refresh wrote in between, the restore is a no-op and a
      // failed handoff reply is lost (the card itself is still brought up to date).
      if (before) await store.restoreStatus(before, before.version + 1);
      throw error;
    }
    await consume(store, repo, number, events);
    return;
  }
  throw new Error(`Gave up refreshing ${repo}#${number}: other refreshes kept writing it`);
}

function fromPullRequest(
  ctx: PRContext,
  repo: string,
  pr: PRData,
  before: PRRecord | null,
  readAt: DateTime,
): PRRecord {
  const { config, services } = ctx;
  const category = categorize(pr.author, {
    isTeamMember: (login) => services.directory.byGithub(login) !== undefined,
    botAuthors: config.botAuthors,
  });
  const status = computeStatus(pr, {
    category,
    triager: config.triager,
    wipTitlePattern: config.wipTitlePattern,
    lastKnownMergeable: before?.mergeable,
  });
  const changed = !before || before.state !== status.state || !sameOwners(before.owners, status.owners);
  return {
    modifiers: [],
    note: null,
    submittedBy: null,
    card: null,
    cardHash: null,
    reminders: NO_REMINDERS,
    draftNudges: NO_DRAFT_NUDGES,
    version: 0,
    ...before,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    category,
    createdAt: pr.createdAt,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    headSha: pr.headSha,
    mergeable: effectiveMergeable(pr.mergeable, before?.mergeable),
    state: status.state,
    owners: status.owners,
    reviewers: reviewerLines(pr),
    stateSince: before && !changed ? before.stateSince : readAt,
    draftSince: pr.isDraft ? DateTime.max(pr.createdAt, pr.lastConvertedToDraftAt ?? pr.createdAt) : null,
    refreshedAt: readAt,
  };
}

function withRequest(record: PRRecord, request: RequestFields | undefined): PRRecord {
  if (!request) return record;
  // A re-request that leaves a field empty keeps the earlier request's value, so forgetting to
  // tick `urgent` again doesn't quietly relax the reminders.
  return {
    ...record,
    modifiers: request.modifiers.length > 0 ? request.modifiers : record.modifiers,
    note: request.note ?? record.note,
    submittedBy: request.submittedBy,
  };
}

/**
 * GitHub no longer has the PR (deleted, or transferred to another repo): finalize it as closed.
 * Null when it is already final, so there is nothing to do.
 */
function vanished(ctx: PRContext, before: PRRecord, readAt: DateTime): PRRecord | null {
  if (isFinal(before.state)) return null;
  ctx.services.log.info("PR no longer on GitHub; closing its record", { repo: before.repo, number: before.number });
  return { ...before, state: "closed", owners: [], stateSince: readAt, refreshedAt: readAt };
}

async function applyEffects(
  ctx: PRContext,
  before: PRRecord | null,
  after: PRRecord,
  pr: PRData | null,
  events: readonly PREvent[],
  fromRequestForm: boolean,
): Promise<void> {
  const { services, store, people } = ctx;
  // The card shows the PR's age, so the hash (and the card) changes as time passes: each sweep
  // edits every open card about once an hour. That's deliberate, to keep the age current.
  const rendered = renderCard(cardModel(after, pr), people, services.clock.now());
  const hash = await hashCard(rendered);
  const card = before?.card;
  if (!before || !card) {
    if (pr && wantsCard(pr, fromRequestForm)) await postCard(ctx, after, rendered, hash);
    return;
  }

  if (hash !== before.cardHash) {
    await services.slack.updateMessage({ ...card, ...rendered });
    await store.saveCardHash(after.repo, after.number, hash);
  }
  const reaction = FINAL_REACTION[after.state];
  if (reaction) {
    if (!isFinal(before.state)) await services.slack.addReaction({ ...card, name: reaction });
    return;
  }
  if (!pr || fromRequestForm) return;
  const reply = describeHandoff({ before, after, pr, events, people });
  if (reply) await services.slack.postMessage({ channel: card.channel, thread_ts: card.ts, text: reply });
}

/**
 * A form request (spec §4.3A) is for an open, non-draft PR; a GitHub-originated one (§4.3B) is
 * reviewers requested on an open, non-draft PR.
 */
function wantsCard(pr: PRData, fromRequestForm: boolean): boolean {
  if (pr.state !== "open" || pr.isDraft) return false;
  return fromRequestForm || pr.pendingReviewers.length + pr.pendingTeams.length > 0;
}

/**
 * The PR's card, posting it first when it has none: a reminder is always a reply in the card's
 * thread (spec §4.4). Null when another refresh holds the lease to post it.
 */
export async function ensureCard(ctx: PRContext, record: PRRecord, pr: PRData): Promise<CardLocation | null> {
  if (record.card) return record.card;
  const rendered = renderCard(cardModel(record, pr), ctx.people, ctx.services.clock.now());
  return postCard(ctx, record, rendered, await hashCard(rendered));
}

/** Posts and records the card. Null when another refresh holds the lease, or already posted it. */
async function postCard(
  ctx: PRContext,
  record: PRRecord,
  rendered: RenderedCard,
  hash: string,
): Promise<CardLocation | null> {
  const { services, store, config } = ctx;
  const now = services.clock.now();
  const claimed = await store.claimCard(record.repo, record.number, now, now.minus({ minutes: CARD_LEASE_MINUTES }));
  if (!claimed) return null;
  let posted: { channel: string; ts: string };
  try {
    posted = await services.slack.postMessage({ channel: config.channel, ...rendered });
  } catch (error) {
    await store.releaseCard(record.repo, record.number);
    throw error;
  }
  try {
    await store.saveCard(record.repo, record.number, { channel: posted.channel, ts: posted.ts }, hash);
  } catch (error) {
    // The card is posted but not recorded. The lease stays held, so no retry posts again within
    // CARD_LEASE_MINUTES; after that a second card may be posted. Log the orphan so it can be deleted.
    services.log.error("Posted a PR card but failed to record it; it may be duplicated", {
      repo: record.repo,
      number: record.number,
      channel: posted.channel,
      ts: posted.ts,
    });
    throw error;
  }
  return { channel: posted.channel, ts: posted.ts };
}

function cardModel(record: PRRecord, pr: PRData | null): CardModel {
  return {
    repo: record.repo,
    number: record.number,
    title: record.title,
    url: record.url,
    author: record.author,
    additions: record.additions,
    deletions: record.deletions,
    createdAt: record.createdAt,
    state: record.state,
    owners: record.owners,
    reviewers: pr ? reviewerLines(pr) : [],
    modifiers: record.modifiers,
    note: record.note,
    submittedBy: record.submittedBy,
  };
}

async function hashCard(card: RenderedCard): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(card)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function consume(store: PRStore, repo: string, number: number, events: readonly PREvent[]): Promise<void> {
  if (events.length > 0)
    await store.deleteEvents(
      repo,
      number,
      events.map((event) => event.id),
    );
}
