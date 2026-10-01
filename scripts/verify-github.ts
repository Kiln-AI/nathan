// Live check of an environment's GitHub App: token, sweep cost, isRequired. See docs/setup.md,
// "Verify GitHub access". Usage: npm run verify:github -- <env> [--repo owner/name …]
// Secrets come from the environment, over .dev.vars.<env> (or .dev.vars) in the repo root.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../nathan.config";
import { createConsoleLogger } from "../src/core/log";
import { systemClock } from "../src/core/time";
import { createInstallationTokens, type GitHubAppAuth, readGitHubAppAuth } from "../src/github/auth";
import { createGitHubHttp, createTokenRequest } from "../src/github/client";
import { createGitHubReader } from "../src/github/reader";
import {
  createRequiredContextsLookup,
  formatResults,
  hasFailures,
  memoryKv,
  parseDevVars,
  reposFromConfig,
  verifyGitHub,
} from "./lib/verify_github";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const envName = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--repo");
const repoOverrides = args.flatMap((arg, i) => (args[i - 1] === "--repo" ? [arg] : []));

if (!envName) {
  console.error("Usage: npm run verify:github -- <env> [--repo owner/name …]   (env: staging or production)");
  process.exit(2);
}

const varsFile = [`.dev.vars.${envName}`, ".dev.vars"].map((name) => join(root, name)).find(existsSync);
const vars = { ...(varsFile ? parseDevVars(readFileSync(varsFile, "utf8")) : {}), ...process.env };

let auth: GitHubAppAuth;
let repos: string[];
try {
  auth = readGitHubAppAuth(vars);
} catch (error) {
  const hint = `For this script, put ${envName}'s GitHub App secrets in .dev.vars.${envName} (see docs/setup.md).`;
  console.error(formatResults([{ name: "App credentials", outcome: "fail", lines: [(error as Error).message, hint] }]));
  process.exit(1);
}
try {
  repos = repoOverrides.length > 0 ? repoOverrides : reposFromConfig(config, envName);
} catch (error) {
  console.error(formatResults([{ name: "Repos", outcome: "fail", lines: [(error as Error).message] }]));
  process.exit(1);
}

console.log(`Verifying GitHub App ${auth.appId} (installation ${auth.installationId}) for ${envName}`);
console.log(
  `Secrets: ${varsFile ? `${varsFile} and the environment` : "the environment"}; repos: ${repos.join(", ")}\n`,
);

const tokens = createInstallationTokens({
  credentials: auth,
  kv: memoryKv(),
  clock: systemClock,
  request: createTokenRequest(),
});
const http = createGitHubHttp({ tokens, clock: systemClock });
const results = await verifyGitHub({
  repos,
  token: () => tokens.get(),
  // The reader's own warnings (e.g. a missing repo) are reported by the checks instead.
  reader: createGitHubReader({ graphql: http.graphql, log: createConsoleLogger({}, () => {}) }),
  requiredContexts: createRequiredContextsLookup(http),
});
console.log(formatResults(results));
if (hasFailures(results)) process.exitCode = 1;
