import { describe, expect, it } from "vitest";

import {
  getDailyOperatorBrief,
  getOperatorStatus,
  getSafeWorkReport,
} from "../../packages/averray-mcp/src/operator-status.js";
import { getBusinessLedger, getOpsHealth } from "../../packages/averray-mcp/src/operator-insights.js";
import { getAgentUsefulnessPlan } from "../../packages/averray-mcp/src/operator-usefulness.js";
import { getAdminReadiness } from "../../packages/averray-mcp/src/operator-admin.js";
import { getProjectMemory } from "../../packages/averray-mcp/src/operator-project-memory.js";
import { getProjectRunbook } from "../../packages/averray-mcp/src/operator-project-runbook.js";
import { getTestbedE2eSuite, runTestbedE2eReadOnly } from "../../packages/averray-mcp/src/operator-testbed.js";

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

  it("returns daily brief and safe work views without mutating", async () => {
    const deps = {
      now: new Date("2026-05-03T12:00:00.000Z"),
      policyConfig: {
        budget: { per_run_usd_max: 0.5, per_day_usd_max: 1, max_browser_steps: 80 },
      },
      async query(text: string) {
        if (text.includes("from budgets")) return [{ usd_spent: "0" }];
        if (text.includes("from submissions")) return [];
        if (text.includes("from draft_submissions")) return [];
        return [];
      },
      workflowDeps: {
        async walletStatus() {
          return { configured: true, address: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05" };
        },
        async listJobs() {
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
          ];
        },
        async getDefinition() {
          return {
            source: { type: "wikipedia_article", taskType: "citation_repair", pageTitle: "(+ +)", revisionId: "1351905437" },
            publicDetails: { title: "Wikipedia citation repair: (+ +)" },
            state: "open",
            claimStatus: { claimable: true },
          };
        },
        async policyCheckClaim() {
          return { allowed: true };
        },
        async claim() {
          throw new Error("read-only testbed run must not claim");
        },
        async fetchEvidence() {
          return {
            pageTitle: "(+ +)",
            revisionId: "1351905437",
            revisionUrl: "https://en.wikipedia.org/w/index.php?title=%28%2B_%2B%29&oldid=1351905437",
            citations: [
              {
                index: 1,
                referenceId: "review",
                templateNames: ["cite web"],
                urls: ["https://dead.example/review"],
                archiveUrls: ["https://web.archive.org/web/20200101000000/https://dead.example/review"],
                deadLinkMarkers: ["url_status_dead"],
                accessDates: ["2020-01-02"],
                title: "Review",
                context: "A review citation with a dead source.",
              },
            ],
            sourceChecks: [
              {
                url: "https://dead.example/review",
                status: 404,
                ok: false,
                finalUrl: "https://dead.example/review",
                archiveUrl: "https://web.archive.org/web/20200101000000/https://dead.example/review",
              },
            ],
          };
        },
        async saveDraft() {
          throw new Error("read-only testbed run must not save drafts");
        },
        async validateDirectSubmission() {
          return { valid: true, validator: "permissive", taskType: "citation_repair" };
        },
        async probeInvalidWrapperSubmission() {
          return { valid: false, validator: "permissive" };
        },
        async validate() {
          return { valid: true, validator: "wikipedia", taskType: "citation_repair" };
        },
        async submit() {
          throw new Error("read-only testbed run must not submit");
        },
      },
    };

    const brief = await getDailyOperatorBrief(deps);
    expect(brief).toMatchObject({
      kind: "daily_operator_brief",
      mutates: false,
      readiness: {
        wallet: "ready",
        budget: "ready",
        wikipediaCitationRepair: "ready",
      },
      openWikipediaCitationRepairJobs: 1,
    });
    expect(brief.suggestedCommands).toContain("find safe work");

    const safeWork = await getSafeWorkReport(deps);
    expect(safeWork).toMatchObject({
      kind: "find_safe_work",
      mutates: false,
      available: true,
      blockers: [],
      recommendedCommand: "run one wikipedia citation repair dry run only",
    });
    expect(safeWork.safeWorkItems[0]).toMatchObject({
      workflow: "wikipedia_citation_repair",
      dryRunCommand: "run wikipedia citation repair for wiki-en-58158792-citation-repair-r8 if safe, dry run only",
      mutates: false,
    });

    const usefulness = await getAgentUsefulnessPlan(deps);
    expect(usefulness).toMatchObject({
      kind: "agent_usefulness_plan",
      mutates: false,
      immediate: {
        safeWorkAvailable: true,
        recommendedCommand: "run one wikipedia citation repair dry run only",
      },
      surfaces: {
        mcp: {
          status: "enabled",
        },
      },
    });
    expect(usefulness.useCases.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "slack_work_assistant",
      "mobile_agent",
      "github_helper",
      "project_admin_copilot",
      "ops_caretaker",
      "averray_business_agent",
      "knowledge_memory",
    ]));
    expect(usefulness.useCases.find((entry) => entry.id === "ops_caretaker")).toMatchObject({
      status: "enabled",
      commands: expect.arrayContaining(["ops health"]),
    });
    expect(usefulness.safety.mutatesByDefault).toBe(false);

    const admin = await getAdminReadiness(deps);
    expect(admin).toMatchObject({
      kind: "admin_readiness",
      mutates: false,
      currentRole: {
        level: "operator_copilot",
        canAdministerAutomatically: false,
      },
      readiness: {
        overall: "ready_but_low_activity",
        walletReady: true,
      },
      safety: {
        projectAdminEnabled: false,
        broadAdminDeniedByDefault: true,
      },
    });
    expect(admin.adminLadder.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "Observe and brief",
      "Approval-gated execution",
      "Scoped project admin",
    ]));
    expect(admin.shouldNotDoYet).toEqual(expect.arrayContaining([
      expect.stringContaining("Merge PRs"),
      expect.stringContaining("Change DNS"),
    ]));

    const memory = getProjectMemory({ query: "how do we deploy averray-agent/agent?" });
    expect(memory).toMatchObject({
      kind: "project_admin_memory",
      mutates: false,
      selectedProject: {
        id: "averray-platform",
        repos: ["averray-agent/agent"],
        deploy: {
          workflow: "Deploy Production",
          postDeployVerification: "Hermes post-deploy read-only testbed suite",
        },
      },
      safety: {
        readOnly: true,
        secretsIncluded: false,
        autoAdminEnabled: false,
      },
    });
    expect(memory.commands).toContain("how do we deploy averray-agent/agent");

    const runbook = getProjectRunbook({ query: "runbook for deploy averray-agent/agent" });
    expect(runbook).toMatchObject({
      kind: "project_admin_runbook",
      mutates: false,
      action: "deploy",
      target: {
        project: "averray-platform",
        repos: ["averray-agent/agent"],
      },
      safety: {
        readOnly: true,
        approvalRequired: true,
        mutates: false,
      },
    });
    expect(runbook.runbook.requiredEvidence).toEqual(expect.arrayContaining([
      expect.stringContaining("CI is green"),
    ]));
    expect(runbook.suggestedHermesCommands).toEqual(expect.arrayContaining([
      "run testbed e2e read-only",
    ]));

    const suite = await getTestbedE2eSuite({
      ...deps,
      env: {
        GITHUB_TOKEN: "ghp_readonly",
        GITHUB_HELPER_REPOS: "depre-dev/averray-reference-agent",
      },
    });
    expect(suite).toMatchObject({
      kind: "testbed_e2e_suite",
      mutates: false,
      readiness: {
        overall: "ready",
        canRunReadOnly: true,
        canRunDryRun: true,
        canRunGuardedLive: true,
      },
      context: {
        githubConfigured: true,
        openWikipediaCitationRepairJobs: 1,
      },
      safety: {
        suiteGeneratorMutates: false,
        guardedLiveCaseMutates: true,
        githubBriefWritesLocalCheckpoint: true,
        editsWikipedia: false,
      },
    });
    expect(suite.testCases.map((entry) => entry.id)).toEqual([
      "TBE2E-001",
      "TBE2E-002",
      "TBE2E-003",
      "TBE2E-004",
      "TBE2E-005",
      "TBE2E-006",
      "TBE2E-007",
      "TBE2E-008",
      "TBE2E-009",
      "TBE2E-010",
      "TBE2E-011",
    ]);
    expect(suite.testCases.find((entry) => entry.id === "TBE2E-005")).toMatchObject({
      status: "manual",
      mutates: true,
      mutationScope: "averray_claim_draft_validate_submit_only",
    });
    expect(suite.testCases.find((entry) => entry.id === "TBE2E-010")).toMatchObject({
      status: "ready",
      mutates: true,
      mutationScope: "local_brief_checkpoint_only",
    });

    const run = await runTestbedE2eReadOnly({
      ...deps,
      env: {},
    });
    expect(run).toMatchObject({
      kind: "testbed_e2e_read_only_run",
      mutates: false,
      status: "passed",
      summary: {
        totalCases: 11,
        executed: 8,
        passed: 8,
        failed: 0,
        skipped: 3,
      },
      safety: {
        skippedGuardedLiveWorkflow: true,
        skippedGithubBriefCheckpoint: true,
        skippedManualSurfaceParity: true,
        editsWikipedia: false,
      },
    });
    expect(run.cases.find((entry) => entry.id === "TBE2E-004")).toMatchObject({
      status: "passed",
      mutates: false,
      evidence: {
        validation: "valid",
        proposedFindings: 1,
      },
    });
    expect(run.cases.find((entry) => entry.id === "TBE2E-005")).toMatchObject({
      status: "skipped",
      reason: "requires_explicit_mutation_command",
    });
    expect(run.cases.find((entry) => entry.id === "TBE2E-010")).toMatchObject({
      status: "skipped",
      reason: "writes_local_github_brief_checkpoint",
    });
  });

  it("returns read-only business ledger and ops health insights", async () => {
    const deps = {
      now: new Date("2026-05-03T12:00:00.000Z"),
      policyConfig: {
        budget: { per_run_usd_max: 0.5, per_day_usd_max: 1, max_browser_steps: 80 },
      },
      async query(text: string) {
        if (text.includes("last_operator_event_at")) {
          return [{
            runs: 2,
            submissions: 4,
            drafts: 5,
            operator_events: 8,
            budgets: 1,
            last_operator_event_at: "2026-05-03T11:50:00.000Z",
            last_submission_at: "2026-05-03T11:43:23.872Z",
          }];
        }
        if (text.includes("from budgets")) return [{ usd_spent: "0.10" }];
        if (text.includes("from submissions") && text.includes("left join")) {
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
        if (text.includes("from submissions") && text.includes("count(*)")) {
          return [{ total: 4, completed: 3, failed: 1, other: 0 }];
        }
        if (text.includes("from draft_submissions") && text.includes("count(*)")) {
          return [{ total: 5, completed: 4, failed: 1, other: 0 }];
        }
        if (text.includes("from operator_command_events") && text.includes("count(distinct normalized_text)")) {
          return [{ total: 8, completed: 6, failed: 0, other: 4 }];
        }
        if (text.includes("where status = 'failed'")) return [];
        if (text.includes("select normalized_text, source, status, updated_at")) {
          return [
            {
              normalized_text: "status last wikipedia citation repair",
              source: "slack",
              status: "submitted",
              updated_at: "2026-05-03T11:50:00.000Z",
            },
          ];
        }
        if (text.includes("from draft_submissions")) return [];
        return [];
      },
      workflowDeps: {
        async walletStatus() {
          return { configured: true, address: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05" };
        },
        async listJobs() {
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
          ];
        },
      },
    };

    const ledger = await getBusinessLedger(deps);
    expect(ledger).toMatchObject({
      kind: "business_ledger",
      mutates: false,
      summary: {
        openWikipediaCitationRepairJobs: 1,
        sevenDaySubmissions: { total: 4, completed: 3, failed: 1 },
        sevenDayDrafts: { total: 5, valid: 4, invalid: 1 },
        sevenDayOperatorCommands: { total: 8, slackRouted: 6, distinctCommands: 4 },
      },
    });

    const health = await getOpsHealth(deps);
    expect(health).toMatchObject({
      kind: "ops_health",
      mutates: false,
      health: "ready",
      controlPlane: {
        tables: {
          submissions: 4,
          drafts: 5,
          operatorEvents: 8,
        },
        recentErrors: [],
      },
    });
  });
});
