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
        decisionSummary: {
          health: "attention",
          attentionItems: [
            {
              severity: "medium",
              source: "github",
              title: "1 open PR",
              detail: "Review the open PR before merging.",
            },
          ],
          suggestedActions: ["github status", "handoff monitor"],
        },
        recommendedNextActions: ["Use: run one wikipedia citation repair dry run only"],
      },
    });

    expect(text).toContain("*Daily Averray operator brief*");
    expect(text).toContain("wallet: `ready`");
    expect(text).toContain("budget remaining: `1 / 1 USD`");
    expect(text).toContain("*Decision summary*");
    expect(text).toContain("health: `attention`");
    expect(text).toContain("*Needs attention*");
    expect(text).toContain("github: 1 open PR");
    expect(text).toContain("`github status`");
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

  it("formats project memory replies", () => {
    const list = formatOperatorResultForSlack({
      handled: true,
      kind: "project_memory",
      memory: {
        projects: [
          {
            id: "averray-platform",
            name: "Averray Platform",
            repos: ["averray-agent/agent"],
            role: "Primary product platform.",
          },
        ],
      },
    });

    expect(list).toContain("*Known project memory*");
    expect(list).toContain("*Averray Platform*");
    expect(list).toContain("`averray-agent/agent`");
    expect(list).toContain("No secrets are stored");

    const selected = formatOperatorResultForSlack({
      handled: true,
      kind: "project_memory",
      memory: {
        selectedProject: {
          id: "averray-platform",
          name: "Averray Platform",
          repos: ["averray-agent/agent"],
          owner: "Pascal / Averray",
          role: "Primary product platform.",
          environments: [{ name: "production app", url: "https://app.averray.com" }],
          deploy: {
            trigger: "Merge to main after CI passes.",
            workflow: "Deploy Production",
            script: "/srv/agent-stack/app/scripts/ops/deploy-production.sh",
          },
          routineCommands: ["github status", "github brief"],
          safety: { secretsInMemory: false, autoMergeEnabled: false, autoDeployEnabled: false },
          openQuestions: ["Document token rotation owner."],
        },
      },
    });

    expect(selected).toContain("*Project memory - Averray Platform*");
    expect(selected).toContain("production app: https://app.averray.com");
    expect(selected).toContain("trigger: `Merge to main after CI passes.`");
    expect(selected).toContain("workflow: `Deploy Production`");
    expect(selected).toContain("secrets stored: `false`");
    expect(selected).toContain("Read-only project memory");
  });

  it("formats project runbook replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "project_runbook",
      runbook: {
        title: "Deploy runbook - Averray Platform",
        action: "deploy",
        target: { name: "Averray Platform" },
        project: { name: "Averray Platform" },
        runbook: {
          goal: "Ship a known commit safely.",
          trigger: "Merge to main after CI passes.",
          requiredEvidence: ["CI is green", "Rollback path is known"],
          operatorSteps: ["Watch deploy workflow", "Run post-deploy suite"],
          stopConditions: ["CI is failing"],
          postActionVerification: ["Check hosted health"],
        },
        suggestedHermesCommands: ["run testbed e2e read-only"],
        safety: {
          readOnly: true,
          approvalRequired: true,
          mutates: false,
          secretsIncluded: false,
        },
      },
    });

    expect(text).toContain("*Deploy runbook - Averray Platform*");
    expect(text).toContain("action: `deploy`");
    expect(text).toContain("*Required evidence*");
    expect(text).toContain("CI is green");
    expect(text).toContain("*Operator steps*");
    expect(text).toContain("run testbed e2e read-only");
    expect(text).toContain("Runbook-only");
  });

  it("formats admin readiness replies with staged guardrails", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "admin_readiness",
      readiness: {
        headline: "I am ready to be an operator copilot now.",
        currentRole: {
          level: "operator_copilot",
          canAdministerAutomatically: false,
        },
        readiness: {
          overall: "ready_for_operator_copilot",
          slackOperator: "enabled",
          commandCenter: "enabled",
          publicAccess: "cloudflare_access_configured",
        },
        adminLadder: [
          { stage: 1, name: "Observe and brief", status: "enabled" },
          { stage: 2, name: "Draft and recommend", status: "enabled" },
          { stage: 3, name: "Approval-gated execution", status: "partially_enabled" },
          { stage: 4, name: "Scoped project admin", status: "not_enabled" },
        ],
        canDoNow: ["Summarize current Averray work and budget."],
        shouldNotDoYet: ["Merge PRs or push code without a project-specific approval policy."],
        requiredBeforeProjectAdmin: ["Define a project registry with owners, environments, and allowed actions."],
      },
    });

    expect(text).toContain("*Averray admin readiness*");
    expect(text).toContain("level: `operator_copilot`");
    expect(text).toContain("auto-admin: `false`");
    expect(text).toContain("Observe and brief: `enabled`");
    expect(text).toContain("Scoped project admin: `not_enabled`");
    expect(text).toContain("Broad project-admin actions are denied by default");
  });

  it("formats admin proposal replies as proposal-only", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "admin_proposal",
      proposal: {
        kind: "admin_action_proposal",
        action: {
          type: "merge",
          target: {
            repo: "averray-agent/agent",
            pullRequestNumber: 123,
            sha: null,
          },
        },
        recommendation: {
          status: "ready_for_human_approval",
          reason: "read_only_signals_clear",
          summary: "Read-only signals are clear.",
        },
        approval: {
          required: true,
        },
        evidence: [
          { source: "github", status: "ok", detail: "0 failing workflows" },
        ],
        risks: [
          { severity: "low", code: "proposal_only", message: "Execution is manual." },
        ],
        blockedActions: ["merge_pull_request", "push_code"],
        nextHumanStep: "Review the PR, CI, and handoff monitor.",
      },
    });

    expect(text).toContain("*Admin proposal - merge*");
    expect(text).toContain("status: `ready_for_human_approval`");
    expect(text).toContain("approval required: `true`");
    expect(text).toContain("`github`: `ok`");
    expect(text).toContain("`merge_pull_request`");
    expect(text).toContain("Hermes did not approve, merge, deploy");
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

  it("formats GitHub helper replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "github_status",
      view: "digest",
      detailed: false,
      github: {
        configured: true,
        health: "attention",
        repoCount: 1,
        totals: {
          openPullRequests: 1,
          openIssues: 1,
          failingWorkflowRuns: 1,
          activeWorkflowRuns: 0,
        },
        selectedView: {
          name: "digest",
          items: [
            {
              kind: "digest_item",
              severity: "blocked",
              repo: "averray-agent/agent",
              title: "CI failure: CI",
            },
            {
              kind: "digest_item",
              severity: "attention",
              repo: "averray-agent/agent",
              title: "PR #182: Add GitHub operator digest views",
            },
          ],
        },
        warnings: [],
        recommendations: ["Start with `github ci failures` and inspect the failing run logs."],
      },
    });

    expect(text).toContain("*GitHub digest*");
    expect(text).toContain("health: `attention`");
    expect(text).toContain("open PRs: `1`");
    expect(text).toContain("CI failing/active: `1/0`");
    expect(text).toContain("CI failure: CI");
    expect(text).toContain("github ci failures");
    expect(text).toContain("Use `github status details`");
  });

  it("formats unconfigured GitHub helper replies with setup guidance", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "github_status",
      github: {
        configured: false,
        warnings: [
          { severity: "high", code: "github_token_missing", message: "GITHUB_TOKEN is not configured." },
        ],
      },
    });

    expect(text).toContain("*GitHub operator status*");
    expect(text).toContain("not configured yet");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("GITHUB_DEFAULT_REPO");
  });

  it("formats GitHub brief replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "github_brief",
      detailed: false,
      github: {
        configured: true,
        repoCount: 1,
        since: "2026-05-08T10:00:00.000Z",
        isFirstBrief: false,
        persistsLocalSnapshot: true,
        summary: {
          changed: 1,
          merged: 1,
          deployed: 1,
          failed: 1,
          attention: 1,
        },
        sections: {
          changed: [
            {
              kind: "pull_request",
              repo: "averray-agent/agent",
              title: "PR #185: Record testnet deployment manifest",
              detail: "Opened or updated PR",
              occurredAt: "2026-05-08T11:30:00.000Z",
            },
          ],
          merged: [
            {
              kind: "pull_request",
              repo: "averray-agent/agent",
              title: "PR #184: Reconcile testnet checklists",
              detail: "Merged PR",
            },
          ],
          deployed: [
            {
              kind: "workflow_run",
              repo: "averray-agent/agent",
              title: "Deploy Production",
              detail: "Successful deploy/publish workflow",
            },
          ],
          failed: [
            {
              kind: "workflow_run",
              repo: "averray-agent/agent",
              title: "CI",
              detail: "Workflow failure",
            },
          ],
          attention: [
            {
              kind: "pull_request",
              repo: "averray-agent/agent",
              title: "PR #185: Record testnet deployment manifest",
              detail: "Open PR needs review/merge decision",
            },
          ],
        },
        warnings: [],
        recommendations: ["Start with failed workflow runs before merging or deploying more work."],
      },
    });

    expect(text).toContain("*GitHub brief*");
    expect(text).toContain("Since: `2026-05-08T10:00:00.000Z`");
    expect(text).toContain("changed/merged/deployed/failed/attention: `1/1/1/1/1`");
    expect(text).toContain("*Merged*");
    expect(text).toContain("Deploy Production");
    expect(text).toContain("Workflow failure");
    expect(text).toContain("local brief checkpoint was updated");
  });

  it("formats GitHub merge steward replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "github_merge_steward",
      github: {
        configured: true,
        health: "degraded",
        mergeExecutionEnabled: false,
        counts: {
          openPullRequests: 2,
          pass: 1,
          humanReview: 0,
          block: 1,
          autoMergeCandidates: 1,
        },
        groups: {
          autoMergeCandidates: [
            {
              repo: "averray-agent/agent",
              pullRequestNumber: 187,
              title: "Polish dashboard empty states",
              url: "https://github.com/averray-agent/agent/pull/187",
              finalVerdict: "pass",
              reason: "github_ok_to_merge",
              checks: { total: 1, passed: 1, failed: 0, active: 0 },
              touchedAreas: ["frontend", "tests"],
            },
          ],
          humanReview: [],
          blocked: [
            {
              repo: "averray-agent/agent",
              pullRequestNumber: 189,
              title: "Update settlement contract",
              finalVerdict: "block",
              reason: "pr_critical_files",
              checks: { total: 1, passed: 1, failed: 0, active: 0 },
              touchedAreas: ["contracts"],
            },
          ],
        },
        recommendations: ["1 PR(s) are clean merge candidates. Merge execution is still disabled in this read-only steward."],
      },
    });

    expect(text).toContain("*GitHub merge steward*");
    expect(text).toContain("open/pass/human/block: `2/1/0/1`");
    expect(text).toContain("merge execution enabled: `false`");
    expect(text).toContain("*Clean candidates*");
    expect(text).toContain("github_ok_to_merge");
    expect(text).toContain("*Blocked*");
    expect(text).toContain("pr_critical_files");
    expect(text).toContain("Hermes did not merge");
  });

  it("formats testbed E2E suite replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "testbed_e2e_suite",
      suite: {
        headline: "Platform testbed is ready for read-only and dry-run E2E checks.",
        readiness: {
          overall: "ready",
          canRunReadOnly: true,
          canRunDryRun: true,
          canRunGuardedLive: true,
          blockers: [],
          warnings: [],
        },
        testCases: [
          {
            id: "TBE2E-001",
            name: "Operator readiness",
            status: "ready",
            mutates: false,
            surfaces: { operatorCommand: "operator status" },
          },
          {
            id: "TBE2E-005",
            name: "Guarded live Wikipedia citation repair",
            status: "manual",
            mutates: true,
            surfaces: { operatorCommand: "run one wikipedia citation repair if safe" },
          },
        ],
        nextCommands: {
          readOnly: "testbed e2e suite",
          dryRun: "run one wikipedia citation repair dry run only",
          guardedLive: "run one wikipedia citation repair if safe",
        },
        safety: {
          suiteGeneratorMutates: false,
          guardedLiveCaseMutates: true,
          editsWikipedia: false,
        },
      },
    });

    expect(text).toContain("*Averray testbed E2E suite*");
    expect(text).toContain("overall: `ready`");
    expect(text).toContain("dry run: `true`");
    expect(text).toContain("mutating/manual: `1`");
    expect(text).toContain("`TBE2E-005` Guarded live Wikipedia citation repair: `manual mutates`");
    expect(text).toContain("suite mutates: `false`");
    expect(text).toContain("edits Wikipedia: `false`");
  });

  it("formats executable read-only testbed E2E run replies", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "run_testbed_e2e_read_only",
      run: {
        status: "passed",
        durationMs: 1234,
        summary: {
          totalCases: 11,
          executed: 8,
          passed: 8,
          failed: 0,
          skipped: 3,
        },
        cases: [
          {
            id: "TBE2E-001",
            name: "Operator readiness",
            status: "passed",
            mutates: false,
          },
          {
            id: "TBE2E-005",
            name: "Guarded live Wikipedia citation repair",
            status: "skipped",
            mutates: true,
            mutationScope: "averray_claim_draft_validate_submit_only",
            reason: "requires_explicit_mutation_command",
          },
          {
            id: "TBE2E-010",
            name: "GitHub delta brief",
            status: "skipped",
            mutates: true,
            mutationScope: "local_brief_checkpoint_only",
            reason: "writes_local_github_brief_checkpoint",
          },
        ],
        skippedMutationBoundaries: [
          {
            id: "TBE2E-005",
            name: "Guarded live Wikipedia citation repair",
            mutationScope: "averray_claim_draft_validate_submit_only",
            reason: "requires_explicit_mutation_command",
          },
          {
            id: "TBE2E-010",
            name: "GitHub delta brief",
            mutationScope: "local_brief_checkpoint_only",
            reason: "writes_local_github_brief_checkpoint",
          },
        ],
        safety: {
          mutates: false,
          skippedGuardedLiveWorkflow: true,
          skippedGithubBriefCheckpoint: true,
          editsWikipedia: false,
        },
      },
    });

    expect(text).toContain("*Averray testbed E2E read-only run*");
    expect(text).toContain("status: `passed`");
    expect(text).toContain("executed/passed/failed/skipped: `8/8/0/3`");
    expect(text).toContain("`TBE2E-001` Operator readiness: `passed`");
    expect(text).toContain("`TBE2E-005` Guarded live Wikipedia citation repair: `skipped`");
    expect(text).toContain("writes_local_github_brief_checkpoint");
    expect(text).toContain("GitHub brief checkpoint skipped: `true`");
    expect(text).toContain("edits Wikipedia: `false`");
  });

  it("formats handoff monitor replies with active and recent work", () => {
    const text = formatOperatorResultForSlack({
      handled: true,
      kind: "handoff_monitor",
      monitor: {
        status: "active",
        counts: {
          events: 5,
          correlations: 2,
          active: 1,
          recent: 2,
        },
        active: [
          {
            correlationId: "github-pr-218-dc3e4e60104582e987dd53398fdb7c9676e25d67-25607150732",
            requester: "github-actions",
            intent: "pr_handoff",
            repo: "averray-agent/agent",
            pullRequestNumber: 218,
            pullRequestUrl: "https://github.com/averray-agent/agent/pull/218",
            testCaseIds: ["TBE2E-004"],
            reason: "post-CI PR handoff",
            status: "running",
            phase: "testbed",
            active: true,
            updatedAt: "2026-05-09T17:24:30.000Z",
            summary: {
              finalVerdict: "PASS",
              mergeRecommendation: "Wait for merge group CI.",
              codeReviewVerdict: "ok",
            },
          },
        ],
        recent: [
          {
            correlationId: "github-pr-218-dc3e4e60104582e987dd53398fdb7c9676e25d67-25607150732",
            status: "running",
          },
          {
            correlationId: "github-deploy-25608715158-22beb113398569d4bd5d0bf85373777486f8b70c",
            requester: "github-actions",
            intent: "post_deploy",
            repo: "averray-agent/agent",
            sha: "22beb113398569d4bd5d0bf85373777486f8b70c",
            status: "completed",
            phase: "completed",
            updatedAt: "2026-05-09T20:36:00.000Z",
            summary: {
              finalVerdict: "pass",
              finalReason: "post_deploy_healthy",
              mergeRecommendation: "n/a",
              deploymentHealth: {
                suitePassed: 7,
                suiteFailed: 0,
                suiteSkipped: 1,
                hostedStatus: "ok",
                githubHealth: "ok",
                opsStatus: "ok",
              },
            },
          },
        ],
        safety: {
          readOnly: true,
          githubMutated: false,
          wikipediaEdited: false,
          freeFormHermesPromptUsed: false,
        },
      },
    });

    expect(text).toContain("*Hermes handoff monitor*");
    expect(text).toContain("status: `active`");
    expect(text).toContain("*Active now*");
    expect(text).toContain("<https://github.com/averray-agent/agent/pull/218|averray-agent/agent#218>");
    expect(text).toContain("tests: `TBE2E-004`");
    expect(text).toContain("verdict: `PASS`");
    expect(text).toContain("code review: `ok`");
    expect(text).toContain("*Recent handoffs*");
    expect(text).toContain("post_deploy");
    expect(text).toContain("*PASS* averray-agent/agent");
    expect(text).toContain("why: post-deploy suite, GitHub workflows, and hosted health are clean");
    expect(text).toContain("<https://github.com/averray-agent/agent/commit/22beb113398569d4bd5d0bf85373777486f8b70c|22beb113398569d4...86f8b70c>");
    expect(text).toContain("<https://github.com/averray-agent/agent/actions/runs/25608715158|workflow run>");
    expect(text).toContain("deploy health: `suite pass 7 / fail 0 / skip 1 · hosted ok · github ok · ops ok`");
    expect(text).toContain("GitHub mutated: `false`");
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
