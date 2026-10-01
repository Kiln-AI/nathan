import type { AppOverrides } from "../../src/core/app";
import { normalizeGithubLogin, type UserDirectory } from "../../src/core/directory";
import { prManagement } from "../../src/features/pr_management";
import { createPeople, type People } from "../../src/features/pr_management/people";
import { createPRStore } from "../../src/features/pr_management/store";
import { aConfig } from "../builders/config";
import { fakeBatch, fakeMessage } from "../fakes/batch";
import { testApp } from "./app";

export const PR_CHANNEL = "CPRS";
export const REPO = "Kiln-AI/Kiln";

/** Team: alice, bob, carol; dan is the triager. */
export const PR_USERS = [
  { github: "alice", slack: "UALICE" },
  { github: "bob", slack: "UBOB" },
  { github: "carol", slack: "UCAROL" },
  { github: "dan", slack: "UDAN" },
];

export function prConfig(overrides: Record<string, unknown> = {}) {
  return aConfig({
    users: PR_USERS,
    features: {
      pr_management: {
        enabled: true,
        repos: [REPO, "Kiln-AI/nathan"],
        channel: PR_CHANNEL,
        triager: "dan",
        ...overrides,
      },
    },
  });
}

/** The app with pr_management enabled, plus its store and a way to run its jobs. */
export function prApp(overrides: AppOverrides = {}) {
  const h = testApp({ features: [prManagement], config: prConfig(), ...overrides });
  const store = createPRStore(h.app.services.db);

  /** Delivers one job message now and returns its outcome. */
  async function runJob(name: string, payload: unknown, attempts = 1) {
    const message = fakeMessage({ job: `pr_management.${name}`, payload }, attempts);
    await h.app.queue(fakeBatch([message]));
    return message.outcome;
  }

  return {
    ...h,
    store,
    runJob,
    refresh: (number: number, repo = REPO) => runJob("refresh", { repo, number }),
    record: (number: number, repo = REPO) => store.get(repo, number),
    /** Every unconsumed event for the PR. */
    events: (number: number, repo = REPO) => store.events(repo, number, h.clock.now().plus({ years: 1 })),
  };
}

export type PRTestApp = ReturnType<typeof prApp>;

/** `People` over an in-memory directory, for the pure modules. */
export function testPeople(triager = "dan", users = PR_USERS): People {
  const byGithub = (login: string) => users.find((u) => normalizeGithubLogin(u.github) === normalizeGithubLogin(login));
  const directory: UserDirectory = {
    bySlack: (id) => users.find((u) => u.slack === id),
    byGithub,
    slackMention: (login) => {
      const user = byGithub(login);
      return user ? `<@${user.slack}>` : null;
    },
    timezone: async () => "America/Toronto",
  };
  return createPeople(directory, triager);
}
