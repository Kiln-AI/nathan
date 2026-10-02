import { describe, expect, it } from "vitest";
import { withDryRunWriter } from "../../src/github/gateway";
import { createDryRunGitHubWriter } from "../../src/github/writer";
import { MemoryLogger } from "../fakes/log";
import { stubbedGateway } from "../helpers/github";

describe("GitHub writer", () => {
  it("exposes exactly two writes: requestReviewers and addLabels", () => {
    const { gateway } = stubbedGateway();
    expect(Object.keys(gateway.writer)).toEqual(["requestReviewers", "addLabels"]);
    expect(Object.keys(createDryRunGitHubWriter(new MemoryLogger()))).toEqual(["requestReviewers", "addLabels"]);
  });

  it("adds reviewers through REST, which never removes existing ones", async () => {
    const { gateway, api } = stubbedGateway(() => Response.json({}, { status: 201 }));
    await gateway.writer.requestReviewers("Kiln-AI/Kiln", 101, ["bob", "carol"]);
    expect(api.apiCalls()).toEqual([
      {
        method: "POST",
        path: "/repos/Kiln-AI/Kiln/pulls/101/requested_reviewers",
        body: { reviewers: ["bob", "carol"] },
        authorization: "token ghs_token1",
      },
    ]);
  });

  it("adds labels through the issues API, which keeps the PR's other labels", async () => {
    const { gateway, api } = stubbedGateway(() => Response.json([], { status: 200 }));
    await gateway.writer.addLabels("Kiln-AI/Kiln", 101, ["quick", "urgent"]);
    expect(api.apiCalls()).toEqual([
      {
        method: "POST",
        path: "/repos/Kiln-AI/Kiln/issues/101/labels",
        body: { labels: ["quick", "urgent"] },
        authorization: "token ghs_token1",
      },
    ]);
  });

  it("sends nothing for an empty list", async () => {
    const { gateway, api } = stubbedGateway();
    await gateway.writer.requestReviewers("Kiln-AI/Kiln", 101, []);
    await gateway.writer.addLabels("Kiln-AI/Kiln", 101, []);
    expect(api.calls).toEqual([]);
  });

  it("surfaces GitHub's 422 for a non-collaborator as GitHubApiError", async () => {
    const { gateway } = stubbedGateway(() =>
      Response.json(
        {
          message:
            "Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the Kiln-AI/Kiln repository.",
        },
        { status: 422 },
      ),
    );
    await expect(gateway.writer.requestReviewers("Kiln-AI/Kiln", 101, ["stranger"])).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 422,
    });
  });

  it("in dry run, logs the write and sends nothing, while reads still work", async () => {
    const { gateway, api } = stubbedGateway(() => ({ data: { repository: { pullRequest: null } } }));
    const log = new MemoryLogger();
    const dryRun = withDryRunWriter(gateway, log);
    await dryRun.writer.requestReviewers("Kiln-AI/Kiln", 101, ["bob"]);
    await dryRun.writer.addLabels("Kiln-AI/Kiln", 101, ["urgent"]);
    await dryRun.writer.addLabels("Kiln-AI/Kiln", 101, []);
    expect(api.calls).toEqual([]);
    expect(log.at("info")).toEqual([
      {
        level: "info",
        msg: "dry run: would request reviewers",
        fields: { repo: "Kiln-AI/Kiln", number: 101, logins: ["bob"] },
      },
      {
        level: "info",
        msg: "dry run: would add labels",
        fields: { repo: "Kiln-AI/Kiln", number: 101, labels: ["urgent"] },
      },
    ]);
    expect(await dryRun.reader.pullRequest("Kiln-AI/Kiln", 101)).toBeNull();
  });
});
