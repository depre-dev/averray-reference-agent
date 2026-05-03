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

  it("routes the latest status command read-only", () => {
    const parsed = parseOperatorCommand("status last wikipedia citation repair.", { source: "operator" });

    expect(parsed).toEqual({
      handled: true,
      kind: "status_last_wikipedia_citation_repair",
      source: "operator",
    });
  });

  it("routes operator status and help to the canonical read-only status", () => {
    expect(parseOperatorCommand("operator status", { source: "operator" })).toEqual({
      handled: true,
      kind: "operator_status",
      source: "operator",
    });
    expect(parseOperatorCommand("help", { source: "slack" })).toEqual({
      handled: true,
      kind: "operator_status",
      source: "slack",
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
