import { optionalEnv, readYamlFile } from "@avg/mcp-common";
import type { WorkflowDeps, WorkflowJob, WorkflowWallet } from "./job-workflows.js";
import {
  getLastWikipediaCitationRepairStatus,
  type LastWikipediaCitationRepairStatus,
  type OperatorQueryFn,
} from "./operator-commands.js";

export interface OperatorStatusDeps {
  query: OperatorQueryFn;
  workflowDeps: Pick<WorkflowDeps, "listJobs" | "walletStatus">;
  now?: Date;
  policyConfig?: OperatorPolicyConfig;
}

export interface OperatorPolicyConfig {
  claim?: {
    allowed_task_types?: string[];
    reject_verifier_modes?: string[];
    min_reward_usd?: number;
  };
  submit?: {
    require_approval_if_confidence_lt?: number;
  };
  budget?: {
    per_run_usd_max?: number;
    per_day_usd_max?: number;
    max_browser_steps?: number;
  };
}

const defaultPolicyConfig: OperatorPolicyConfig = {
  claim: {
    allowed_task_types: ["citation_repair", "freshness_check"],
    reject_verifier_modes: ["human_fallback"],
    min_reward_usd: 0,
  },
  submit: {
    require_approval_if_confidence_lt: 0.7,
  },
  budget: {
    per_run_usd_max: 0.5,
    per_day_usd_max: 1,
    max_browser_steps: 80,
  },
};

export async function getOperatorStatus(deps: OperatorStatusDeps) {
  const generatedAt = (deps.now ?? new Date()).toISOString();
  const policyConfig = deps.policyConfig ?? loadPolicyConfig();
  const errors: string[] = [];
  const [wallet, budget, jobs, latestRun] = await Promise.all([
    deps.workflowDeps.walletStatus().catch((error) => {
      errors.push(`wallet_status_failed:${errorMessage(error)}`);
      return { configured: false, address: null } satisfies WorkflowWallet;
    }),
    readBudget(deps.query, policyConfig, errors),
    deps.workflowDeps.listJobs().catch((error) => {
      errors.push(`list_jobs_failed:${errorMessage(error)}`);
      return [] as WorkflowJob[];
    }),
    getLastWikipediaCitationRepairStatus(deps.query).catch((error) => {
      errors.push(`latest_run_failed:${errorMessage(error)}`);
      return { found: false, source: "none", submitSucceeded: false, slackPermalink: null } satisfies LastWikipediaCitationRepairStatus;
    }),
  ]);
  const wikipediaJobs = jobs.filter(isWikipediaCitationRepairJob);
  const claimableJobs = wikipediaJobs.filter(isOpenOrClaimableJob);

  return {
    schemaVersion: 1,
    generatedAt,
    mutates: false,
    agent: {
      walletReady: wallet.configured,
      walletAddress: wallet.address,
      network: optionalEnv("WALLET_NETWORK", "testnet"),
    },
    policy: {
      claimAllowedTaskTypes: policyConfig.claim?.allowed_task_types ?? [],
      rejectVerifierModes: policyConfig.claim?.reject_verifier_modes ?? [],
      submitConfidenceThreshold: policyConfig.submit?.require_approval_if_confidence_lt ?? 0.7,
      budget,
    },
    workflows: {
      wikipediaCitationRepair: {
        ready: wallet.configured && claimableJobs.length > 0,
        openJobs: claimableJobs.length,
        discoveredJobs: wikipediaJobs.length,
        latestRun,
        candidateJobs: claimableJobs.slice(0, 5).map(compactJob),
        safeCommands: [
          "operator status",
          "status last wikipedia citation repair",
          "run one wikipedia citation repair dry run only",
          "run one wikipedia citation repair if safe",
        ],
      },
    },
    safety: {
      mutatesByDefault: false,
      statusCommandsAreReadOnly: true,
      repairWorkflowDryRunDefault: true,
      repairWorkflowRequiresValidationBeforeSubmit: true,
      persistsDraftBeforeSubmit: true,
      editsWikipedia: false,
      mutationCommandsRequireExplicitIntent: true,
    },
    surfaces: {
      slack: {
        role: "durable audit and operator command channel",
        mentionExample: "@Averray Reference Agent operator status",
      },
      commandCenter: {
        role: "inspection, dry-run preview, and guided execution UI",
        promptExample: "operator status",
      },
      mcp: {
        role: "canonical agent-facing structured status contract",
        tool: "averray_operator_status",
      },
    },
    recommendedNextActions: recommendedNextActions(wallet, claimableJobs.length, latestRun),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function getDailyOperatorBrief(deps: OperatorStatusDeps) {
  const status = await getOperatorStatus(deps);
  const wikipedia = status.workflows.wikipediaCitationRepair;
  const latestRun = wikipedia.latestRun;
  const budget = status.policy.budget;
  return {
    schemaVersion: 1,
    kind: "daily_operator_brief",
    generatedAt: status.generatedAt,
    mutates: false,
    headline: dailyBriefHeadline(status.agent.walletReady, wikipedia.openJobs, latestRun),
    readiness: {
      wallet: status.agent.walletReady ? "ready" : "not_ready",
      budget: budget.todayUsdRemaining > 0 ? "ready" : "depleted",
      wikipediaCitationRepair: wikipedia.ready ? "ready" : "not_ready",
    },
    wallet: {
      ready: status.agent.walletReady,
      address: status.agent.walletAddress,
      network: status.agent.network,
    },
    budget: {
      todayUsdSpent: budget.todayUsdSpent,
      todayUsdRemaining: budget.todayUsdRemaining,
      perRunUsdMax: budget.perRunUsdMax,
      perDayUsdMax: budget.perDayUsdMax,
    },
    latestWikipediaCitationRepair: latestRun,
    openWikipediaCitationRepairJobs: wikipedia.openJobs,
    candidateJobs: wikipedia.candidateJobs.slice(0, 3),
    recommendedNextActions: status.recommendedNextActions,
    suggestedCommands: [
      "find safe work",
      "run one wikipedia citation repair dry run only",
      "run one wikipedia citation repair if safe",
      "status last wikipedia citation repair",
    ],
    safety: {
      mutatesByDefault: false,
      statusCommandsAreReadOnly: true,
      editsWikipedia: false,
    },
    ...(status.errors ? { errors: status.errors } : {}),
  };
}

export async function getSafeWorkReport(deps: OperatorStatusDeps) {
  const status = await getOperatorStatus(deps);
  const wikipedia = status.workflows.wikipediaCitationRepair;
  const budget = status.policy.budget;
  const blockers = safeWorkBlockers(status.agent.walletReady, budget.todayUsdRemaining, wikipedia.openJobs);
  const available = blockers.length === 0;
  return {
    schemaVersion: 1,
    kind: "find_safe_work",
    generatedAt: status.generatedAt,
    mutates: false,
    available,
    blockers,
    recommendedCommand: available
      ? "run one wikipedia citation repair dry run only"
      : "operator status",
    nextMutationCommand: available
      ? "run one wikipedia citation repair if safe"
      : null,
    safeWorkItems: wikipedia.candidateJobs.slice(0, 5).map((job, index) => ({
      rank: index + 1,
      workflow: "wikipedia_citation_repair",
      job,
      dryRunCommand: job.jobId
        ? `run wikipedia citation repair for ${job.jobId} if safe, dry run only`
        : "run one wikipedia citation repair dry run only",
      mutationCommand: job.jobId
        ? `run wikipedia citation repair for ${job.jobId} if safe`
        : "run one wikipedia citation repair if safe",
      mutates: false,
      note: "Start with the dry run. Submit still requires validation and confidence >= threshold.",
    })),
    latestWikipediaCitationRepair: wikipedia.latestRun,
    safety: {
      dryRunMutates: false,
      mutationRequiresExplicitCommand: true,
      validatesBeforeSubmit: true,
      editsWikipedia: false,
    },
    ...(status.errors ? { errors: status.errors } : {}),
  };
}

function loadPolicyConfig(): OperatorPolicyConfig {
  return readYamlFile(optionalEnv("POLICY_CONFIG_PATH", "/config/policy.yaml"), defaultPolicyConfig);
}

async function readBudget(query: OperatorQueryFn, policyConfig: OperatorPolicyConfig, errors: string[]) {
  const config = policyConfig.budget ?? defaultPolicyConfig.budget ?? {};
  const rows = await query<{ usd_spent?: string | number }>("select usd_spent from budgets where date = current_date")
    .catch((error) => {
      errors.push(`budget_query_failed:${errorMessage(error)}`);
      return [];
    });
  const todayUsdSpent = Number(rows[0]?.usd_spent ?? 0);
  const perDayUsdMax = config.per_day_usd_max ?? 1;
  return {
    perRunUsdMax: config.per_run_usd_max ?? 0.5,
    perDayUsdMax,
    maxBrowserSteps: config.max_browser_steps ?? 80,
    todayUsdSpent,
    todayUsdRemaining: Math.max(0, perDayUsdMax - todayUsdSpent),
  };
}

function isWikipediaCitationRepairJob(job: WorkflowJob): boolean {
  const definition = toRecord(job.definition);
  const source = toRecord(definition.source);
  const publicDetails = toRecord(definition.publicDetails);
  const agentContext = toRecord(definition.agentContext);
  const taskType = stringField(agentContext, "taskType") ?? stringField(source, "taskType") ?? stringField(publicDetails, "taskType");
  const sourceType = stringField(source, "type") ?? stringField(publicDetails, "source") ?? stringField(definition, "source");
  return (
    job.jobId.includes("wiki-en-") &&
    job.jobId.includes("citation-repair")
  ) || (
    taskType === "citation_repair" &&
    (sourceType === "wikipedia_article" || sourceType === "wikipedia")
  );
}

function isOpenOrClaimableJob(job: WorkflowJob): boolean {
  const definition = toRecord(job.definition);
  const claimStatus = toRecord(definition.claimStatus);
  const lifecycle = toRecord(definition.lifecycle);
  const claimable = booleanField(claimStatus, "claimable") ?? booleanField(definition, "claimable");
  if (claimable === true) return true;
  if (claimable === false) return false;
  const state = stringField(definition, "state")
    ?? stringField(definition, "effectiveState")
    ?? stringField(definition, "claimState")
    ?? stringField(lifecycle, "state");
  return state === undefined || state === "open" || state === "claimable";
}

function compactJob(job: WorkflowJob) {
  const definition = toRecord(job.definition);
  const publicDetails = toRecord(definition.publicDetails);
  const claimStatus = toRecord(definition.claimStatus);
  const source = toRecord(definition.source);
  return {
    jobId: job.jobId,
    title: stringField(publicDetails, "title") ?? stringField(definition, "title"),
    state: stringField(definition, "state") ?? stringField(definition, "effectiveState"),
    claimable: booleanField(claimStatus, "claimable") ?? booleanField(definition, "claimable"),
    pageTitle: stringField(source, "pageTitle"),
    revisionId: stringField(source, "revisionId"),
  };
}

function recommendedNextActions(
  wallet: WorkflowWallet,
  openJobs: number,
  latestRun: LastWikipediaCitationRepairStatus
) {
  if (!wallet.configured) return ["Configure the agent wallet before attempting claim or submit workflows."];
  if (openJobs < 1) return ["No open Wikipedia citation-repair jobs are currently claimable; use read-only status commands."];
  if (latestRun.found && latestRun.status !== "submitted") {
    return [
      "Inspect the latest incomplete Wikipedia citation-repair run before starting another mutation.",
      "Use: status last wikipedia citation repair",
    ];
  }
  return [
    "Use: run one wikipedia citation repair dry run only",
    "If the dry run validates and confidence is sufficient, use: run one wikipedia citation repair if safe",
  ];
}

function dailyBriefHeadline(walletReady: boolean, openJobs: number, latestRun: LastWikipediaCitationRepairStatus): string {
  if (!walletReady) return "Wallet is not ready; keep to read-only status checks.";
  if (latestRun.found && latestRun.status && latestRun.status !== "submitted") {
    return `Latest Wikipedia citation repair is ${latestRun.status}; inspect it before starting another run.`;
  }
  if (openJobs > 0) return `${openJobs} Wikipedia citation-repair job${openJobs === 1 ? "" : "s"} available; start with a dry run.`;
  return "No claimable Wikipedia citation-repair jobs are open right now.";
}

function safeWorkBlockers(walletReady: boolean, todayUsdRemaining: number, openJobs: number): string[] {
  const blockers: string[] = [];
  if (!walletReady) blockers.push("wallet_not_ready");
  if (todayUsdRemaining <= 0) blockers.push("budget_depleted");
  if (openJobs < 1) blockers.push("no_claimable_wikipedia_citation_repair_jobs");
  return blockers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "boolean" ? field : undefined;
}
