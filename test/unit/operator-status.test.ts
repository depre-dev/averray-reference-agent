import { describe, expect, it } from "vitest";

import { getOperatorStatus } from "../../packages/averray-mcp/src/operator-status.js";

describe("operator status", () => {
  it("returns a canonical read-only status for agents and UIs", async () => {
    const workflowCalls: string[] = [];
    const queries: string[] = [];

    const status = await getOperatorStatus({
      now: new Date("2026-05-03T12:00:00.000Z"),
      policyConfig: {
        claim: {
          allowed_task_types: ["citation_repair", "freshness_check"],
          reject_verifier_modes: ["human_fallback"],
        },
        submit: { require_approval_if_confidence_lt: 0.7 },
        budget: { per_run_usd_max: 0.5, per_day_usd_max: 1, max_browser_steps: 80 },
      },
      async query(text) {
        queries.push(text);
        if (text.includes("from budgets")) return [{ usd_spent: "0.25" }];
        if (text.includes("from submissions")) {
          return [
            {
              request: {
                policyRunId: "wikipedia-citation-repair-run-1",
                jobId: "wiki-en-58158792-citation-repair-r7",
                sessionId: "wiki-en-58158792-citation-repair-r7:0xWallet",
                draftId: "draft-1",
              },
              response: { state: "submitted" },
              status: "completed",
              updated_at: "2026-05-03T11:43:23.872Z",
              draft_validation_status: "valid",
            },
          ];
        }
        return [];
      },
      workflowDeps: {
        async walletStatus() {
          workflowCalls.push("walletStatus");
          return { configured: true, address: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05" };
        },
        async listJobs() {
          workflowCalls.push("listJobs");
          return [
            {
              jobId: "wiki-en-58158792-citation-repair-r8",
              definition: {
                source: { type: "wikipedia_article", taskType: "citation_repair", pageTitle: "(+ +)", revisionId: "1351905437" },
                publicDetails: { title: "Wikipedia citation repair: (+ +)" },
                state: "open",
                claimStatus: { claimable: true },
              },
            },
            {
              jobId: "starter-coding-001",
              definition: { source: { type: "github_issue", taskType: "coding" }, state: "open" },
            },
          ];
        },
      },
    });

    expect(status).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-05-03T12:00:00.000Z",
      mutates: false,
      agent: {
        walletReady: true,
        walletAddress: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
        network: "testnet",
      },
      policy: {
        claimAllowedTaskTypes: ["citation_repair", "freshness_check"],
        submitConfidenceThreshold: 0.7,
        budget: {
          perRunUsdMax: 0.5,
          perDayUsdMax: 1,
          maxBrowserSteps: 80,
          todayUsdSpent: 0.25,
          todayUsdRemaining: 0.75,
        },
      },
      workflows: {
        wikipediaCitationRepair: {
          ready: true,
          openJobs: 1,
          discoveredJobs: 1,
          latestRun: {
            found: true,
            runId: "wikipedia-citation-repair-run-1",
            status: "submitted",
            draftId: "draft-1",
          },
        },
      },
      safety: {
        mutatesByDefault: false,
        statusCommandsAreReadOnly: true,
        repairWorkflowRequiresValidationBeforeSubmit: true,
        editsWikipedia: false,
      },
    });
    expect(status.workflows.wikipediaCitationRepair.safeCommands).toContain("operator status");
    expect(status.workflows.wikipediaCitationRepair.candidateJobs[0]).toMatchObject({
      jobId: "wiki-en-58158792-citation-repair-r8",
      title: "Wikipedia citation repair: (+ +)",
      claimable: true,
      pageTitle: "(+ +)",
      revisionId: "1351905437",
    });
    expect(workflowCalls.sort()).toEqual(["listJobs", "walletStatus"]);
    expect(queries.every((text) => text.trim().toLowerCase().startsWith("select"))).toBe(true);
  });

  it("fails closed to read-only guidance when wallet or jobs are unavailable", async () => {
    const status = await getOperatorStatus({
      now: new Date("2026-05-03T12:00:00.000Z"),
      policyConfig: {},
      async query() {
        throw new Error("db unavailable");
      },
      workflowDeps: {
        async walletStatus() {
          throw new Error("wallet unavailable");
        },
        async listJobs() {
          throw new Error("jobs unavailable");
        },
      },
    });

    expect(status.mutates).toBe(false);
    expect(status.agent.walletReady).toBe(false);
    expect(status.workflows.wikipediaCitationRepair.ready).toBe(false);
    expect(status.recommendedNextActions[0]).toContain("Configure the agent wallet");
    expect(status.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("wallet_status_failed"),
      expect.stringContaining("list_jobs_failed"),
      expect.stringContaining("budget_query_failed"),
      expect.stringContaining("latest_run_failed"),
    ]));
  });
});
