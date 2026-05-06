import type { WorkflowDeps } from "./job-workflows.js";
import {
  getLastWikipediaCitationRepairStatus,
  parseOperatorCommand,
  type OperatorCommandSource,
  type OperatorQueryFn,
} from "./operator-commands.js";
import { getBusinessLedger, getOpsHealth } from "./operator-insights.js";
import { getDailyOperatorBrief, getOperatorStatus, getSafeWorkReport } from "./operator-status.js";
import { getAgentUsefulnessPlan } from "./operator-usefulness.js";
import { runWikipediaCitationRepairWorkflow } from "./job-workflows.js";

export interface HandleOperatorCommandInput {
  text: string;
  source?: OperatorCommandSource;
  expectedWallet?: string;
  defaultDryRun?: boolean;
  maxEvidenceUrls?: number;
  confidenceThreshold?: number;
}

export interface HandleOperatorCommandDeps {
  query: OperatorQueryFn;
  workflowDeps: WorkflowDeps;
}

export async function handleOperatorCommandText(
  input: HandleOperatorCommandInput,
  deps: HandleOperatorCommandDeps
) {
  const command = parseOperatorCommand(input.text, {
    source: input.source,
    defaultDryRun: input.defaultDryRun,
    maxEvidenceUrls: input.maxEvidenceUrls,
    confidenceThreshold: input.confidenceThreshold,
  });
  if (!command.handled) return command;
  if (command.kind === "status_last_wikipedia_citation_repair") {
    const status = await getLastWikipediaCitationRepairStatus(deps.query);
    return { ...command, status };
  }
  if (command.kind === "operator_status") {
    const status = await getOperatorStatus({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, status };
  }
  if (command.kind === "daily_operator_brief") {
    const brief = await getDailyOperatorBrief({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, brief };
  }
  if (command.kind === "find_safe_work") {
    const safeWork = await getSafeWorkReport({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, safeWork };
  }
  if (command.kind === "agent_usefulness_plan") {
    const plan = await getAgentUsefulnessPlan({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, plan };
  }
  if (command.kind === "business_ledger") {
    const ledger = await getBusinessLedger({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, ledger };
  }
  if (command.kind === "ops_health") {
    const health = await getOpsHealth({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, health };
  }
  const result = await runWikipediaCitationRepairWorkflow(
    { ...command.input, expectedWallet: input.expectedWallet },
    deps.workflowDeps
  );
  return { ...command, result };
}
