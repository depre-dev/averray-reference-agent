import { existsSync } from "node:fs";

import {
  agentTaskApprovalHashMatches,
  type AgentTaskV1,
  type HermesDecisionRecordV2,
  type PilotProfileManifest,
} from "@avg/schemas";
import {
  assertTaskIntentWithinApprovedAuthority,
  AttenuationError,
} from "@avg/averray-mcp/attenuation";
import {
  deriveIntendedRunId,
  DispatchClaimError,
  type ClaimDispatchInput,
} from "@avg/averray-mcp/dispatch-claim";
import {
  buildHermesDecisionRecordV2,
} from "@avg/averray-mcp/decision-records";
import {
  type BindRunInput,
  type RunBinding,
} from "@avg/averray-mcp/run-binding-outbox";
import {
  buildTaskIntentArtifact,
} from "@avg/averray-mcp/task-intent-mapping";
import {
  workspacePathForTask,
} from "@avg/averray-mcp/workspace-path";

import {
  type AlertSink,
} from "./alerts.js";
import {
  HarnessControlError,
  type HarnessControlErrorCode,
  type HarnessControlPort,
} from "./harness-control-port.js";
import { WorkspacePrepError } from "./workspace-prep.js";

const DEFINITELY_NO_RUN_CODES = new Set<HarnessControlErrorCode>([
  "dispatch_disabled",
  "invalid_run_id",
  "invalid_intent_path",
  "refused_command",
]);

export interface DispatchDeps {
  now(): Date;
  dispatcherId: string;
  leaseTtlSeconds: number;
  isDispatchEnabled(): boolean;
  isHalted(): boolean;
  listDispatchable(): Promise<AgentTaskV1[]>;
  saveTask(task: AgentTaskV1): Promise<unknown>;
  acquireLease(input: { holder: string; ttlSeconds: number }): Promise<boolean>;
  renewLease(input: { holder: string; ttlSeconds: number }): Promise<boolean>;
  releaseLease(holder: string): Promise<boolean>;
  claimDispatch(input: ClaimDispatchInput): Promise<unknown>;
  getRunBinding(workItemId: string): Promise<RunBinding | undefined>;
  bindRun(input: BindRunInput): Promise<unknown>;
  loadProfileManifest(profileId: string): Promise<PilotProfileManifest>;
  prepareWorkspace(task: AgentTaskV1): Promise<string>;
  writeIntentArtifact(bytes: string, workItemId: string): Promise<string>;
  controlPort: HarnessControlPort;
  recordDecision(record: HermesDecisionRecordV2): Promise<unknown>;
  alertSink: AlertSink;
  logger?: { warn(object: unknown, message: string): void };
}

export type DispatchAttemptResult =
  | { outcome: "disabled" }
  | { outcome: "halted" }
  | { outcome: "lease_unavailable" }
  | { outcome: "idle" }
  | DispatchIdentity & { outcome: "already_bound" }
  | {
    outcome: "refused";
    workItemId: string;
    taskVersion: number;
    intendedRunId?: string;
    reason: string;
  }
  | DispatchIdentity & {
    outcome: "submit_failed";
    reason: "submit_refused" | "submit_ambiguous";
    ambiguous: boolean;
  }
  | DispatchIdentity & { outcome: "dispatched" };

interface DispatchIdentity {
  workItemId: string;
  taskVersion: number;
  intendedRunId: string;
}

export function readHaltFile(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const haltFile = environment.HALT_FILE?.trim() || "/data/HALT";
  return existsSync(haltFile);
}

export async function runSingleDispatch(
  deps: DispatchDeps,
): Promise<DispatchAttemptResult> {
  if (!deps.isDispatchEnabled()) return { outcome: "disabled" };
  if (deps.isHalted()) return { outcome: "halted" };

  const leaseAcquired = await deps.acquireLease({
    holder: deps.dispatcherId,
    ttlSeconds: deps.leaseTtlSeconds,
  });
  if (!leaseAcquired) return { outcome: "lease_unavailable" };

  try {
    const task = (await deps.listDispatchable())[0];
    if (!task) return { outcome: "idle" };

    const refuseBeforeIdentity = async (
      reason: string,
    ): Promise<DispatchAttemptResult> => {
      await blockAndRecordRefusal(deps, task, undefined, reason);
      return {
        outcome: "refused",
        workItemId: task.workItemId,
        taskVersion: task.taskVersion,
        reason,
      };
    };

    if (task.executor.kind !== "harness") {
      return refuseBeforeIdentity("executor_not_harness");
    }
    if (task.lifecycle !== "approved") {
      return refuseBeforeIdentity("not_approved");
    }
    if (!await agentTaskApprovalHashMatches(task)) {
      return refuseBeforeIdentity("approval_hash_mismatch");
    }
    if (!(Date.parse(task.deadline) > deps.now().getTime())) {
      return refuseBeforeIdentity("deadline_expired");
    }

    const approvedTaskHash = task.approval.approvedTaskHash!;
    const intendedRunId = deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      approvedTaskHash,
    );
    const identity: DispatchIdentity = {
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      intendedRunId,
    };

    const existing = await deps.getRunBinding(task.workItemId);
    if (existing) {
      if (existing.harnessRunId !== intendedRunId) {
        return refuse(deps, task, intendedRunId, "binding_conflict");
      }
      const updatedAt = deps.now().toISOString();
      await deps.saveTask({
        ...task,
        lifecycle: "running",
        timestamps: {
          ...task.timestamps,
          runBoundAt: existing.boundAt,
          updatedAt,
        },
        bindings: {
          ...task.bindings,
          harnessRunId: intendedRunId,
        },
      });
      return { outcome: "already_bound", ...identity };
    }

    try {
      await deps.claimDispatch({
        workItemId: task.workItemId,
        taskVersion: task.taskVersion,
        approvedTaskHash,
        intendedRunId,
      });
    } catch (error) {
      if (isDispatchClaimError(error, "claim_conflict")) {
        return refuse(deps, task, intendedRunId, "claim_conflict");
      }
      throw error;
    }

    let workspacePath: string;
    try {
      workspacePath = await deps.prepareWorkspace(task);
    } catch (error) {
      if (error instanceof WorkspacePrepError) {
        return refuse(deps, task, intendedRunId, "workspace_prep_failed");
      }
      throw error;
    }
    if (
      workspacePath
      !== workspacePathForTask(task.workItemId, task.taskVersion)
    ) {
      return refuse(deps, task, intendedRunId, "workspace_prep_failed");
    }

    const artifact = await buildTaskIntentArtifact(task, {
      workspacePath,
    });
    if (artifact.templateHash !== task.intent.templateHash) {
      return refuse(deps, task, intendedRunId, "template_hash_mismatch");
    }

    const profile = await deps.loadProfileManifest(task.intent.profile);
    try {
      await assertTaskIntentWithinApprovedAuthority(task, artifact.intent, profile);
    } catch (error) {
      if (error instanceof AttenuationError) {
        return refuse(deps, task, intendedRunId, error.reason);
      }
      throw error;
    }

    const intentPath = await deps.writeIntentArtifact(
      artifact.canonicalBytes,
      task.workItemId,
    );
    if (deps.isHalted()) {
      return refuse(deps, task, intendedRunId, "halted_before_submit");
    }

    const dispatchClaimedAt = deps.now().toISOString();
    const dispatchingTask: AgentTaskV1 = {
      ...task,
      lifecycle: "dispatching",
      timestamps: {
        ...task.timestamps,
        dispatchClaimedAt,
        updatedAt: dispatchClaimedAt,
      },
    };
    await deps.saveTask(dispatchingTask);

    let boundRunId: string;
    try {
      boundRunId = await deps.controlPort.submit(intendedRunId, intentPath);
    } catch (error) {
      if (!(error instanceof HarnessControlError)) throw error;
      const ambiguous = !DEFINITELY_NO_RUN_CODES.has(error.code);
      const reason = ambiguous ? "submit_ambiguous" : "submit_refused";

      // Ambiguous submission is reconciled later through `run status
      // <intendedRunId>`. This write-only packet deliberately has no read path.
      // Re-submitting the same intended run id is safe because DBOS deduplicates it.
      await blockAndRecordRefusal(
        deps,
        dispatchingTask,
        intendedRunId,
        reason,
      );
      return {
        outcome: "submit_failed",
        ...identity,
        ambiguous,
        reason,
      };
    }

    if (boundRunId !== intendedRunId) {
      return refuse(
        deps,
        dispatchingTask,
        intendedRunId,
        "submit_identity_mismatch",
      );
    }

    try {
      await deps.bindRun({
        workItemId: task.workItemId,
        harnessRunId: boundRunId,
      });
    } catch (error) {
      if (isDispatchClaimError(error, "binding_conflict")) {
        return refuse(
          deps,
          dispatchingTask,
          intendedRunId,
          "binding_conflict",
        );
      }
      throw error;
    }

    const runBoundAt = deps.now().toISOString();
    const runningTask: AgentTaskV1 = {
      ...dispatchingTask,
      lifecycle: "running",
      timestamps: {
        ...dispatchingTask.timestamps,
        runBoundAt,
        updatedAt: runBoundAt,
      },
      bindings: {
        ...dispatchingTask.bindings,
        harnessRunId: boundRunId,
      },
    };
    await deps.saveTask(runningTask);
    await deps.recordDecision(
      buildDispatchDecision(runningTask, "dispatch_approval", "dispatch_succeeded", deps.now()),
    );

    return { outcome: "dispatched", ...identity };
  } finally {
    await deps.releaseLease(deps.dispatcherId);
  }
}

async function refuse(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId: string,
  reason: string,
): Promise<DispatchAttemptResult> {
  await blockAndRecordRefusal(deps, task, intendedRunId, reason);
  return {
    outcome: "refused",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    intendedRunId,
    reason,
  };
}

async function blockAndRecordRefusal(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId: string | undefined,
  reason: string,
): Promise<void> {
  const updatedAt = deps.now().toISOString();
  const blockedTask: AgentTaskV1 = {
    ...task,
    lifecycle: "blocked",
    timestamps: {
      ...task.timestamps,
      updatedAt,
    },
  };
  await deps.saveTask(blockedTask);
  await deps.recordDecision(
    buildDispatchDecision(blockedTask, "dispatch_refusal", reason, deps.now()),
  );
  await deps.alertSink({
    severity: "warn",
    code: "dispatch_refusal",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    ...(intendedRunId ? { harnessRunId: intendedRunId } : {}),
    message: `Harness dispatch was refused: ${reason}.`,
    at: deps.now().toISOString(),
  });
  deps.logger?.warn({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    ...(intendedRunId ? { intendedRunId } : {}),
    reason,
  }, "Harness dispatch refused");
}

function buildDispatchDecision(
  task: AgentTaskV1,
  decisionType: "dispatch_approval" | "dispatch_refusal",
  reason: string,
  generatedAt: Date,
): HermesDecisionRecordV2 {
  const approval = task.approval;
  return buildHermesDecisionRecordV2({
    correlationId: task.correlationId,
    workItemId: task.workItemId,
    decisionType,
    proposal: {
      what: decisionType === "dispatch_refusal"
        ? "Refuse the supervised dispatch attempt."
        : "Record the supervised dispatch approval.",
      why: [reason],
      evidenceRefs: task.proposal.sourceRefs,
    },
    inputs: [{
      name: "approved-task",
      ...(approval.approvedTaskHash
        ? { hash: approval.approvedTaskHash }
        : {}),
      observedAt: generatedAt.toISOString(),
    }],
    risk: task.risk,
    approval: {
      required: approval.required,
      decision: approval.status,
      ...(approval.actor ? { actor: approval.actor } : {}),
      policyVersion: approval.policyVersion,
      policyHash: approval.policyHash,
      ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
    },
    effects: {
      mutates: false,
      mutations: [],
      authorityChanged: false,
      budgetChanged: false,
    },
    next: decisionType === "dispatch_refusal"
      ? {
        action: "Operator reviews the refusal before any new dispatch attempt.",
        owner: "operator",
        blockedBy: [reason],
      }
      : {
        action: "Harness owns execution under the approved immutable task.",
        owner: "harness",
      },
    generatedAt,
  });
}

function isDispatchClaimError(
  error: unknown,
  reason: "claim_conflict" | "binding_conflict",
): error is DispatchClaimError {
  return (
    error instanceof DispatchClaimError
    || (
      error instanceof Error
      && error.name === "DispatchClaimError"
      && "reason" in error
    )
  ) && (error as DispatchClaimError).reason === reason;
}
