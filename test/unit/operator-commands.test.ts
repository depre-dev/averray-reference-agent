import { describe, expect, it } from "vitest";

import {
  getLastWikipediaCitationRepairStatus,
  parseOperatorCommand,
} from "../../packages/averray-mcp/src/operator-commands.js";

describe("operator commands", () => {
  it("routes the short Slack repair command to the workflow with mutations enabled", () => {
    const parsed = parseOperatorCommand("run one wikipedia citation repair if safe", {
      source: "slack",
    });

    expect(parsed).toMatchObject({
      handled: true,
      kind: "run_wikipedia_citation_repair",
      source: "slack",
      input: {
        dryRun: false,
        maxEvidenceUrls: 5,
        confidenceThreshold: 0.7,
      },
    });
  });

  it("extracts a target job and respects dry-run wording", () => {
    const parsed = parseOperatorCommand(
      "Run Wikipedia citation repair for wiki-en-58158792-citation-repair-r5 if safe, dry run only",
      { source: "command_center" }
    );

    expect(parsed).toMatchObject({
      handled: true,
      kind: "run_wikipedia_citation_repair",
      source: "command_center",
      input: {
        jobId: "wiki-en-58158792-citation-repair-r5",
        dryRun: true,
      },
    });
  });

  it("accepts dry-run repair wording without a live safety phrase", () => {
    const parsed = parseOperatorCommand("run one wikipedia citation repair dry run only", {
      source: "operator",
    });

    expect(parsed).toMatchObject({
      handled: true,
      kind: "run_wikipedia_citation_repair",
      source: "operator",
      input: {
        dryRun: true,
      },
    });
  });

  it("routes the latest status command read-only", () => {
    const parsed = parseOperatorCommand("status last wikipedia citation repair.", { source: "operator" });

    expect(parsed).toEqual({
      handled: true,
      kind: "status_last_wikipedia_citation_repair",
      source: "operator",
      detailed: false,
    });
  });

  it("routes operator status and help to the canonical read-only status", () => {
    expect(parseOperatorCommand("operator status", { source: "operator" })).toEqual({
      handled: true,
      kind: "operator_status",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("operator status details", { source: "operator" })).toEqual({
      handled: true,
      kind: "operator_status",
      source: "operator",
      detailed: true,
    });
    expect(parseOperatorCommand("status last wikipedia citation repair full", { source: "slack" })).toEqual({
      handled: true,
      kind: "status_last_wikipedia_citation_repair",
      source: "slack",
      detailed: true,
    });
    expect(parseOperatorCommand("help", { source: "slack" })).toEqual({
      handled: true,
      kind: "operator_status",
      source: "slack",
      detailed: false,
    });
  });

  it("routes daily brief and safe work discovery read-only", () => {
    expect(parseOperatorCommand("daily operator brief", { source: "slack" })).toEqual({
      handled: true,
      kind: "daily_operator_brief",
      source: "slack",
      detailed: false,
    });
    expect(parseOperatorCommand("find safe work details", { source: "command_center" })).toEqual({
      handled: true,
      kind: "find_safe_work",
      source: "command_center",
      detailed: true,
    });
    expect(parseOperatorCommand("what should I do next?", { source: "operator" })).toEqual({
      handled: true,
      kind: "find_safe_work",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("what can you do for us?", { source: "operator" })).toEqual({
      handled: true,
      kind: "agent_usefulness_plan",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("how can you help details", { source: "command_center" })).toEqual({
      handled: true,
      kind: "agent_usefulness_plan",
      source: "command_center",
      detailed: true,
    });
    expect(parseOperatorCommand("project memory", { source: "operator" })).toEqual({
      handled: true,
      kind: "project_memory",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("known projects details", { source: "slack" })).toEqual({
      handled: true,
      kind: "project_memory",
      source: "slack",
      detailed: true,
    });
    expect(parseOperatorCommand("how do we deploy averray-agent/agent details", { source: "command_center" })).toEqual({
      handled: true,
      kind: "project_memory",
      source: "command_center",
      detailed: true,
      project: "averray-agent/agent",
    });
    expect(parseOperatorCommand("runbook for deploy averray-agent/agent", { source: "operator" })).toEqual({
      handled: true,
      kind: "project_runbook",
      source: "operator",
      detailed: false,
      action: "deploy",
      project: "averray-agent/agent",
      query: "runbook for deploy averray-agent/agent",
    });
    expect(parseOperatorCommand("secret rotation runbook details", { source: "slack" })).toEqual({
      handled: true,
      kind: "project_runbook",
      source: "slack",
      detailed: true,
      action: "secret_rotation",
      query: "secret rotation runbook details",
    });
    expect(parseOperatorCommand("can you admin my projects?", { source: "operator" })).toEqual({
      handled: true,
      kind: "admin_readiness",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("admin readiness details", { source: "slack" })).toEqual({
      handled: true,
      kind: "admin_readiness",
      source: "slack",
      detailed: true,
    });
    expect(parseOperatorCommand("propose merge for averray-agent/agent#123", { source: "operator" })).toEqual({
      handled: true,
      kind: "admin_proposal",
      source: "operator",
      detailed: false,
      input: {
        action: "merge",
        repo: "averray-agent/agent",
        pullRequestNumber: 123,
        requester: "operator",
        reason: "propose merge for averray-agent/agent#123",
      },
    });
    expect(parseOperatorCommand("propose deploy for averray-agent/agent sha abc1234 details", { source: "slack" })).toEqual({
      handled: true,
      kind: "admin_proposal",
      source: "slack",
      detailed: true,
      input: {
        action: "deploy",
        repo: "averray-agent/agent",
        sha: "abc1234",
        requester: "slack",
        reason: "propose deploy for averray-agent/agent sha abc1234 details",
      },
    });
    expect(parseOperatorCommand("business ledger", { source: "slack" })).toEqual({
      handled: true,
      kind: "business_ledger",
      source: "slack",
      detailed: false,
    });
    expect(parseOperatorCommand("ops health details", { source: "operator" })).toEqual({
      handled: true,
      kind: "ops_health",
      source: "operator",
      detailed: true,
    });
  });

  it("routes GitHub helper commands read-only", () => {
    expect(parseOperatorCommand("github status", { source: "operator" })).toEqual({
      handled: true,
      kind: "github_status",
      source: "operator",
      view: "status",
      detailed: false,
    });
    expect(parseOperatorCommand("github open prs details", { source: "slack" })).toEqual({
      handled: true,
      kind: "github_status",
      source: "slack",
      view: "prs",
      detailed: true,
    });
    expect(parseOperatorCommand("github ci failures", { source: "command_center" })).toEqual({
      handled: true,
      kind: "github_status",
      source: "command_center",
      view: "ci",
      detailed: false,
    });
    expect(parseOperatorCommand("github issue digest", { source: "operator" })).toEqual({
      handled: true,
      kind: "github_status",
      source: "operator",
      view: "issues",
      detailed: false,
    });
    expect(parseOperatorCommand("daily github brief", { source: "slack" })).toEqual({
      handled: true,
      kind: "github_brief",
      source: "slack",
      detailed: false,
    });
    expect(parseOperatorCommand("what changed since last time details", { source: "command_center" })).toEqual({
      handled: true,
      kind: "github_brief",
      source: "command_center",
      detailed: true,
    });
  });

  it("routes the platform testbed E2E suite read-only", () => {
    expect(parseOperatorCommand("testbed e2e suite", { source: "operator" })).toEqual({
      handled: true,
      kind: "testbed_e2e_suite",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("platform e2e suite details", { source: "slack" })).toEqual({
      handled: true,
      kind: "testbed_e2e_suite",
      source: "slack",
      detailed: true,
    });
  });

  it("routes the executable read-only testbed E2E run separately from the suite", () => {
    expect(parseOperatorCommand("run testbed e2e read-only", { source: "operator" })).toEqual({
      handled: true,
      kind: "run_testbed_e2e_read_only",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("platform e2e read only details", { source: "slack" })).toEqual({
      handled: true,
      kind: "run_testbed_e2e_read_only",
      source: "slack",
      detailed: true,
    });
  });

  it("routes Hermes handoff monitor commands read-only", () => {
    expect(parseOperatorCommand("handoff monitor", { source: "operator" })).toEqual({
      handled: true,
      kind: "handoff_monitor",
      source: "operator",
      detailed: false,
    });
    expect(parseOperatorCommand("what is Hermes doing details", { source: "command_center" })).toEqual({
      handled: true,
      kind: "handoff_monitor",
      source: "command_center",
      detailed: true,
    });
  });

  it("returns latest submit status with draft id and Slack permalink when stored", async () => {
    const status = await getLastWikipediaCitationRepairStatus(async (text) => {
      if (text.includes("from submissions")) {
        return [
          {
            request: {
              policyRunId: "wikipedia-citation-repair-run-1",
              jobId: "wiki-en-45188030-citation-repair-album-r2",
              sessionId: "wiki-en-45188030-citation-repair-album-r2:0xWallet",
              draftId: "draft-1",
            },
            response: {
              state: "submitted",
              slack: { permalink: "https://slack.example/archives/C/p123" },
            },
            status: "completed",
            updated_at: "2026-05-02T16:28:06.073Z",
            draft_validation_status: "valid",
          },
        ];
      }
      return [];
    });

    expect(status).toMatchObject({
      found: true,
      runId: "wikipedia-citation-repair-run-1",
      jobId: "wiki-en-45188030-citation-repair-album-r2",
      sessionId: "wiki-en-45188030-citation-repair-album-r2:0xWallet",
      status: "submitted",
      submittedAt: "2026-05-02T16:28:06.073Z",
      draftId: "draft-1",
      draftValidationStatus: "valid",
      submitSucceeded: true,
      slackPermalink: "https://slack.example/archives/C/p123",
      source: "submissions",
    });
  });

  it("falls back to the latest draft when no submit exists", async () => {
    const status = await getLastWikipediaCitationRepairStatus(async (text) => {
      if (text.includes("from draft_submissions")) {
        return [
          {
            draft_id: "draft-2",
            run_id: "run-2",
            job_id: "wiki-en-62871101-citation-repair-hash-r2",
            session_id: "wiki-en-62871101-citation-repair-hash-r2:0xWallet",
            validation_status: "valid",
            updated_at: new Date("2026-05-02T16:30:00.000Z"),
          },
        ];
      }
      return [];
    });

    expect(status).toMatchObject({
      found: true,
      runId: "run-2",
      jobId: "wiki-en-62871101-citation-repair-hash-r2",
      status: "draft_saved",
      draftId: "draft-2",
      draftValidationStatus: "valid",
      submitSucceeded: false,
      source: "draft_submissions",
      updatedAt: "2026-05-02T16:30:00.000Z",
    });
  });
});
