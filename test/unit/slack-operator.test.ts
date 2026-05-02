import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  formatOperatorResultForSlack,
  isAuthorizedSlackCommand,
  parseCsvSet,
  textFromSlackEvent,
  textFromSlashCommand,
  verifySlackSignature,
} from "../../services/slack-operator/src/slack.js";

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
      "command=%2Faverray&text=status+last+wikipedia+citation+repair&user_id=U1&channel_id=C1&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1"
    );

    expect(command).toEqual({
      text: "status last wikipedia citation repair",
      userId: "U1",
      channelId: "C1",
      responseUrl: "https://hooks.slack.com/commands/1",
    });
  });

  it("extracts app mentions without the bot mention", () => {
    const command = textFromSlackEvent({
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1777740000.123",
      text: "<@B123> run one wikipedia citation repair if safe",
    });

    expect(command).toEqual({
      text: "run one wikipedia citation repair if safe",
      userId: "U1",
      channelId: "C1",
      permalink: "slack://C1/1777740000.123",
    });
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
});
