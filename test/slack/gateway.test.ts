import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineFeature } from "../../src/core/feature";
import { type ModalView, modal, type SlackRegistry, section, type ViewSubmissionAck } from "../../src/slack";
import { COMMAND_FAILED_TEXT } from "../../src/slack/gateway";
import { aConfig } from "../builders/config";
import { testApp } from "../helpers/app";
import {
  appHomeOpenedBody,
  blockActionBody,
  commandBody,
  shortcutBody,
  signedSlackRequest,
  viewSubmissionBody,
} from "../helpers/slack";

/** An app with one enabled feature whose Slack handlers are declared by `declare`. */
function slackApp(declare: (slack: SlackRegistry) => void) {
  const feature = defineFeature({
    id: "alpha",
    configSchema: z.object({}),
    register: (r) => declare(r.slack),
  });
  return testApp({ features: [feature], config: aConfig({ features: { alpha: { enabled: true } } }) });
}

async function send(h: ReturnType<typeof testApp>, body: string, contentType?: string) {
  const ctx = createExecutionContext();
  const response = await h.app.fetch(await signedSlackRequest(body, { contentType }), ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

const alerts = (h: ReturnType<typeof testApp>) =>
  h.slack.posts.filter((p) => p.channel === "CADMIN").map((p) => p.text);

describe("Slack gateway: verification and authorize", () => {
  it("rejects a bad signature with 401", async () => {
    const h = slackApp(() => {});
    const ctx = createExecutionContext();
    const request = await signedSlackRequest(shortcutBody("x"), { secret: "wrong" });
    expect((await h.app.fetch(request, ctx)).status).toBe(401);
  });

  it("answers Slack's url_verification challenge", async () => {
    const h = slackApp(() => {});
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "t" });
    const result = await send(h, body, "application/json");
    expect(result).toMatchObject({ status: 200, text: "abc123" });
  });

  it("calls auth.test once per app, and again after a failure", async () => {
    const h = slackApp((slack) => slack.shortcut("go", { ack: async () => {} }));
    h.slack.fail();
    const failed = await send(h, shortcutBody("go"));
    expect(failed.status).toBe(500);
    h.slack.succeed();
    await send(h, shortcutBody("go"));
    await send(h, shortcutBody("go"));
    expect(h.slack.authTests).toBe(2);
  });
});

describe("Slack gateway: shortcuts", () => {
  it("runs the ack, then the lazy handler after it", async () => {
    const calls: string[] = [];
    const h = slackApp((slack) =>
      slack.shortcut("request_pr", {
        ack: async (req) => {
          calls.push(`ack ${req.userId} ${req.triggerId}`);
        },
        lazy: async (req) => {
          calls.push(`lazy ${req.userId}`);
        },
      }),
    );
    const result = await send(h, shortcutBody("request_pr"));
    expect(result).toMatchObject({ status: 200, text: "" });
    expect(calls).toEqual(["ack UALICE trigger-1", "lazy UALICE"]);
  });

  it("reports a throwing ack, returns 500 and skips the lazy handler", async () => {
    let lazyRan = false;
    const h = slackApp((slack) =>
      slack.shortcut("boom", {
        ack: async () => {
          throw new Error("ack exploded");
        },
        lazy: async () => {
          lazyRan = true;
        },
      }),
    );
    const result = await send(h, shortcutBody("boom"));
    expect(result.status).toBe(500);
    expect(lazyRan).toBe(false);
    expect(alerts(h)).toEqual([
      ':rotating_light: [development] `alpha.shortcut:boom` failed: ack exploded\n```{"phase":"ack"}```',
    ]);
  });

  it("reports a throwing lazy handler after a normal ack", async () => {
    const h = slackApp((slack) =>
      slack.shortcut("later", {
        ack: async () => {},
        lazy: async () => {
          throw new Error("lazy exploded");
        },
      }),
    );
    expect((await send(h, shortcutBody("later"))).status).toBe(200);
    expect(alerts(h)).toEqual([":rotating_light: [development] `alpha.shortcut:later` failed: lazy exploded"]);
  });

  it("returns 404 for a shortcut nobody registered", async () => {
    const h = slackApp(() => {});
    expect((await send(h, shortcutBody("unknown"))).status).toBe(404);
  });
});

describe("Slack gateway: view submissions", () => {
  const values = { pr: { url: { type: "url_text_input", value: "https://github.com/o/r/pull/1" } } };

  it("returns inline errors and skips the lazy handler", async () => {
    let lazyRan = false;
    const h = slackApp((slack) =>
      slack.viewSubmission("form", {
        ack: async () => ({ errors: { pr: "Not a PR link" } }),
        lazy: async () => {
          lazyRan = true;
        },
      }),
    );
    const result = await send(h, viewSubmissionBody("form", values));
    expect(result.json()).toEqual({ response_action: "errors", errors: { pr: "Not a PR link" } });
    expect(lazyRan).toBe(false);
  });

  it("closes the modal on an accepted submission and runs the lazy handler with the mapped request", async () => {
    const seen: unknown[] = [];
    const h = slackApp((slack) =>
      slack.viewSubmission("form", {
        ack: async () => {},
        lazy: async (req) => {
          seen.push(req);
        },
      }),
    );
    const result = await send(h, viewSubmissionBody("form", values, { privateMetadata: "pr:1" }));
    expect(result).toMatchObject({ status: 200, text: "" });
    expect(seen).toEqual([
      {
        userId: "UALICE",
        triggerId: "trigger-2",
        callbackId: "form",
        viewId: "V1",
        viewHash: "hash-1",
        privateMetadata: "pr:1",
        values,
      },
    ]);
  });

  const next = modal({ callbackId: "next", title: "Next", blocks: [] });
  it.each<[ViewSubmissionAck, string, ModalView | undefined]>([
    [{ update: next }, "update", next],
    [{ push: next }, "push", next],
    [{ clear: true }, "clear", undefined],
  ])("maps %o to response_action %s", async (ack, action, view) => {
    const h = slackApp((slack) => slack.viewSubmission("form", { ack: async () => ack }));
    const body = (await send(h, viewSubmissionBody("form"))).json();
    expect(body).toEqual(view ? { response_action: action, view } : { response_action: action });
  });

  it("returns 500 when the ack throws", async () => {
    const h = slackApp((slack) =>
      slack.viewSubmission("form", {
        ack: async () => {
          throw new Error("validation crashed");
        },
      }),
    );
    expect((await send(h, viewSubmissionBody("form"))).status).toBe(500);
    expect(alerts(h)[0]).toContain("`alpha.view:form` failed: validation crashed");
  });
});

describe("Slack gateway: block actions", () => {
  it("routes by action_id and maps a modal's state", async () => {
    const seen: unknown[] = [];
    const h = slackApp((slack) =>
      slack.action("lookup", {
        ack: async (req) => {
          seen.push(req);
        },
      }),
    );
    const viewValues = { pr: { url: { type: "url_text_input", value: "x" } } };
    const body = blockActionBody(
      { action_id: "lookup", block_id: "pr", type: "url_text_input", value: "x" },
      { view: { callbackId: "form", values: viewValues } },
    );
    expect((await send(h, body)).status).toBe(200);
    expect(seen).toEqual([
      {
        userId: "UALICE",
        triggerId: "trigger-3",
        actionId: "lookup",
        blockId: "pr",
        value: "x",
        view: { id: "V9", hash: "hash-9", callbackId: "form", privateMetadata: "meta", values: viewValues },
      },
    ]);
  });

  it("maps a message button and runs the lazy handler when there is no ack", async () => {
    const seen: unknown[] = [];
    const h = slackApp((slack) =>
      slack.action("open_form", {
        lazy: async (req) => {
          seen.push(req);
        },
      }),
    );
    expect((await send(h, blockActionBody({ action_id: "open_form", value: "v" }))).status).toBe(200);
    expect(seen).toEqual([
      {
        userId: "UALICE",
        triggerId: "trigger-3",
        actionId: "open_form",
        blockId: "b1",
        value: "v",
        message: { channelId: "CPRS", ts: "111.222" },
      },
    ]);
  });

  it("acks unregistered actions (e.g. link buttons) silently, logging only the action_id", async () => {
    const h = slackApp((slack) => slack.action("known", {}));
    const consoleLog = vi.spyOn(console, "log");
    expect(await send(h, blockActionBody({ action_id: "open_pr", value: "secret" }))).toMatchObject({
      status: 200,
      text: "",
    });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(h.log.entries).toEqual([
      { level: "debug", msg: "Ignored unhandled Slack action", fields: { actionId: "open_pr" } },
    ]);
  });

  it("returns 500 and reports when the ack throws", async () => {
    const h = slackApp((slack) =>
      slack.action("broken", {
        ack: async () => {
          throw new Error("nope");
        },
      }),
    );
    expect((await send(h, blockActionBody({ action_id: "broken" }))).status).toBe(500);
    expect(alerts(h)[0]).toContain("`alpha.action:broken` failed: nope");
  });
});

describe("Slack gateway: /nathan", () => {
  function withPrs() {
    const seen: unknown[] = [];
    const h = slackApp((slack) =>
      slack.command("prs", {
        description: "Your PR queue",
        usage: "[user]",
        ack: async (req) => {
          seen.push({ ack: req.args });
          return "Fetching your queue…";
        },
        lazy: async (req) => {
          seen.push({ lazy: req.args, userId: req.userId, channelId: req.channelId, command: req.command });
          await req.respond({ text: "Here it is" });
        },
      }),
    );
    return { h, seen };
  }

  it.each([[""], ["help"], ["  HELP  "]])("answers %j with help naming the invoked command", async (text) => {
    const { h, seen } = withPrs();
    const result = await send(h, commandBody(text, "/nathan-staging"));
    expect(result.text).toBe(
      [
        "*What I can do* (`/nathan-staging <command>`):",
        "• `/nathan-staging help` — Show this list",
        "• `/nathan-staging prs [user]` — Your PR queue",
      ].join("\n"),
    );
    expect(seen).toEqual([]);
  });

  it("answers an unknown subcommand with an error and the help", async () => {
    const { h } = withPrs();
    const result = await send(h, commandBody("frobnicate now"));
    expect(result.text).toMatch(/^I don't know `\/nathan frobnicate`\.\n\n\*What I can do\*/);
  });

  it("runs a subcommand's ack and lazy handler with its arguments", async () => {
    const { h, seen } = withPrs();
    const result = await send(h, commandBody("PRS  bob "));
    expect(result.text).toBe("Fetching your queue…");
    expect(seen).toEqual([{ ack: "bob" }, { lazy: "bob", userId: "UALICE", channelId: "CPRS", command: "/nathan" }]);
    expect(h.slack.responses).toEqual([
      { responseUrl: "https://hooks.slack.test/commands/1", reply: { text: "Here it is" } },
    ]);
  });

  it("returns a reply with blocks as an ephemeral message", async () => {
    const h = slackApp((slack) =>
      slack.command("hi", { description: "Say hi", ack: async () => ({ text: "hi", blocks: [section("*hi*")] }) }),
    );
    expect((await send(h, commandBody("hi"))).json()).toEqual({
      response_type: "ephemeral",
      text: "hi",
      blocks: [section("*hi*")],
    });
  });

  it("acks silently when a subcommand has no ack", async () => {
    const h = slackApp((slack) => slack.command("quiet", { description: "Shh" }));
    expect(await send(h, commandBody("quiet"))).toMatchObject({ status: 200, text: "" });
  });

  it("apologises and reports when a subcommand's ack throws", async () => {
    let lazyRan = false;
    const h = slackApp((slack) =>
      slack.command("broken", {
        description: "Breaks",
        ack: async () => {
          throw new Error("kaput");
        },
        lazy: async () => {
          lazyRan = true;
        },
      }),
    );
    expect((await send(h, commandBody("broken"))).text).toBe(COMMAND_FAILED_TEXT);
    expect(lazyRan).toBe(false);
    expect(alerts(h)[0]).toContain("`alpha.command:broken` failed: kaput");
  });
});

describe("Slack gateway: App Home", () => {
  it("publishes the composed home for the user who opened it", async () => {
    const h = slackApp((slack) =>
      slack.homeSection({ order: 1, render: async ({ userId }) => [section(`Hello <@${userId}>`)] }),
    );
    expect((await send(h, appHomeOpenedBody("UBOB"), "application/json")).status).toBe(200);
    expect(h.slack.homes).toEqual([{ userId: "UBOB", view: { type: "home", blocks: [section("Hello <@UBOB>")] } }]);
  });

  it("reports a failing section with its feature as the source", async () => {
    const h = slackApp((slack) =>
      slack.homeSection({
        order: 1,
        render: async () => {
          throw new Error("query failed");
        },
      }),
    );
    await send(h, appHomeOpenedBody(), "application/json");
    expect(h.slack.homes).toHaveLength(1);
    expect(alerts(h)[0]).toContain("`alpha.home` failed: query failed");
  });

  it("re-renders the home when a home button is clicked, keeping other sections' states", async () => {
    const h = slackApp((slack) => {
      slack.homeSection({ order: 1, render: async ({ state }) => [section(`tab: ${state ?? "none"}`)] });
      slack.homeButton("pick_tab");
    });
    const body = blockActionBody(
      { action_id: "pick_tab", value: "overdue" },
      { view: { callbackId: "", type: "home", privateMetadata: '{"beta":"x","alpha":"all"}' } },
    );
    expect((await send(h, body)).status).toBe(200);
    expect(h.slack.homes).toEqual([
      {
        userId: "UALICE",
        view: { type: "home", blocks: [section("tab: overdue")], private_metadata: '{"beta":"x","alpha":"overdue"}' },
      },
    ]);
  });

  it("starts the home with no section state when the tab opens", async () => {
    const h = slackApp((slack) =>
      slack.homeSection({ order: 1, render: async ({ state }) => [section(`tab: ${state ?? "none"}`)] }),
    );
    await send(h, appHomeOpenedBody(), "application/json");
    expect(h.slack.homes[0]?.view).toEqual({ type: "home", blocks: [section("tab: none")] });
  });

  it("reports a failed home button re-render", async () => {
    const h = slackApp((slack) => slack.homeButton("pick_tab"));
    h.slack.publishHome = async () => {
      throw new Error("not_enabled");
    };
    await send(h, blockActionBody({ action_id: "pick_tab", value: "x" }, { view: { callbackId: "", type: "home" } }));
    expect(alerts(h)[0]).toContain("`alpha.home_button:pick_tab` failed: not_enabled");
  });

  it("ignores the Messages tab", async () => {
    const h = slackApp(() => {});
    await send(h, appHomeOpenedBody("UBOB", "messages"), "application/json");
    expect(h.slack.homes).toEqual([]);
  });

  it("reports a failed publish", async () => {
    const h = slackApp(() => {});
    const publish = h.slack.publishHome.bind(h.slack);
    h.slack.publishHome = async () => {
      throw new Error("not_enabled");
    };
    await send(h, appHomeOpenedBody(), "application/json");
    h.slack.publishHome = publish;
    expect(alerts(h)[0]).toContain("`slack.app_home` failed: not_enabled");
  });
});
