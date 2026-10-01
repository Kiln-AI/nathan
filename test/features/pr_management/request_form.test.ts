import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WIP_TITLE_PATTERN } from "../../../src/features/pr_management/config";
import {
  FIELD,
  type FormInput,
  MESSAGES,
  parsePullRequestUrl,
  readSubmission,
  requestModal,
  type ValidationDeps,
  validateRequest,
} from "../../../src/features/pr_management/request_form";
import { trackedRepos } from "../../../src/features/pr_management/webhooks";
import type { PRData } from "../../../src/github";
import { aPR } from "../../builders/github";
import { PR_USERS, REPO } from "../../helpers/pr";

const TRACKED = [REPO, "Kiln-AI/nathan"];
const URL = `https://github.com/${REPO}/pull/101`;

function deps(overrides: Partial<ValidationDeps> & { prs?: PRData[] } = {}) {
  const { prs = [aPR()], ...rest } = overrides;
  const fetchPullRequest = vi.fn(
    async (repo: string, number: number) => prs.find((pr) => pr.repo === repo && pr.number === number) ?? null,
  );
  const log = { warn: vi.fn() };
  const validation: ValidationDeps = {
    submitterId: "UALICE",
    trackedRepo: trackedRepos(TRACKED),
    trackedRepos: TRACKED,
    wipTitlePattern: DEFAULT_WIP_TITLE_PATTERN,
    directory: { bySlack: (id) => PR_USERS.find((user) => user.slack === id) },
    fetchPullRequest,
    slackName: async (id) => ({ UJANE: "Jane Doe", UJOE: "Joe" })[id] ?? null,
    timeoutMs: 500,
    log,
    ...rest,
  };
  return { validation, fetchPullRequest, log };
}

const form = (overrides: Partial<FormInput> = {}): FormInput => ({
  url: URL,
  modifiers: [],
  reviewerIds: ["UBOB"],
  note: null,
  ...overrides,
});

async function errorsFor(input: FormInput, overrides: Parameters<typeof deps>[0] = {}) {
  const result = await validateRequest(input, deps(overrides).validation);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("parsePullRequestUrl", () => {
  it.each([
    [URL, { repo: REPO, number: 101 }],
    [`${URL}/files`, { repo: REPO, number: 101 }],
    [`${URL}/files?w=1#diff-abc`, { repo: REPO, number: 101 }],
    [`${URL}#issuecomment-1`, { repo: REPO, number: 101 }],
    [`  http://www.github.com/kiln-ai/kiln/pull/7  `, { repo: "kiln-ai/kiln", number: 7 }],
    ["https://GitHub.com/a-b/c.d_e/pull/3", { repo: "a-b/c.d_e", number: 3 }],
  ])("parses %s", (text, expected) => {
    expect(parsePullRequestUrl(text)).toEqual(expected);
  });

  it.each([
    "",
    "not a link",
    `https://github.com/${REPO}/issues/101`,
    `https://github.com/${REPO}/pull/`,
    `https://github.com/${REPO}/pull/0`,
    `https://github.com/${REPO}/pull/12abc`,
    `https://github.com/${REPO}`,
    `https://gitlab.com/${REPO}/pull/1`,
    `https://github.com.evil.test/${REPO}/pull/1`,
  ])("rejects %j", (text) => {
    expect(parsePullRequestUrl(text)).toBeNull();
  });
});

describe("readSubmission", () => {
  it("reads every field, trimming the note and ignoring unknown modifiers", () => {
    const values = {
      [FIELD.url]: { [FIELD.url]: { type: "url_text_input" as const, value: URL } },
      [FIELD.modifiers]: {
        [FIELD.modifiers]: {
          type: "checkboxes" as const,
          selected_options: [
            { text: { type: "plain_text" as const, text: "urgent" }, value: "urgent" },
            { text: { type: "plain_text" as const, text: "bogus" }, value: "bogus" },
          ],
        },
      },
      [FIELD.reviewers]: { [FIELD.reviewers]: { type: "multi_users_select" as const, selected_users: ["UBOB"] } },
      [FIELD.note]: { [FIELD.note]: { type: "plain_text_input" as const, value: "  please look  " } },
    };
    expect(readSubmission(values)).toEqual({
      url: URL,
      modifiers: ["urgent"],
      reviewerIds: ["UBOB"],
      note: "please look",
    });
  });

  it("treats missing optional fields and a blank note as empty", () => {
    const values = { [FIELD.note]: { [FIELD.note]: { type: "plain_text_input" as const, value: "   " } } };
    expect(readSubmission(values)).toEqual({ url: "", modifiers: [], reviewerIds: [], note: null });
  });
});

describe("requestModal", () => {
  it("matches the golden file", async () => {
    await expect(`${JSON.stringify(requestModal(), null, 2)}\n`).toMatchFileSnapshot(
      "__snapshots__/request_modal.json",
    );
  });
});

describe("validateRequest", () => {
  it("maps a valid submission to a request with GitHub logins", async () => {
    const { validation, fetchPullRequest } = deps();
    const result = await validateRequest(
      form({ reviewerIds: ["UBOB", "UCAROL"], modifiers: ["quick", "urgent"], note: "hi" }),
      validation,
    );
    expect(result).toEqual({
      ok: true,
      request: {
        repo: REPO,
        number: 101,
        reviewers: ["bob", "carol"],
        modifiers: ["quick", "urgent"],
        note: "hi",
        submittedBy: "UALICE",
      },
    });
    expect(fetchPullRequest).toHaveBeenCalledWith(REPO, 101);
  });

  it("matches the repo case-insensitively and uses the configured spelling", async () => {
    const result = await validateRequest(form({ url: "https://github.com/kiln-ai/KILN/pull/101" }), deps().validation);
    expect(result).toMatchObject({ ok: true, request: { repo: REPO } });
  });

  it("drops the author from the reviewers, and dedupes them", async () => {
    const { validation } = deps({
      directory: {
        bySlack: (id) => [...PR_USERS, { github: "BOB", slack: "UBOB2" }].find((user) => user.slack === id),
      },
    });
    const result = await validateRequest(form({ reviewerIds: ["UALICE", "UBOB", "UBOB2"] }), validation);
    expect(result).toMatchObject({ ok: true, request: { reviewers: ["bob"] } });
  });

  it("rejects a link that isn't a PR, without asking GitHub", async () => {
    const { validation, fetchPullRequest } = deps();
    const result = await validateRequest(form({ url: `https://github.com/${REPO}/issues/1` }), validation);
    expect(result).toEqual({ ok: false, errors: { [FIELD.url]: MESSAGES.notAPullRequest } });
    expect(fetchPullRequest).not.toHaveBeenCalled();
  });

  it("rejects an untracked repo, listing the tracked ones", async () => {
    const errors = await errorsFor(form({ url: "https://github.com/someone/else/pull/1" }));
    expect(errors).toEqual({ [FIELD.url]: "I don't track someone/else. Tracked repos: Kiln-AI/Kiln, Kiln-AI/nathan." });
  });

  it.each([
    ["missing", [], MESSAGES.notFound],
    ["merged", [aPR({ state: "merged" })], MESSAGES.merged],
    ["closed", [aPR({ state: "closed" })], MESSAGES.closed],
    ["a draft", [aPR({ isDraft: true })], MESSAGES.draft],
    ["WIP-titled", [aPR({ title: "[WIP] Add the thing" })], MESSAGES.wip],
  ])("rejects a PR that is %s", async (_, prs, message) => {
    expect(await errorsFor(form(), { prs })).toEqual({ [FIELD.url]: message });
  });

  it("names every unmapped reviewer, falling back to the Slack ID when the name lookup fails", async () => {
    const errors = await errorsFor(form({ reviewerIds: ["UBOB", "UJANE", "UJOE", "UNONAME"] }));
    expect(errors[FIELD.reviewers]).toBe(MESSAGES.unmapped(["Jane Doe", "Joe", "UNONAME"]));
    expect(errors[FIELD.reviewers]).toMatch(/^Jane Doe, Joe and UNONAME have no GitHub mapping/);

    const single = await errorsFor(form({ reviewerIds: ["UJANE"] }), {
      slackName: async () => {
        throw new Error("users.info failed");
      },
    });
    expect(single[FIELD.reviewers]).toMatch(/^UJANE has no GitHub mapping.*nathan\.config\.ts/);
  });

  it("rejects the submitter as the only reviewer of their own PR", async () => {
    expect(await errorsFor(form({ reviewerIds: ["UALICE"] }))).toEqual({ [FIELD.reviewers]: MESSAGES.selfReview });
  });

  it("rejects the author as the only reviewer when someone else submits", async () => {
    const errors = await errorsFor(form({ reviewerIds: ["UALICE"] }), { submitterId: "UBOB" });
    expect(errors).toEqual({ [FIELD.reviewers]: MESSAGES.authorReview("alice") });
  });

  it("asks for a reviewer when none is selected", async () => {
    expect(await errorsFor(form({ reviewerIds: [] }))).toEqual({ [FIELD.reviewers]: MESSAGES.noReviewers });
  });

  it("reports every invalid field at once", async () => {
    const errors = await errorsFor(form({ url: "nope", reviewerIds: ["UJANE"] }));
    expect(errors).toEqual({
      [FIELD.url]: MESSAGES.notAPullRequest,
      [FIELD.reviewers]: MESSAGES.unmapped(["Jane Doe"]),
    });
  });

  it("gives up on GitHub at the deadline and asks to try again", async () => {
    const { validation, log } = deps({ fetchPullRequest: () => new Promise(() => {}), timeoutMs: 20 });
    const result = await validateRequest(form(), validation);
    expect(result).toEqual({ ok: false, errors: { [FIELD.url]: MESSAGES.githubTimeout } });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("names an unmapped reviewer by Slack ID when the name lookup is too slow", async () => {
    const errors = await errorsFor(form({ reviewerIds: ["UJANE"] }), {
      slackName: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(errors[FIELD.reviewers]).toMatch(/^UJANE has/);
  });

  it("asks to try again when GitHub fails", async () => {
    const { validation, log } = deps({
      fetchPullRequest: async () => {
        throw new Error("502");
      },
    });
    expect(await validateRequest(form(), validation)).toEqual({
      ok: false,
      errors: { [FIELD.url]: MESSAGES.githubFailed },
    });
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: expect.any(Error) }));
  });
});
