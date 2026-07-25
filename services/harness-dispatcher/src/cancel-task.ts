import {
  getAgentTask,
  putAgentTask,
} from "@avg/averray-mcp/agent-task-store";
import {
  deriveIntendedRunId,
} from "@avg/averray-mcp/dispatch-claim";
import {
  buildHermesDecisionRecordV2,
} from "@avg/averray-mcp/decision-records";
import {
  recordHermesDecision,
} from "@avg/averray-mcp/decision-record-store";
import {
  getRunBinding,
  type RunBinding,
} from "@avg/averray-mcp/run-binding-outbox";
import {
  actorRefSchema,
  agentTaskV1Schema,
  integrationTextSchema,
  type ActorRef,
  type AgentTaskV1,
  type HermesDecisionRecordV2,
} from "@avg/schemas";
import {
  HarnessReadError,
  type HarnessReadPort,
} from "@avg/averray-mcp/harness-read-port";

import {
  type AlertSink,
} from "./alerts.js";
import {
  HarnessControlError,
  type HarnessControlPort,
} from "./harness-control-port.js";

const REFUSED_TERMINAL_LIFECYCLES = new Set<AgentTaskV1["lifecycle"]>([
  "handoff_ready",
  "failed",
  "cancelled",
]);

export interface CancelAgentTaskInput {
  workItemId: string;
  taskVersion: number;
  actor: ActorRef;
  reason: string;
}

export interface CancelAgentTaskDeps {
  now?: () => Date;
  getTask?: (
    workItemId: string,
    taskVersion: number,
  ) => Promise<AgentTaskV1 | undefined>;
  saveTask?: (task: AgentTaskV1) => Promise<AgentTaskV1>;
  getRunBinding?: (workItemId: string) => Promise<RunBinding | undefined>;
  readPort: HarnessReadPort;
  controlPort: Pick<HarnessControlPort, "cancel">;
  recordDecision?: (record: HermesDecisionRecordV2) => Promise<unknown>;
  alertSink: AlertSink;
}

export async function cancelAgentTask(
  input: CancelAgentTaskInput,
  deps: CancelAgentTaskDeps,
): Promise<AgentTaskV1> {
  const actor = actorRefSchema.parse(input.actor);
  if (actor.type !== "operator") {
    throw new Error("Only an operator may cancel an AgentTask");
  }
  const operatorActor: ActorRef & { type: "operator" } = {
    ...actor,
    type: "operator",
  };
  const reason = integrationTextSchema.parse(input.reason);
  const task = await (deps.getTask ?? getAgentTask)(
    input.workItemId,
    input.taskVersion,
  );
  if (!task) {
    throw new Error("AgentTask cancellation target was not found");
  }
  if (REFUSED_TERMINAL_LIFECYCLES.has(task.lifecycle)) {
    throw new Error("Terminal AgentTasks cannot be cancelled");
  }

  const outboxBinding = await (deps.getRunBinding ?? getRunBinding)(
    task.workItemId,
  );
  const taskRunId = task.bindings?.harnessRunId;
  if (
    taskRunId
    && outboxBinding
    && taskRunId !== outboxBinding.harnessRunId
  ) {
    throw new Error("AgentTask cancellation found a conflicting run binding");
  }

  let runId = taskRunId ?? outboxBinding?.harnessRunId;
  let acknowledged = runId === undefined;
  let acknowledgementReason = runId
    ? "harness_cancel_not_attempted"
    : "no_active_harness_run_observed";

  if (!runId && task.approval.approvedTaskHash) {
    const intendedRunId = deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      task.approval.approvedTaskHash,
    );
    try {
      await deps.readPort.readRun({ harnessRunId: intendedRunId });
      runId = intendedRunId;
    } catch (error) {
      if (!isRunMissing(error)) {
        acknowledgementReason = "harness_run_lookup_unacknowledged";
        acknowledged = false;
      }
    }
  }

  if (runId) {
    try {
      await deps.controlPort.cancel(runId);
      acknowledged = true;
      acknowledgementReason = "harness_cancel_acknowledged";
    } catch (error) {
      if (!(error instanceof HarnessControlError)) throw error;
      acknowledged = false;
      acknowledgementReason = `harness_cancel_unacknowledged_${error.code}`;
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  const updatedAt = now.toISOString();
  const cancelled = agentTaskV1Schema.parse({
    ...task,
    lifecycle: "cancelled",
    timestamps: {
      ...task.timestamps,
      terminalAt: task.timestamps.terminalAt ?? updatedAt,
      updatedAt,
    },
    ...(runId
      ? {
          bindings: {
            ...task.bindings,
            harnessRunId: runId,
          },
        }
      : {}),
  });
  const saved = await (deps.saveTask ?? putAgentTask)(cancelled);
  await (deps.recordDecision ?? recordHermesDecision)(
    buildCancellationDecision(
      saved,
      operatorActor,
      reason,
      acknowledgementReason,
      acknowledged,
      runId,
      now,
    ),
  );

  if (!acknowledged) {
    await deps.alertSink({
      severity: "critical",
      code: "cancel_unacknowledged",
      workItemId: saved.workItemId,
      taskVersion: saved.taskVersion,
      ...(runId ? { harnessRunId: runId } : {}),
      message:
        `AgentTask was cancelled, but Harness acknowledgement is uncertain (${acknowledgementReason}).`,
      at: updatedAt,
    });
  }
  return saved;
}

function buildCancellationDecision(
  task: AgentTaskV1,
  actor: ActorRef & { type: "operator" },
  reason: string,
  acknowledgementReason: string,
  acknowledged: boolean,
  runId: string | undefined,
  generatedAt: Date,
): HermesDecisionRecordV2 {
  return buildHermesDecisionRecordV2({
    correlationId: task.correlationId,
    workItemId: task.workItemId,
    decisionType: "escalation",
    proposal: {
      what: "Cancel the AgentTask at the operator's request.",
      why: [reason, acknowledgementReason],
      evidenceRefs: task.proposal.sourceRefs,
    },
    inputs: [{
      name: "approved-task",
      ...(task.approval.approvedTaskHash
        ? { hash: task.approval.approvedTaskHash }
        : {}),
      observedAt: generatedAt.toISOString(),
    }],
    risk: task.risk,
    approval: {
      required: "operator",
      decision: "approved",
      actor,
      policyVersion: task.approval.policyVersion,
      policyHash: task.approval.policyHash,
      decidedAt: generatedAt.toISOString(),
    },
    effects: {
      mutates: true,
      mutations: [
        {
          system: "agent-task",
          action: "cancel",
          target: `${task.workItemId}@${task.taskVersion}`,
        },
        ...(acknowledged && runId
          ? [{
              system: "agent-harness" as const,
              action: "cancel",
              target: runId,
              idempotencyKey: runId,
            }]
          : []),
      ],
      authorityChanged: false,
      budgetChanged: false,
    },
    next: acknowledged
      ? {
          action: "Operator confirms the cancelled task requires no further action.",
          owner: "operator",
        }
      : {
          action: "Operator verifies whether the Harness run stopped.",
          owner: "operator",
          blockedBy: [acknowledgementReason],
        },
    generatedAt,
  });
}

function isRunMissing(error: unknown): boolean {
  return (
    error instanceof HarnessReadError
    || (
      error instanceof Error
      && error.name === "HarnessReadError"
      && "code" in error
    )
  ) && (error as HarnessReadError).code === "run_not_started";
}
