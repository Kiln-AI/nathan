---
status: complete
---

# Nathan

I want to make a team Slack bot: @nathan

High level: I have some initial scenarios in mind, but want to set it up so the team can hack on it, add features, tweak it. So design for long-term extensibility is key (don't need to over-engineer it, but explain why we're building our own vs using something off the shelf).

It's not our "AI agent". We have Claude for that. It's for things that are more deterministic/automatable.

So we need general capabilities:

* Read-only GitHub access: PRs, assignees, more. Maybe write, but only if we can scope it well/safely.
* Slack access/bot: all the usual: can offer choices, answers take action
* etc.

## First scenario is PR/CR management

We want to cut down on PRs staying open long term. PR-to-merge velocity should go up.

* Standard way of posting them to Slack: a "Request CR" workflow (we have one today, but can take it over)
* Enforce that PRs have assignees (can't request CR if not also assigned on GitHub, or requesting/tagging people on Slack does the assignment on GitHub for you)
* Stale PR reminders:
   * if no one assigned or "request changes": bug owner
   * if folks assigned: bug assignees
   * always: an owner, a next step
* A daily PR report:
   * Nice report: avg open time, volume per person, etc.
   * Special sections like OSS contributors, Dependabot, etc.
* Support for draft/WIP PRs:
   * Generally excluded, but not allowed to sit around for months either
* This is rough. Want a great way to keep my team moving. Open to suggestions in feature planning.
