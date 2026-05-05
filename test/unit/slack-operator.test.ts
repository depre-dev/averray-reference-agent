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
      detailed: false,
      status: {
        found: true,
        runId: "wikipedia-citation-repair-035bee96-0d62-45a0-a800-eb7f5316b09f",
        jobId: "wiki-en-1-citation-repair",
        sessionId: "wiki-en-1-citation-repair:0xWallet",
        status: "submitted",
        submittedAt: "2026-05-02T16:28:06.081Z",
        draftId: "draft-1",
        submitSucceeded: true,
        slackPermalink: "https://slack.example/archives/C/p123",
      },
    });

    expect(text).toContain("runId: `wikipedia-citati...7f5316b09f`");
    expect(text).toContain("jobId: `wiki-en-1-citation-repair`");
    expect(text).toContain("submit_succeeded: `true`");
    expect(text).toContain("https://slack.example/archives/C/p123");
    expect(text).toContain("Use `status last wikipedia citation repair details` for full IDs.");
  });

  it("formats detailed status replies with full identifiers", () => {
    const fullRunId = "wikipedia-citation-repair-035bee96-0d62-45a0-a800-eb7f5316b09f";
    const fullDraftId = "c9f24fbfd21cb081af2feac8ef5acf77d65d247889f4fd91706cc516925c1fc1";
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "status_last_wikipedia_citation_repair",
      detailed: true,
      status: {
        found: true,
        runId: fullRunId,
        jobId: "wiki-en-58158792-citation-repair-r7",
        sessionId: "wiki-en-58158792-citation-repair-r7:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
        status: "submitted",
        submittedAt: "2026-05-03T11:43:23.872Z",
        draftId: fullDraftId,
        submitSucceeded: true,
        source: "submissions",
      },
    });

    expect(text).toContain("*Last Wikipedia citation repair - details*");
    expect(text).toContain(fullRunId);
    expect(text).toContain(fullDraftId);
    expect(text).toContain("source: `submissions`");
    expect(text).not.toContain("for full IDs");
  });

  it("formats canonical operator status replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "operator_status",
      detailed: false,
      status: {
        agent: {
          walletReady: true,
          walletAddress: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
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
            latestRun: {
              status: "submitted",
              jobId: "wiki-en-58158792-citation-repair-r7",
            },
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
    expect(text).toContain("address: `0x30BC...eE05`");
    expect(text).toContain("budget today: `0.25 / 1 USD`");
    expect(text).toContain("wikipedia jobs: `2 open / 3 discovered`");
    expect(text).toContain("latest run: `submitted`");
    expect(text).toContain("latest job: `wiki-en-58158792...repair-r7`");
    expect(text).toContain("`operator status`");
    expect(text).toContain("Use `operator status details` for full IDs.");
  });

  it("formats detailed operator status replies with full audit identifiers", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "operator_status",
      detailed: true,
      status: {
        schemaVersion: 1,
        generatedAt: "2026-05-03T12:00:00.000Z",
        mutates: false,
        agent: {
          walletReady: true,
          walletAddress: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
          network: "testnet",
        },
        policy: {
          budget: { todayUsdSpent: 0, perDayUsdMax: 1 },
        },
        workflows: {
          wikipediaCitationRepair: {
            openJobs: 1,
            discoveredJobs: 1,
            latestRun: {
              runId: "wikipedia-citation-repair-run-1",
              jobId: "wiki-en-58158792-citation-repair-r7",
              sessionId: "wiki-en-58158792-citation-repair-r7:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
              status: "submitted",
              draftId: "draft-1",
            },
            candidateJobs: [
              {
                jobId: "wiki-en-58158792-citation-repair-r8",
                title: "Wikipedia citation repair: (+ +)",
                revisionId: "1351905437",
              },
            ],
            safeCommands: ["operator status"],
          },
        },
      },
    });

    expect(text).toContain("*Averray operator status - details*");
    expect(text).toContain("0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05");
    expect(text).toContain("wiki-en-58158792-citation-repair-r7");
    expect(text).toContain("wiki-en-58158792-citation-repair-r8");
    expect(text).toContain("*Open jobs*");
  });

  it("formats daily operator brief replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "daily_operator_brief",
      brief: {
        headline: "2 Wikipedia citation-repair jobs available; start with a dry run.",
        readiness: {
          wallet: "ready",
          wikipediaCitationRepair: "ready",
        },
        budget: {
          todayUsdRemaining: 1,
          perDayUsdMax: 1,
        },
        latestWikipediaCitationRepair: {
          status: "submitted",
          jobId: "wiki-en-58158792-citation-repair-r7",
        },
        candidateJobs: [
          {
            jobId: "wiki-en-58158792-citation-repair-r8",
            title: "Wikipedia citation repair: (+ +)",
            revisionId: "1351905437",
          },
        ],
        recommendedNextActions: ["Use: run one wikipedia citation repair dry run only"],
      },
    });

    expect(text).toContain("*Daily Averray operator brief*");
    expect(text).toContain("wallet: `ready`");
    expect(text).toContain("budget remaining: `1 / 1 USD`");
    expect(text).toContain("wiki-en-58158792-citation-repair-r8");
    expect(text).toContain("This brief is read-only.");
  });

  it("formats safe work discovery replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "find_safe_work",
      safeWork: {
        available: true,
        blockers: [],
        recommendedCommand: "run one wikipedia citation repair dry run only",
        nextMutationCommand: "run one wikipedia citation repair if safe",
        safeWorkItems: [
          {
            rank: 1,
            job: { jobId: "wiki-en-58158792-citation-repair-r8" },
            dryRunCommand: "run wikipedia citation repair for wiki-en-58158792-citation-repair-r8 if safe, dry run only",
          },
        ],
      },
    });

    expect(text).toContain("*Safe work finder*");
    expect(text).toContain("available: `true`");
    expect(text).toContain("recommended: `run one wikipedia citation repair dry run only`");
    expect(text).toContain("submit command: `run one wikipedia citation repair if safe`");
    expect(text).toContain("Discovery is read-only.");
  });

  it("formats agent usefulness replies across surfaces", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "agent_usefulness_plan",
      plan: {
        headline: "I can already brief, inspect, and run guarded work.",
        immediate: {
          safeWorkAvailable: true,
          recommendedCommand: "run one wikipedia citation repair dry run only",
          nextMutationCommand: "run one wikipedia citation repair if safe",
        },
        surfaces: {
          slack: { status: "enabled" },
          commandCenter: { status: "enabled", publicAccess: "cloudflare_access_configured" },
          mcp: { status: "enabled" },
        },
        useCases: [
          { id: "slack_work_assistant", status: "enabled", value: "Posts compact operator answers." },
          { id: "github_helper", status: "next_integration", value: "Summarize CI and draft replies." },
        ],
        nextImplementationTracks: ["GitHub PR/issue digest and CI failure explainer"],
      },
    });

    expect(text).toContain("*Averray agent usefulness plan*");
    expect(text).toContain("safe work: `true`");
    expect(text).toContain("Slack: `enabled`");
    expect(text).toContain("Command Center/mobile: `enabled`");
    expect(text).toContain("`slack_work_assistant`");
    expect(text).toContain("GitHub PR/issue digest");
  });

  it("formats business ledger and ops health replies", () => {
    const ledger = formatOperatorResultForSlack({
      handled: true,
      kind: "business_ledger",
      ledger: {
        summary: {
          latestWikipediaCitationRepair: {
            status: "submitted",
            jobId: "wiki-en-58158792-citation-repair-r7",
            submittedAt: "2026-05-03T11:43:23.872Z",
          },
          openWikipediaCitationRepairJobs: 2,
          budget: { todayUsdSpent: 0.1, perDayUsdMax: 1 },
          sevenDaySubmissions: { total: 4, completed: 3, failed: 1 },
          sevenDayDrafts: { total: 5, valid: 4, invalid: 1 },
          sevenDayOperatorCommands: { total: 8, slackRouted: 6 },
        },
      },
    });
    expect(ledger).toContain("*Averray business ledger*");
    expect(ledger).toContain("3 completed / 1 failed / 4 total");
    expect(ledger).toContain("open wiki repair jobs: `2`");

    const health = formatOperatorResultForSlack({
      handled: true,
      kind: "ops_health",
      health: {
        health: "ready",
        wallet: { walletReady: true },
        budget: { todayUsdRemaining: 0.9 },
        controlPlane: {
          tables: {
            submissions: 4,
            drafts: 5,
            operatorEvents: 8,
            lastOperatorEventAt: "2026-05-03T11:50:00.000Z",
          },
          recentErrors: [],
          recentOperatorEvents: [
            { command: "status last wikipedia citation repair", source: "slack", status: "submitted" },
          ],
        },
      },
    });
    expect(health).toContain("*Averray ops health*");
    expect(health).toContain("health: `ready`");
    expect(health).toContain("operator events: `8`");
    expect(health).toContain("none recorded");
  });

  it("formats workflow replies with compact validation and evidence summary", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "run_wikipedia_citation_repair",
      result: {
        status: "submitted",
        runId: "wikipedia-citation-repair-035bee96-0d62-45a0-a800-eb7f5316b09f",
        jobId: "wiki-en-58158792-citation-repair-r7",
        sessionId: "wiki-en-58158792-citation-repair-r7:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
        draftId: "c9f24fbfd21cb081af2feac8ef5acf77d65d247889f4fd91706cc516925c1fc1",
        confidence: 0.72,
        validation: { valid: true },
        evidenceSummary: { totalCitations: 45, flaggedCitations: 45 },
        proposalSummary: { citationFindings: 5, proposedChanges: 5 },
      },
    });

    expect(text).toContain("status: `submitted`");
    expect(text).toContain("runId: `wikipedia-citati...7f5316b09f`");
    expect(text).toContain("sessionId: `wiki-en-58158792...a57CdeE05`");
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
