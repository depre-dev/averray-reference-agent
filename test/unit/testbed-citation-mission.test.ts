import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  citationRepairResultToReport,
  executeCitationRepairMission,
} from "../../services/slack-operator/src/testbed-citation-mission.js";
import type { TestbedMissionRun } from "../../services/slack-operator/src/monitor-testbed-missions.js";
import type { TestbedMissionRunnerConfig } from "../../services/slack-operator/src/testbed-mission-runner.js";
import {
  __resetTestbedMissionRunsForTests,
  recordTestbedMissionReportFromMessage,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
  createMonitorTestbedMissionFromPayload,
  approveRequestedTestbedMission,
  getTestbedMissionForAgent,
} from "../../services/slack-operator/src/testbed-agent-entrypoint.js";

// A representative dry-run workflow result (needs_review: a proposal was built).
const NEEDS_REVIEW_RESULT = {
  status: "needs_review",
  dryRun: true,
  runId: "run-1",
  jobId: "job-42",
  confidence: 0.82,
  evidenceSummary: { totalCitations: 12, flaggedCitations: 3, deadLinkCitations: 2 },
  readiness: {
    validatedBeforeClaim: true,
    invalidWrappedOutput: { probeResult: { valid: false, reason: "wrapper rejected" } },
  },
  proposalPreview: {
    citation_findings: [
      { problem: "dead link", current_claim: "Founded in 1999 [1]" },
    ],
    proposed_changes: [
      { target_text: "[1] http://dead.example", replacement_text: "[1] https://archive.example/1999" },
    ],
    review_notes: "One dead link replaced with an archived copy.",
  },
  reviewNotes: ["Verify the archived copy matches the original source."],
};

const BLOCKED_RESULT = {
  status: "blocked",
  dryRun: true,
  reason: "pre-claim validation failed: schema mismatch",
  confidence: 0.4,
  reviewNotes: ["Fix the proposal shape before retrying."],
};

const config = {} as TestbedMissionRunnerConfig;

describe("citationRepairResultToReport", () => {
  it("maps needs_review → pass and preserves counts, readiness, and the proposal preview", () => {
    const report = citationRepairResultToReport(NEEDS_REVIEW_RESULT);

    expect(report.verdict).toBe("pass");
    expect(report.confidence).toBe(0.82);
    expect(report.stoppedBeforeMutation).toBe(true);
    expect(report.mutationMode).toBe("read_only");
    expect(report.completedPath.length).toBeGreaterThan(0);
    expect(report.blockers).toEqual([]);
    expect(report.recommendations).toContain("Verify the archived copy matches the original source.");

    const evidence = report.evidence.join("\n");
    expect(evidence).toContain("dead-link citations: 2");
    expect(evidence).toContain("total citations: 12");
    expect(evidence).toContain("flagged citations: 3");
    expect(evidence).toContain("validated before claim: yes");
    expect(evidence).toContain("invalid-wrapper probe: rejected (good)");
    // The proposal preview is the review surface — it must survive the mapping.
    expect(evidence).toContain("Founded in 1999 [1]");
    expect(evidence).toContain("https://archive.example/1999");
  });

  it("maps blocked → fail with a non-empty blocker reason", () => {
    const report = citationRepairResultToReport(BLOCKED_RESULT);

    expect(report.verdict).toBe("fail");
    expect(report.completedPath).toEqual([]);
    expect(report.blockers[0]).toContain("schema mismatch");
    expect(report.stoppedBeforeMutation).toBe(true);
  });

  it("clamps an out-of-range confidence into 0..1", () => {
    expect(citationRepairResultToReport({ status: "needs_review", confidence: 9 }).confidence).toBe(1);
    expect(citationRepairResultToReport({ status: "needs_review", confidence: -3 }).confidence).toBe(0);
    expect(citationRepairResultToReport({ status: "needs_review" }).confidence).toBe(0);
  });
});

describe("executeCitationRepairMission", () => {
  function mission(over: Partial<TestbedMissionRun> = {}): TestbedMissionRun {
    return { id: "m1", mode: "citation_repair", jobId: "job-42", ...over } as TestbedMissionRun;
  }

  it("forces dryRun:true and passes the mission jobId to the workflow", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runWorkflow = (async (input: Record<string, unknown>) => {
      calls.push(input);
      return NEEDS_REVIEW_RESULT;
    }) as never;

    const result = await executeCitationRepairMission(mission(), config, {
      runWorkflow,
      workflowDeps: {} as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].dryRun).toBe(true);
    expect(calls[0].jobId).toBe("job-42");
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.reportText ?? "{}");
    expect(payload.kind).toBe("testbed_mission_report");
    expect(payload.report.verdict).toBe("pass");
  });

  it("still forces dryRun:true even when the mission carries no jobId", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runWorkflow = (async (input: Record<string, unknown>) => {
      calls.push(input);
      return NEEDS_REVIEW_RESULT;
    }) as never;

    await executeCitationRepairMission(mission({ jobId: undefined }), config, {
      runWorkflow,
      workflowDeps: {} as never,
    });

    expect(calls[0].dryRun).toBe(true);
    expect(calls[0]).not.toHaveProperty("jobId");
  });

  it("turns a workflow throw into a fail report rather than crashing the runner", async () => {
    const runWorkflow = (async () => {
      throw new Error("workflow exploded");
    }) as never;

    const result = await executeCitationRepairMission(mission(), config, {
      runWorkflow,
      workflowDeps: {} as never,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.reportText ?? "{}");
    expect(payload.report.verdict).toBe("fail");
    expect(payload.report.blockers.join(" ")).toContain("workflow exploded");
  });
});

describe("citation_repair board round-trip (request → approve → report)", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    __resetTestbedMissionRunsForTests();
    dir = mkdtempSync(join(tmpdir(), "averray-citation-mission-"));
    path = join(dir, "missions.json");
  });

  afterEach(() => {
    __resetTestbedMissionRunsForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("carries mode + jobId through request/approve and ingests the dry-run report as a card", async () => {
    const created = createMonitorTestbedMissionFromPayload(
      {
        path,
        mode: "citation_repair",
        jobId: "job-42",
        initialStatus: "requested",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(created.run).toMatchObject({
      mode: "citation_repair",
      jobId: "job-42",
      status: "requested",
    });

    const approved = approveRequestedTestbedMission(created.run.id, {
      path,
      approvedBy: "operator",
      now: new Date("2026-05-25T10:03:00.000Z"),
    });
    expect(approved.ok).toBe(true);
    expect(approved.run).toMatchObject({ status: "ready", mode: "citation_repair", jobId: "job-42" });

    // Runner branch: run the workflow (faked) and produce the report text.
    const runResult = await executeCitationRepairMission(
      approved.run as unknown as TestbedMissionRun,
      config,
      {
        runWorkflow: (async () => NEEDS_REVIEW_RESULT) as never,
        workflowDeps: {} as never,
      }
    );

    recordTestbedMissionReportFromMessage(
      { path, relatedCorrelationId: created.run.id, text: runResult.reportText ?? "" },
      Date.parse("2026-05-25T10:07:00.000Z")
    );

    const detail = getTestbedMissionForAgent(created.run.id, { path });
    expect(detail).toMatchObject({
      status: "completed",
      report: { verdict: "OK" },
    });
  });
});
