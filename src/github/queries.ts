// GraphQL documents. Every value (owner, name, PR number, cursor) is a variable, never interpolated.
// Aliased multi-repo queries number their aliases and variables: r0/$o0/$n0/$c0, r1/…

/** PRs per repo per sweep page. */
export const PR_PAGE_SIZE = 50;
/** Check contexts fetched per head commit; more sets `checksTruncated`. */
export const CHECK_CONTEXTS_LIMIT = 100;
/** Open PRs per page when looking a commit up. */
export const OPEN_HEADS_PAGE_SIZE = 100;

const ACTOR = "__typename login";
const REVIEW = `state submittedAt author { ${ACTOR} }`;

/** The head commit's check runs and statuses, optionally with `isRequired` for the PR number in `prNumberVar`. */
function checkContexts(prNumberVar: string | null): string {
  const required = prNumberVar ? ` isRequired(pullRequestNumber: ${prNumberVar})` : "";
  return `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECK_CONTEXTS_LIMIT}) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt completedAt${required} }
      ... on StatusContext { context state createdAt${required} }
    }
  } } } } }`;
}

function prFieldsFragment(prNumberVar: string | null): string {
  return `fragment PRFields on PullRequest {
  id number title url state isDraft createdAt updatedAt mergedAt closedAt
  additions deletions baseRefName headRefOid mergeable
  author { ${ACTOR} }
  reviewRequests(first: 50) { nodes { requestedReviewer {
    __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug }
  } } }
  latestOpinionatedReviews(first: 50) { nodes { ${REVIEW} } }
  latestReviews(first: 50) { nodes { ${REVIEW} } }
  timelineItems(last: 10, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes {
    __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt }
  } }
  ${checkContexts(prNumberVar)}
}`;
}

const HISTORY_FIELDS = `fragment HistoryFields on PullRequest {
  number title url state isDraft createdAt updatedAt mergedAt closedAt
  author { ${ACTOR} }
  reviews(first: 100) { nodes { ${REVIEW} } }
  timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }
}`;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

function indices(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function repoVariables(count: number, extra: (i: number) => string): string {
  return indices(count)
    .map((i) => `$o${i}: String!, $n${i}: String!, ${extra(i)}`)
    .join(", ");
}

/** Open PRs for `count` repos, one page each. Variables: o<i>, n<i>, c<i> (cursor). */
export function sweepQuery(count: number): string {
  const repos = indices(count).map(
    (i) => `r${i}: repository(owner: $o${i}, name: $n${i}) {
    pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}, after: $c${i}, orderBy: { field: CREATED_AT, direction: ASC }) {
      ${PAGE_INFO} nodes { ...PRFields }
    }
  }`,
  );
  return `query Sweep(${repoVariables(count, (i) => `$c${i}: String`)}) {
  ${repos.join("\n  ")}
  rateLimit { cost }
}
${prFieldsFragment(null)}`;
}

/** Head commit and its check contexts with `isRequired` for `count` PRs. Variables: o<i>, n<i>, p<i> (PR number). */
export function requiredChecksQuery(count: number): string {
  const prs = indices(count).map(
    (i) =>
      `p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { headRefOid ${checkContexts(`$p${i}`)} } }`,
  );
  return `query RequiredChecks(${repoVariables(count, (i) => `$p${i}: Int!`)}) {
  ${prs.join("\n  ")}
  rateLimit { cost }
}`;
}

/** One PR, with `isRequired` resolved in the same query. Variables: owner, name, number. */
export const PULL_REQUEST_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...PRFields } }
}
${prFieldsFragment("$number")}`;

/** PRs in any state, most recently updated first. Variables: o<i>, n<i>, c<i>. */
export function recentQuery(count: number): string {
  const repos = indices(count).map(
    (i) => `r${i}: repository(owner: $o${i}, name: $n${i}) {
    pullRequests(first: ${PR_PAGE_SIZE}, after: $c${i}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      ${PAGE_INFO} nodes { ...HistoryFields }
    }
  }`,
  );
  return `query Recent(${repoVariables(count, (i) => `$c${i}: String`)}) {
  ${repos.join("\n  ")}
}
${HISTORY_FIELDS}`;
}

/** Open PRs' head commits. Variables: owner, name, cursor. */
export const OPEN_HEADS_QUERY = `query OpenHeads($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${OPEN_HEADS_PAGE_SIZE}, after: $cursor) { ${PAGE_INFO} nodes { number headRefOid } }
  }
}`;
