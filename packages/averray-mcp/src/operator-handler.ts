import type { WorkflowDeps } from "./job-workflows.js";
import {
  getLastWikipediaCitationRepairStatus,
  parseOperatorCommand,
  type OperatorCommandSource,
  type OperatorQueryFn,
} from "./operator-commands.js";
import { getOperatorStatus } from "./operator-status.js";
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
  const result = await runWikipediaCitationRepairWorkflow(
    { ...command.input, expectedWallet: input.expectedWallet },
    deps.workflowDeps
  );
  return { ...command, result };
}
