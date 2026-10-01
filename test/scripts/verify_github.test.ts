import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  createRequiredContextsLookup,
  formatResults,
  hasFailures,
  IS_REQUIRED_SAMPLE_SIZE,
  memoryKv,
  parseDevVars,
  reposFromConfig,
  SWEEP_COST_BUDGET,
  type VerifyDeps,
  verifyGitHub,
} from "../../scripts/lib/verify_github";
import { createInstallationTokens, readGitHubAppAuth } from "../../src/github/auth";
import { createGitHubHttp, createTokenRequest } from "../../src/github/client";
import type { PRData } from "../../src/github/types";
import { aCheck, aPR } from "../builders/github";
import { FakeClock } from "../fakes/clock";
import { type ApiCall, stubGitHubApi } from "../helpers/github";

const REPOS = ["Kiln-AI/Kiln", "Kiln-AI/nathan"];

/** Verify deps over in-memory PRs. `rules` maps "repo@branch" to required contexts (absent = unreadable). */
function deps(
  options: {
    prs?: PRData[];
    /** What the single-PR query returns, when it differs from the sweep (e.g. isRequired resolved). */
    resolved?: PRData[];
    missingRepos?: string[];
    cost?: number;
    rules?: Record<string, string[]>;
    token?: () => Promise<unknown>;
    sweepError?: Error;
  } = {},
) {
  const prs = options.prs ?? [];
  const pullRequestCalls: string[] = [];
  const rulesCalls: string[] = [];
  const verifyDeps: VerifyDeps = {
    repos: REPOS,
    token: options.token ?? (async () => "ghs_token"),
    reader: {
      openPullRequests: async () => {
        if (options.sweepError) throw options.sweepError;
        return { pullRequests: prs, missingRepos: options.missingRepos ?? [], cost: options.cost ?? 6 };
      },
      pullRequest: async (repo, number) => {
        pullRequestCalls.push(`${repo}#${number}`);
        const match = (pr: PRData) => pr.repo === repo && pr.number === number;
        return options.resolved?.find(match) ?? prs.find(match) ?? null;
      },
    },
    requiredContexts: async (repo, branch) => {
      rulesCalls.push(`${repo}@${branch}`);
      return options.rules?.[`${repo}@${branch}`] ?? null;
    },
  };
  return { verifyDeps, pullRequestCalls, rulesCalls };
}

const byName = (results: CheckResult[], name: string) => {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no ${name} result`);
  return result;
};

const ci = (name: string, required: boolean | null, outcome: "success" | "failure" = "success") =>
  aCheck({ name, required, outcome });

describe("verifyGitHub", () => {
  it("fails on a token error and skips the checks that need one", async () => {
    const { verifyDeps } = deps({
      token: async () => {
        throw new Error("Integration not found");
      },
    });
    const results = await verifyGitHub(verifyDeps);
    expect(results.map((r) => [r.name, r.outcome])).toEqual([
      ["App token", "fail"],
      ["Sweep", "skip"],
      ["isRequired", "skip"],
    ]);
    expect(results[0]?.lines[0]).toBe("Integration not found");
    expect(hasFailures(results)).toBe(true);
  });

  it("reports PR counts and cost per sweep", async () => {
    const { verifyDeps } = deps({
      prs: [aPR({ number: 1 }), aPR({ number: 2, isDraft: true }), aPR({ repo: "Kiln-AI/nathan", number: 3 })],
      cost: 50,
    });
    const sweep = byName(await verifyGitHub(verifyDeps), "Sweep");
    expect(sweep.outcome).toBe("pass");
    expect(sweep.lines).toEqual([
      "Kiln-AI/Kiln: 2 open PRs (1 drafts)",
      "Kiln-AI/nathan: 1 open PRs (0 drafts)",
      "Cost: 50 points per sweep (1.0% of the 5000-point hourly budget).",
    ]);
  });

  it("warns when the sweep costs more than the budget", async () => {
    const { verifyDeps } = deps({ cost: SWEEP_COST_BUDGET + 1 });
    const sweep = byName(await verifyGitHub(verifyDeps), "Sweep");
    expect(sweep.outcome).toBe("warn");
    expect(sweep.lines.at(-1)).toContain(`over the ${SWEEP_COST_BUDGET}-point budget`);
  });

  it("fails when a configured repo isn't returned, naming the installation fix", async () => {
    const { verifyDeps } = deps({ missingRepos: ["Kiln-AI/nathan"], cost: SWEEP_COST_BUDGET + 1 });
    const results = await verifyGitHub(verifyDeps);
    const sweep = byName(results, "Sweep");
    expect(sweep.outcome).toBe("fail");
    expect(sweep.lines[0]).toBe("Kiln-AI/Kiln: 0 open PRs (0 drafts)");
    expect(sweep.lines.at(-1)).toBe(
      "Not returned: Kiln-AI/nathan. Add them to the App's installation (Configure → Repository access), or fix the name in nathan.config.ts.",
    );
    expect(hasFailures(results)).toBe(true);
  });

  it("fails the sweep on an API error and skips isRequired", async () => {
    const { verifyDeps } = deps({ sweepError: new Error("GitHub GraphQL error: Something went wrong") });
    const results = await verifyGitHub(verifyDeps);
    expect(results.map((r) => [r.name, r.outcome])).toEqual([
      ["App token", "pass"],
      ["Sweep", "fail"],
      ["isRequired", "skip"],
    ]);
    expect(byName(results, "Sweep").lines).toEqual(["GitHub GraphQL error: Something went wrong"]);
  });

  describe("isRequired", () => {
    it("passes when a check the branch requires comes back required", async () => {
      const pr = aPR({ number: 1, checks: [ci("test", null), ci("lint", null)] });
      const { verifyDeps } = deps({
        prs: [pr],
        resolved: [{ ...pr, checks: [ci("test", true), ci("lint", false)] }],
        rules: { "Kiln-AI/Kiln@main": ["test"] },
      });
      const result = byName(await verifyGitHub(verifyDeps), "isRequired");
      expect(result).toEqual({
        name: "isRequired",
        outcome: "pass",
        lines: ["Kiln-AI/Kiln#1 (base main): required [test], not required [lint]; branch rules require [test]"],
      });
    });

    it("samples failing-check PRs first, skips drafts and check-less PRs, caps the sample and caches branch rules", async () => {
      const passing = Array.from({ length: IS_REQUIRED_SAMPLE_SIZE }, (_, i) =>
        aPR({ number: 10 + i, checks: [ci("test", true)] }),
      );
      const failing = aPR({ number: 2, checks: [ci("test", true, "failure")] });
      const { verifyDeps, pullRequestCalls, rulesCalls } = deps({
        prs: [
          aPR({ number: 1, isDraft: true, checks: [ci("test", true, "failure")] }),
          aPR({ number: 3, checks: [] }),
          ...passing,
          failing,
        ],
        rules: { "Kiln-AI/Kiln@main": ["test"] },
      });
      expect(byName(await verifyGitHub(verifyDeps), "isRequired").outcome).toBe("pass");
      expect(pullRequestCalls).toEqual([
        "Kiln-AI/Kiln#2",
        "Kiln-AI/Kiln#10",
        "Kiln-AI/Kiln#11",
        "Kiln-AI/Kiln#12",
        "Kiln-AI/Kiln#13",
      ]);
      expect(rulesCalls).toEqual(["Kiln-AI/Kiln@main"]);
    });

    it("fails when the branch requires a check that isRequired says isn't", async () => {
      const { verifyDeps } = deps({
        prs: [aPR({ number: 1, checks: [ci("test", false, "failure")] })],
        rules: { "Kiln-AI/Kiln@main": ["test"] },
      });
      const results = await verifyGitHub(verifyDeps);
      const result = byName(results, "isRequired");
      expect(result.outcome).toBe("fail");
      expect(result.lines.slice(1)).toEqual([
        `Kiln-AI/Kiln#1: the branch requires "test", but isRequired says it isn't required.`,
        "Nathan would treat required CI failures as optional. Don't launch until this passes.",
      ]);
      expect(hasFailures(results)).toBe(true);
    });

    it("fails when a check's isRequired wasn't answered", async () => {
      const { verifyDeps } = deps({ prs: [aPR({ number: 1, checks: [ci("test", true), ci("lint", null)] })] });
      const result = byName(await verifyGitHub(verifyDeps), "isRequired");
      expect(result.outcome).toBe("fail");
      expect(result.lines).toContain(`Kiln-AI/Kiln#1: isRequired wasn't answered for "lint".`);
    });

    it("fails on an API error re-reading a PR", async () => {
      const { verifyDeps } = deps({ prs: [aPR({ number: 1, checks: [ci("test", true)] })] });
      verifyDeps.reader.pullRequest = async () => {
        throw new Error("GitHub GraphQL error: Resource not accessible by integration");
      };
      const result = byName(await verifyGitHub(verifyDeps), "isRequired");
      expect(result).toEqual({
        name: "isRequired",
        outcome: "fail",
        lines: ["Kiln-AI/Kiln#1: GitHub GraphQL error: Resource not accessible by integration"],
      });
    });

    it("keeps mismatches already found when a later PR re-read fails", async () => {
      const first = aPR({ number: 1, checks: [ci("test", false, "failure")] });
      const { verifyDeps } = deps({
        prs: [first, aPR({ number: 2, checks: [ci("test", true)] })],
        rules: { "Kiln-AI/Kiln@main": ["test"] },
      });
      verifyDeps.reader.pullRequest = async (_repo, number) => {
        if (number === 1) return first;
        throw new Error("GitHub GraphQL error: Something went wrong");
      };
      const result = byName(await verifyGitHub(verifyDeps), "isRequired");
      expect(result.outcome).toBe("fail");
      expect(result.lines.slice(1)).toEqual([
        `Kiln-AI/Kiln#1: the branch requires "test", but isRequired says it isn't required.`,
        "Kiln-AI/Kiln#2: GitHub GraphQL error: Something went wrong",
      ]);
    });

    it("warns when no sampled check is required, showing unreadable branch rules", async () => {
      const { verifyDeps } = deps({
        prs: [aPR({ number: 1, checks: [ci("test", false)] }), aPR({ number: 2, checks: [ci("lint", false)] })],
      });
      // #2 was closed (and deleted) between the sweep and the re-read.
      verifyDeps.reader.pullRequest = async (_repo, number) =>
        number === 1 ? aPR({ number: 1, checks: [ci("test", false)] }) : null;
      const result = byName(await verifyGitHub(verifyDeps), "isRequired");
      expect(result.outcome).toBe("warn");
      expect(result.lines[0]).toBe(
        "Kiln-AI/Kiln#1 (base main): required [], not required [test]; branch rules require (couldn't read them)",
      );
      expect(result.lines).toHaveLength(2);
      expect(result.lines[1]).toContain("can't confirm isRequired sees required checks");
    });

    it("skips when no open, non-draft PR has checks", async () => {
      const { verifyDeps } = deps({
        prs: [aPR({ number: 1 }), aPR({ number: 2, isDraft: true, checks: [ci("x", null)] })],
      });
      const results = await verifyGitHub(verifyDeps);
      expect(byName(results, "isRequired").outcome).toBe("skip");
      expect(hasFailures(results)).toBe(false);
    });
  });
});

describe("createRequiredContextsLookup", () => {
  function lookupOver(respond: (call: ApiCall) => unknown) {
    const api = stubGitHubApi(respond);
    const clock = new FakeClock();
    const tokens = createInstallationTokens({
      credentials: readGitHubAppAuth(env),
      kv: memoryKv(),
      clock,
      request: createTokenRequest(api.fetch),
    });
    return { lookup: createRequiredContextsLookup(createGitHubHttp({ tokens, clock, fetch: api.fetch })), api };
  }

  const protection = (contexts: (string | null)[] | null) => ({
    data: { repository: { ref: { refUpdateRule: contexts ? { requiredStatusCheckContexts: contexts } : null } } },
  });
  const rules = [
    { type: "pull_request", parameters: {} },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "test" }, { context: "e2e" }] },
    },
    { type: "deletion" },
  ];

  it("unions classic protection and ruleset contexts", async () => {
    const { lookup, api } = lookupOver((call) =>
      call.path === "/graphql" ? protection(["lint", null, "test"]) : rules,
    );
    expect((await lookup("Kiln-AI/Kiln", "release/1.0"))?.sort()).toEqual(["e2e", "lint", "test"]);
    const graphql = api.apiCalls().find((call) => call.path === "/graphql");
    expect(graphql?.body?.variables).toEqual({ owner: "Kiln-AI", name: "Kiln", ref: "refs/heads/release/1.0" });
    expect(api.apiCalls().map((call) => call.path)).toContain("/repos/Kiln-AI/Kiln/rules/branches/release%2F1.0");
  });

  it("treats an unprotected branch as requiring nothing", async () => {
    const { lookup } = lookupOver((call) => (call.path === "/graphql" ? protection(null) : []));
    expect(await lookup("Kiln-AI/Kiln", "main")).toEqual([]);
  });

  it("uses whichever source is readable", async () => {
    const forbidden = Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    const rulesOnly = lookupOver((call) =>
      call.path === "/graphql" ? { errors: [{ type: "FORBIDDEN", message: "no" }] } : rules,
    );
    expect(await rulesOnly.lookup("Kiln-AI/Kiln", "main")).toEqual(["test", "e2e"]);
    const classicOnly = lookupOver((call) => (call.path === "/graphql" ? protection(["lint"]) : forbidden.clone()));
    expect(await classicOnly.lookup("Kiln-AI/Kiln", "main")).toEqual(["lint"]);
  });

  it("is null when neither source is readable", async () => {
    const { lookup } = lookupOver(() => Response.json({ message: "Server Error" }, { status: 500 }));
    expect(await lookup("Kiln-AI/Kiln", "main")).toBeNull();
  });
});

describe("formatResults", () => {
  it("labels each check and indents its lines", () => {
    const results: CheckResult[] = [
      { name: "App token", outcome: "pass", lines: ["Minted an installation token."] },
      { name: "Sweep", outcome: "warn", lines: ["a", "b"] },
      { name: "isRequired", outcome: "skip", lines: [] },
    ];
    expect(formatResults(results)).toBe(
      [
        "PASS  App token",
        "      Minted an installation token.",
        "WARN  Sweep",
        "      a",
        "      b",
        "SKIP  isRequired",
      ].join("\n"),
    );
    expect(hasFailures(results)).toBe(false);
  });
});

describe("parseDevVars", () => {
  it("reads KEY=value lines like wrangler's .dev.vars", () => {
    const text = [
      "# GitHub App (staging)",
      "",
      "GITHUB_APP_ID=12345",
      '  GITHUB_INSTALLATION_ID = "67890"  ',
      "GITHUB_WEBHOOK_SECRET='a=b'",
      String.raw`GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"`,
      "not a pair",
      "=no key",
    ].join("\r\n");
    expect(parseDevVars(text)).toEqual({
      GITHUB_APP_ID: "12345",
      GITHUB_INSTALLATION_ID: "67890",
      GITHUB_WEBHOOK_SECRET: "a=b",
      GITHUB_APP_PRIVATE_KEY: String.raw`-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`,
    });
  });
});

describe("reposFromConfig", () => {
  const config = {
    features: { pr_management: { enabled: false, repos: ["Kiln-AI/Kiln"] } },
    environments: { staging: { features: { pr_management: { repos: ["Kiln-AI/nathan"] } } }, production: {} },
  };

  it("reads the repos with the environment's overlay, even while the feature is disabled", () => {
    expect(reposFromConfig(config, "production")).toEqual(["Kiln-AI/Kiln"]);
    expect(reposFromConfig(config, "staging")).toEqual(["Kiln-AI/nathan"]);
  });

  it("rejects an unknown environment or a config without repos", () => {
    expect(() => reposFromConfig(config, "prod")).toThrow('no "prod" environment (have: staging, production)');
    expect(() => reposFromConfig({ environments: { production: {} } }, "production")).toThrow("pass --repo owner/name");
  });
});

describe("memoryKv", () => {
  it("stores, reads (as text or JSON) and deletes values", async () => {
    const kv = memoryKv();
    expect(await kv.get("k", "json")).toBeNull();
    await kv.put("k", JSON.stringify({ token: "t" }));
    expect(await kv.get("k", "json")).toEqual({ token: "t" });
    expect(await kv.get("k")).toBe('{"token":"t"}');
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });
});
