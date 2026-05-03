import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  formatOperatorResultForSlack,
  isAuthorizedSlackCommand,
  parseCsvSet,
  slackPermalinkFromParts,
  textFromSlackEvent,
  textFromSlashCommand,
  verifySlackSignature,
} from "../../services/slack-operator/src/slack.js";
import { recordOperatorCommandEvent } from "../../services/slack-operator/src/persistence.js";

describe("slack operator bridge", () => {
  it("verifies Slack signatures and rejects stale timestamps", () => {
    const signingSecret = "secret";
    const timestamp = "1777740000";
    const rawBody = "token=ignored&text=status+last+wikipedia+citation+repair";
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody,
      nowMs: 1777740000_000,
    })).toBe(true);
    expect(verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody,
      nowMs: 1777741000_000,
    })).toBe(false);
  });

  it("parses slash command bodies into operator text", () => {
    const command = textFromSlashCommand(
      "command=%2Faverray&text=status+last+wikipedia+citation+repair&team_id=T1&user_id=U1&channel_id=C1&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1"
    );

    expect(command).toEqual({
      text: "status last wikipedia citation repair",
      teamId: "T1",
      userId: "U1",
      channelId: "C1",
      responseUrl: "https://hooks.slack.com/commands/1",
    });
  });

  it("extracts app mentions without the bot mention", () => {
    const command = textFromSlackEvent(
      {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "1777740000.123",
        text: "<@B123> run one wikipedia citation repair if safe",
      },
      "T1"
    );

    expect(command).toEqual({
      text: "run one wikipedia citation repair if safe",
      teamId: "T1",
      userId: "U1",
      channelId: "C1",
      permalink: "https://app.slack.com/client/T1/C1/p1777740000123",
    });
  });

  it("builds Slack permalinks when a team id is available", () => {
    expect(slackPermalinkFromParts("T1", "C1", "1777740000.123")).toBe(
      "https://app.slack.com/client/T1/C1/p1777740000123"
    );
    expect(slackPermalinkFromParts(undefined, "C1", "1777740000.123")).toBe("slack://C1/1777740000.123");
  });

  it("enforces optional user and channel allowlists", () => {
    const config = {
      allowedChannelIds: parseCsvSet("C1,C2"),
      allowedUserIds: parseCsvSet("U1"),
    };

    expect(isAuthorizedSlackCommand({ userId: "U1", channelId: "C2" }, config)).toBe(true);
    expect(isAuthorizedSlackCommand({ userId: "U2", channelId: "C2" }, config)).toBe(false);
    expect(isAuthorizedSlackCommand({ userId: "U1", channelId: "C3" }, config)).toBe(false);
  });

  it("formats status replies with the fields operators need", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "status_last_wikipedia_citation_repair",
      status: {
        found: true,
        runId: "run-1",
        jobId: "wiki-en-1-citation-repair",
        sessionId: "wiki-en-1-citation-repair:0xWallet",
        status: "submitted",
        submittedAt: "2026-05-02T16:28:06.081Z",
        draftId: "draft-1",
        submitSucceeded: true,
        slackPermalink: "https://slack.example/archives/C/p123",
      },
    });

    expect(text).toContain("runId: `run-1`");
    expect(text).toContain("jobId: `wiki-en-1-citation-repair`");
    expect(text).toContain("submit_succeeded: `true`");
    expect(text).toContain("https://slack.example/archives/C/p123");
  });

  it("formats canonical operator status replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "operator_status",
      status: {
        agent: {
          walletReady: true,
          walletAddress: "0xWallet",
        },
        policy: {
          budget: {
            todayUsdSpent: 0.25,
            perDayUsdMax: 1,
          },
        },
        workflows: {
          wikipediaCitationRepair: {
            openJobs: 2,
            discoveredJobs: 3,
            latestRun: { status: "submitted" },
            safeCommands: [
              "operator status",
              "status last wikipedia citation repair",
            ],
          },
        },
      },
    });

    expect(text).toContain("*Averray operator status*");
    expect(text).toContain("wallet: `ready`");
    expect(text).toContain("address: `0xWallet`");
    expect(text).toContain("budget today: `0.25 / 1 USD`");
    expect(text).toContain("wikipedia jobs: `2 open / 3 discovered`");
    expect(text).toContain("latest run: `submitted`");
    expect(text).toContain("`operator status`");
  });

  it("formats workflow replies with compact validation and evidence summary", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "run_wikipedia_citation_repair",
      result: {
        status: "submitted",
        runId: "run-2",
        jobId: "wiki-en-2-citation-repair",
        sessionId: "session-2",
        draftId: "draft-2",
        confidence: 0.72,
        validation: { valid: true },
        evidenceSummary: { totalCitations: 45, flaggedCitations: 45 },
        proposalSummary: { citationFindings: 5, proposedChanges: 5 },
      },
    });

    expect(text).toContain("status: `submitted`");
    expect(text).toContain("validation: `valid`");
    expect(text).toContain("citations reviewed: `45`");
    expect(text).toContain("issues proposed: `5`");
    expect(text).toContain("changes proposed: `5`");
    expect(text).not.toContain("issues flagged");
  });

  it("persists workflow run context but does not attach status commands to the run", async () => {
    const calls: unknown[][] = [];
    await recordOperatorCommandEvent({
      source: "slack",
      commandText: "run one wikipedia citation repair if safe",
      teamId: "T1",
      userId: "U1",
      channelId: "C1",
      slackPermalink: "https://app.slack.com/client/T1/C1/p1",
      replyPermalink: "https://app.slack.com/client/T1/C1/p2",
      result: {
        handled: true,
        kind: "run_wikipedia_citation_repair",
        result: {
          status: "submitted",
          runId: "run-1",
          jobId: "wiki-en-1-citation-repair",
          sessionId: "session-1",
          draftId: "draft-1",
        },
      },
    }, async (_sql, values) => {
      calls.push(values ?? []);
      return [];
    });

    expect(calls[0]).toContain("run-1");
    expect(calls[0]).toContain("wiki-en-1-citation-repair");

    const statusCalls: unknown[][] = [];
    await recordOperatorCommandEvent({
      source: "slack",
      commandText: "status last wikipedia citation repair",
      result: {
        handled: true,
        kind: "status_last_wikipedia_citation_repair",
        status: {
          runId: "run-1",
          jobId: "wiki-en-1-citation-repair",
          status: "submitted",
        },
      },
    }, async (_sql, values) => {
      statusCalls.push(values ?? []);
      return [];
    });

    expect(statusCalls[0]).not.toContain("run-1");
  });
});
