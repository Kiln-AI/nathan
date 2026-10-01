import type { Registrar } from "../../core/feature";
import type { PRConfig } from "./config";
import type { PRContext } from "./refresh";
import { generateReport } from "./report";

// On-demand PR report (task: nathan-pr-report-command): the same report the daily schedule would
// post, delivered as a DM to whoever ran the command. Does not record the report, so the next
// scheduled one is unaffected.

export const PR_REPORT_COMMAND = "pr_report";
export const ACK_TEXT = "Building your PR report — I'll send it to you as a DM.";

export function registerPRReport(registrar: Registrar<PRConfig>, ctx: PRContext): void {
  const { services } = ctx;

  registrar.slack.command(PR_REPORT_COMMAND, {
    description: "Get the current PR report as a DM",
    ack: async () => ACK_TEXT,
    lazy: async (request) => {
      const now = services.clock.now();
      const {
        messages: [first, ...rest],
      } = await generateReport(ctx, now);
      const posted = await services.slack.sendDirectMessage(request.userId, {
        text: first.text,
        blocks: first.blocks,
      });
      for (const part of rest) {
        await services.slack.postMessage({
          channel: posted.channel,
          thread_ts: posted.ts,
          text: part.text,
          blocks: part.blocks,
        });
      }
    },
  });
}
