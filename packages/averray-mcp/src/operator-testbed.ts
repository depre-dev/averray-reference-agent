import type { OperatorStatusDeps } from "./operator-status.js";
import { getOperatorStatus, getSafeWorkReport } from "./operator-status.js";

export interface TestbedE2eSuiteDeps extends OperatorStatusDeps {
  env?: Record<string, string | undefined>;
}

export async function getTestbedE2eSuite(deps: TestbedE2eSuiteDeps) {
  const [status, safeWork] = await Promise.all([
    getOperatorStatus(deps),
    getSafeWorkReport(deps),
  ]);
  const env = deps.env ?? process.env;
  const githubConfigured = hasAny(env, ["GITHUB_TOKEN", "GITHUB_OWNER_TOKENS", "GITHUB_REPO_TOKENS"])
    && hasAny(env, ["GITHUB_DEFAULT_REPO", "GITHUB_HELPER_REPOS"]);

  const budgetRemaining = status.policy.budget.todayUsdRemaining;
  const blockers = [
    ...(status.agent.walletReady ? [] : ["wallet_not_ready"]),
    ...(budgetRemaining > 0 ? [] : ["budget_depleted"]),
    ...(status.workflows.wikipediaCitationRepair.openJobs > 0 ? [] : ["no_open_wikipedia_citation_repair_jobs"]),
  ];
  const warnings = [
    ...(githubConfigured ? [] : ["github_helper_not_fully_configured"]),
    ...(status.errors ?? []).map((entry) => `operator_status_warning:${entry}`),
    ...(safeWork.errors ?? []).map((entry) => `safe_work_warning:${entry}`),
  ];
  const canRunDryRun = status.agent.walletReady && status.workflows.wikipediaCitationRepair.openJobs > 0;
  const canRunGuardedLive = blockers.length === 0;

  return {
    schemaVersion: 1,
    kind: "testbed_e2e_suite",
    generatedAt: status.generatedAt,
    mutates: false,
    headline: canRunDryRun
      ? "Platform testbed is ready for read-only and dry-run E2E checks."
      : "Platform testbed can run read-only checks, but workflow E2E has blockers.",
    readiness: {
      overall: blockers.length === 0 ? "ready" : "blocked",
      canRunReadOnly: true,
      canRunDryRun,
      canRunGuardedLive,
      blockers,
      warnings,
    },
    context: {
      wallet: {
        ready: status.agent.walletReady,
        address: status.agent.walletAddress,
        network: status.agent.network,
      },
      budget: status.policy.budget,
      openWikipediaCitationRepairJobs: status.workflows.wikipediaCitationRepair.openJobs,
      latestWikipediaCitationRepair: status.workflows.wikipediaCitationRepair.latestRun,
      githubConfigured,
    },
    recommendedRunOrder: [
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
    ],
    testCases: [
      testCase({
        id: "TBE2E-001",
        phase: "readiness",
        name: "Operator readiness",
        command: "operator status",
        mcpTool: "averray_operator_status",
        status: "ready",
        expectedEvidence: ["wallet readiness", "budget state", "open job count", "latest run summary"],
        successCriteria: ["response mutates=false", "safe commands are present", "no broad admin permissions are implied"],
      }),
      testCase({
        id: "TBE2E-002",
        phase: "briefing",
        name: "Daily operator brief",
        command: "daily operator brief",
        mcpTool: "averray_daily_operator_brief",
        status: "ready",
        expectedEvidence: ["readiness headline", "recommended next action", "candidate jobs if available"],
        successCriteria: ["brief is read-only", "operators can decide dry-run vs live workflow"],
      }),
      testCase({
        id: "TBE2E-003",
        phase: "discovery",
        name: "Safe work discovery",
        command: "find safe work",
        mcpTool: "averray_find_safe_work",
        status: safeWork.available ? "ready" : "blocked",
        blockers: safeWork.blockers,
        expectedEvidence: ["available flag", "dry-run command", "guarded mutation command"],
        successCriteria: ["no claim or submit attempted", "each work item exposes the exact dry-run command"],
      }),
      testCase({
        id: "TBE2E-004",
        phase: "dry_run",
        name: "Wikipedia citation repair dry run",
        command: "run one wikipedia citation repair dry run only",
        mcpTool: "averray_run_wikipedia_citation_repair",
        status: canRunDryRun ? "ready" : "blocked",
        blockers: canRunDryRun ? [] : blockers,
        expectedEvidence: ["selected job", "read-only source checks", "draft/proposal summary", "validation result"],
        successCriteria: ["dryRun=true", "no claim", "no submit", "no Wikipedia edit"],
      }),
      testCase({
        id: "TBE2E-005",
        phase: "guarded_mutation",
        name: "Guarded live Wikipedia citation repair",
        command: "run one wikipedia citation repair if safe",
        mcpTool: "averray_run_wikipedia_citation_repair",
        status: canRunGuardedLive ? "manual" : "blocked",
        blockers: canRunGuardedLive ? [] : blockers,
        mutates: true,
        mutationScope: "averray_claim_draft_validate_submit_only",
        expectedEvidence: ["claim policy pass", "draftId", "validation pass", "submit or confidence-held report"],
        successCriteria: ["explicit command only", "draft saved before validation", "submit only if validation passes and confidence threshold is met"],
      }),
      testCase({
        id: "TBE2E-006",
        phase: "verification",
        name: "Latest workflow status verification",
        command: "status last wikipedia citation repair details",
        mcpTool: "averray_status_last_wikipedia_citation_repair",
        status: "ready",
        expectedEvidence: ["runId", "jobId", "sessionId", "draftId", "submit_succeeded flag"],
        successCriteria: ["status is read-only", "submitted, failed, or held state is explicit"],
      }),
      testCase({
        id: "TBE2E-007",
        phase: "business",
        name: "Business ledger",
        command: "business ledger",
        mcpTool: "averray_business_ledger",
        status: "ready",
        expectedEvidence: ["recent submissions", "draft counts", "budget snapshot", "operator activity"],
        successCriteria: ["ledger is read-only", "latest run and open work agree with operator status"],
      }),
      testCase({
        id: "TBE2E-008",
        phase: "ops",
        name: "Control-plane ops health",
        command: "ops health",
        mcpTool: "averray_ops_health",
        status: "ready",
        expectedEvidence: ["wallet/budget", "table counts", "recent errors", "recent operator events"],
        successCriteria: ["recent errors are reported clearly", "host-level checks are identified as outside MCP if needed"],
      }),
      testCase({
        id: "TBE2E-009",
        phase: "github",
        name: "GitHub repo status",
        command: "github status",
        mcpTool: "averray_github_status",
        status: githubConfigured ? "ready" : "optional",
        blockers: githubConfigured ? [] : ["github_env_missing_or_partial"],
        expectedEvidence: ["open PRs", "open issues", "CI failures", "active workflow runs"],
        successCriteria: ["GitHub is read-only", "no PR merge, issue edit, or workflow rerun is attempted"],
      }),
      testCase({
        id: "TBE2E-010",
        phase: "github",
        name: "GitHub delta brief",
        command: "github brief",
        mcpTool: "averray_github_brief",
        status: githubConfigured ? "ready" : "optional",
        blockers: githubConfigured ? [] : ["github_env_missing_or_partial"],
        mutates: true,
        mutationScope: "local_brief_checkpoint_only",
        expectedEvidence: ["what changed", "what merged", "what deployed", "what failed", "what needs attention"],
        successCriteria: ["GitHub is not mutated", "local checkpoint behavior is disclosed"],
      }),
      testCase({
        id: "TBE2E-011",
        phase: "surface_parity",
        name: "Surface parity smoke",
        command: "operator status",
        mcpTool: "averray_handle_operator_command",
        status: "manual",
        expectedEvidence: ["same command works through MCP", "same command works through Slack", "same command works through Command Center"],
        successCriteria: ["outputs agree on wallet, budget, open jobs, and latest run", "Slack may compact IDs but details mode exposes full audit IDs"],
      }),
    ],
    safety: {
      suiteGeneratorMutates: false,
      readOnlyExternalSystemsMutated: false,
      githubBriefWritesLocalCheckpoint: true,
      guardedLiveCaseMutates: true,
      editsWikipedia: false,
      requiresExplicitMutationCommand: true,
      validationRequiredBeforeSubmit: true,
      confidenceThreshold: status.policy.submitConfidenceThreshold,
    },
    nextCommands: {
      readOnly: "testbed e2e suite",
      dryRun: "run one wikipedia citation repair dry run only",
      guardedLive: "run one wikipedia citation repair if safe",
      verify: "status last wikipedia citation repair details",
    },
  };
}

function testCase(input: {
  id: string;
  phase: string;
  name: string;
  command: string;
  mcpTool: string;
  status: "ready" | "blocked" | "optional" | "manual";
  mutates?: boolean;
  mutationScope?: string;
  blockers?: string[];
  expectedEvidence: string[];
  successCriteria: string[];
}) {
  return {
    id: input.id,
    phase: input.phase,
    name: input.name,
    status: input.status,
    mutates: input.mutates === true,
    ...(input.mutationScope ? { mutationScope: input.mutationScope } : {}),
    ...(input.blockers && input.blockers.length > 0 ? { blockers: input.blockers } : {}),
    surfaces: {
      mcpTool: input.mcpTool,
      operatorCommand: input.command,
      slackExample: `@Averray Reference Agent ${input.command}`,
      commandCenterPrompt: input.command,
    },
    expectedEvidence: input.expectedEvidence,
    successCriteria: input.successCriteria,
  };
}

function hasAny(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => typeof env[key] === "string" && env[key]!.trim().length > 0);
}
