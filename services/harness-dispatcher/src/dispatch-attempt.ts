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
  type DispatchClaim,
  type DispatchClaimProgressInput,
} from "@avg/averray-mcp/dispatch-claim";
import {
  type DispatchBackpressureState,
} from "@avg/averray-mcp/dispatch-backpressure";
import {
  type DispatchPolicyIdentity,
} from "@avg/averray-mcp/dispatch-policy-drift";
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

import { type AlertSink } from "./alerts.js";
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

export type DispatchCrashPoint =
  | "after-claim-before-submit"
  | "after-submit-before-binding";

export interface DispatchDeps {
  now(): Date;
  dispatcherId: string;
  leaseTtlSeconds: number;
  claimTtlMs: number;
  maxInflight: number;
  activePolicyIdentity: DispatchPolicyIdentity | undefined;
  isDispatchEnabled(): boolean;
  isHalted(): boolean;
  listDispatchable(): Promise<AgentTaskV1[]>;
  getTask(workItemId: string, taskVersion: number): Promise<AgentTaskV1 | undefined>;
  saveTask(task: AgentTaskV1): Promise<unknown>;
  acquireLease(input: { holder: string; ttlSeconds: number }): Promise<boolean>;
  renewLease(input: { holder: string; ttlSeconds: number }): Promise<boolean>;
  releaseLease(holder: string): Promise<boolean>;
  claimDispatch(input: ClaimDispatchInput): Promise<{
    claim: DispatchClaim;
    created: boolean;
    acquired: boolean;
  }>;
  getNextExpiredClaim(): Promise<DispatchClaim | undefined>;
  acquireNextExpiredClaim(input: {
    holder: string;
    leaseTtlMs: number;
  }): Promise<DispatchClaim | undefined>;
  recordClaimProgress(input: DispatchClaimProgressInput): Promise<DispatchClaim>;
  countInflight(): Promise<number>;
  transitionBackpressure(input: {
    active: boolean;
    observedInflight: number;
    maxInflight: number;
  }): Promise<{ state: DispatchBackpressureState; changed: boolean }>;
  getRunBinding(workItemId: string): Promise<RunBinding | undefined>;
  bindRun(input: BindRunInput): Promise<unknown>;
  loadProfileManifest(profileId: string): Promise<PilotProfileManifest>;
  prepareWorkspace(task: AgentTaskV1): Promise<string>;
  writeIntentArtifact(bytes: string, workItemId: string): Promise<string>;
  controlPort: HarnessControlPort;
  recordDecision(record: HermesDecisionRecordV2): Promise<unknown>;
  alertSink: AlertSink;
  maybeCrash?(point: DispatchCrashPoint): Promise<void> | void;
  logger?: {
    info?(object: unknown, message: string): void;
    warn(object: unknown, message: string): void;
  };
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
  requireActivePolicyIdentity(deps);
  if (deps.isHalted()) return { outcome: "halted" };

  const leaseAcquired = await deps.acquireLease({
    holder: deps.dispatcherId,
    ttlSeconds: deps.leaseTtlSeconds,
  });
  if (!leaseAcquired) return { outcome: "lease_unavailable" };

  try {
    const expiredPreview = await deps.getNextExpiredClaim();
    if (expiredPreview) {
      const task = await deps.getTask(
        expiredPreview.workItemId,
        expiredPreview.taskVersion,
      );
      if (!task) {
        throw new Error(
          `Expired dispatch claim has no AgentTask ${expiredPreview.workItemId}@${expiredPreview.taskVersion}`,
        );
      }
      const previewValidation = await validateTask(deps, task, true);
      if (previewValidation) {
        return refuse(deps, task, expiredPreview.intendedRunId, previewValidation);
      }
      if (
        expiredPreview.claimState === "claimed"
        && await refuseForBackpressure(deps, task, expiredPreview.intendedRunId)
      ) {
        return backpressureResult(task, expiredPreview.intendedRunId);
      }
      await clearBackpressureIfBelowBound(deps);
      const claim = await deps.acquireNextExpiredClaim({
        holder: deps.dispatcherId,
        leaseTtlMs: deps.claimTtlMs,
      });
      if (!claim) return { outcome: "idle" };
      const claimedTask = claim.workItemId === task.workItemId
        && claim.taskVersion === task.taskVersion
        ? task
        : await deps.getTask(claim.workItemId, claim.taskVersion);
      if (!claimedTask) {
        throw new Error(
          `Acquired dispatch claim has no AgentTask ${claim.workItemId}@${claim.taskVersion}`,
        );
      }
      return resumeClaimedDispatch(deps, claimedTask, claim);
    }

    const task = (await deps.listDispatchable())[0];
    if (!task) {
      await clearBackpressureIfBelowBound(deps);
      return { outcome: "idle" };
    }
    if (task.executor.kind !== "harness") {
      return refuseBeforeIdentity(deps, task, "executor_not_harness");
    }
    if (task.lifecycle !== "approved") {
      return refuseBeforeIdentity(deps, task, "not_approved");
    }
    if (!await agentTaskApprovalHashMatches(task)) {
      return refuseBeforeIdentity(deps, task, "approval_hash_mismatch");
    }
    if (taskPolicyDrifted(task, requireActivePolicyIdentity(deps))) {
      return refuseBeforeIdentity(deps, task, "policy_drift");
    }
    if (!(Date.parse(task.deadline) > deps.now().getTime())) {
      return refuseBeforeIdentity(deps, task, "deadline_expired");
    }
    if (await refuseForBackpressure(deps, task)) {
      return backpressureResult(task);
    }
    await clearBackpressureIfBelowBound(deps);
    return startDispatch(deps, task);
  } finally {
    await deps.releaseLease(deps.dispatcherId);
  }
}

async function startDispatch(
  deps: DispatchDeps,
  task: AgentTaskV1,
): Promise<DispatchAttemptResult> {
  const approvedTaskHash = task.approval.approvedTaskHash!;
  const intendedRunId = deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    approvedTaskHash,
  );
  const existing = await deps.getRunBinding(task.workItemId);
  if (existing) {
    return adoptExistingBinding(deps, task, intendedRunId, existing);
  }

  let result: Awaited<ReturnType<DispatchDeps["claimDispatch"]>>;
  try {
    result = await deps.claimDispatch({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash,
      intendedRunId,
      holder: deps.dispatcherId,
      leaseTtlMs: deps.claimTtlMs,
    });
  } catch (error) {
    if (isDispatchClaimError(error, "claim_conflict")) {
      return refuse(deps, task, intendedRunId, "claim_conflict");
    }
    throw error;
  }
  if (!result.acquired) return { outcome: "idle" };
  return executeClaimedDispatch(deps, task, result.claim);
}

async function resumeClaimedDispatch(
  deps: DispatchDeps,
  task: AgentTaskV1,
  claim: DispatchClaim,
): Promise<DispatchAttemptResult> {
  const validation = await validateTask(deps, task, true);
  if (validation) return refuse(deps, task, claim.intendedRunId, validation);
  const approvedTaskHash = task.approval.approvedTaskHash!;
  const derivedRunId = deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    approvedTaskHash,
  );
  if (
    claim.approvedTaskHash !== approvedTaskHash
    || claim.intendedRunId !== derivedRunId
  ) {
    return refuse(deps, task, claim.intendedRunId, "claim_conflict");
  }

  // This read is deliberately after the expired claim was won. A binding
  // created by another holder always wins over retrying submission.
  const existing = await deps.getRunBinding(task.workItemId);
  if (existing) {
    return adoptExistingBinding(deps, task, derivedRunId, existing, claim);
  }
  if (claim.claimState === "exhausted") {
    const reason = `dispatch_retry_exhausted_generation_${claim.claimGeneration}`;
    return refuse(deps, task, derivedRunId, reason, {
      severity: "critical",
      code: "dispatch_retry_exhausted",
      message: `Harness dispatch retry exhausted at claim generation ${claim.claimGeneration}; no third submit was attempted.`,
    });
  }
  if (
    claim.claimState !== "submitted"
    && !(Date.parse(task.deadline) > deps.now().getTime())
  ) {
    return refuse(deps, task, derivedRunId, "deadline_expired");
  }
  const retryRunId = claim.intendedRunId;
  return executeClaimedDispatch(deps, task, claim, retryRunId);
}

async function executeClaimedDispatch(
  deps: DispatchDeps,
  task: AgentTaskV1,
  claim: DispatchClaim,
  submissionRunId = claim.intendedRunId,
): Promise<DispatchAttemptResult> {
  const intendedRunId = claim.intendedRunId;
  let workspacePath: string;
  try {
    workspacePath = await deps.prepareWorkspace(task);
  } catch (error) {
    if (error instanceof WorkspacePrepError) {
      return refuse(
        deps,
        task,
        intendedRunId,
        "workspace_prep_failed",
        dependencyRefusalAlert(error),
      );
    }
    throw error;
  }
  if (workspacePath !== workspacePathForTask(task.workItemId, task.taskVersion)) {
    return refuse(deps, task, intendedRunId, "workspace_prep_failed");
  }

  const artifact = await buildTaskIntentArtifact(task, { workspacePath });
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
  await deps.maybeCrash?.("after-claim-before-submit");

  let boundRunId: string;
  try {
    boundRunId = await deps.controlPort.submit(submissionRunId, intentPath);
  } catch (error) {
    if (!(error instanceof HarnessControlError)) throw error;
    const ambiguous = !DEFINITELY_NO_RUN_CODES.has(error.code);
    const reason = ambiguous ? "submit_ambiguous" : "submit_refused";
    await blockAndRecordRefusal(deps, dispatchingTask, intendedRunId, reason);
    return {
      outcome: "submit_failed",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      intendedRunId,
      ambiguous,
      reason,
    };
  }
  if (boundRunId !== submissionRunId) {
    return refuse(
      deps,
      dispatchingTask,
      submissionRunId,
      "submit_identity_mismatch",
    );
  }

  const submittedClaim = await deps.recordClaimProgress({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    holder: deps.dispatcherId,
    claimGeneration: claim.claimGeneration,
    progress: "submitted",
    leaseTtlMs: deps.claimTtlMs,
  });
  await deps.maybeCrash?.("after-submit-before-binding");
  return bindClaimedRun(
    deps,
    dispatchingTask,
    submittedClaim,
    boundRunId,
  );
}

async function bindClaimedRun(
  deps: DispatchDeps,
  task: AgentTaskV1,
  claim: DispatchClaim,
  intendedRunId: string,
): Promise<DispatchAttemptResult> {
  try {
    await deps.bindRun({
      workItemId: task.workItemId,
      harnessRunId: intendedRunId,
    });
  } catch (error) {
    if (isDispatchClaimError(error, "binding_conflict")) {
      return refuse(deps, task, intendedRunId, "binding_conflict");
    }
    throw error;
  }
  await deps.recordClaimProgress({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    holder: deps.dispatcherId,
    claimGeneration: claim.claimGeneration,
    progress: "bound",
    leaseTtlMs: deps.claimTtlMs,
  });
  return markRunning(deps, task, intendedRunId, deps.now().toISOString(), claim);
}

async function adoptExistingBinding(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId: string,
  existing: RunBinding,
  claim?: DispatchClaim,
): Promise<DispatchAttemptResult> {
  if (existing.harnessRunId !== intendedRunId) {
    return refuse(deps, task, intendedRunId, "binding_conflict");
  }
  if (claim) {
    await deps.recordClaimProgress({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      holder: deps.dispatcherId,
      claimGeneration: claim.claimGeneration,
      progress: "bound",
      leaseTtlMs: deps.claimTtlMs,
    });
  }
  await markRunning(deps, task, intendedRunId, existing.boundAt, claim, false);
  return {
    outcome: "already_bound",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    intendedRunId,
  };
}

async function markRunning(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId: string,
  runBoundAt: string,
  claim: DispatchClaim | undefined,
  recordApproval = true,
): Promise<DispatchAttemptResult> {
  const runningTask: AgentTaskV1 = {
    ...task,
    lifecycle: "running",
    timestamps: {
      ...task.timestamps,
      runBoundAt,
      updatedAt: runBoundAt,
    },
    bindings: {
      ...task.bindings,
      harnessRunId: intendedRunId,
    },
  };
  await deps.saveTask(runningTask);
  if (recordApproval) {
    await deps.recordDecision(
      buildDispatchDecision(
        runningTask,
        "dispatch_approval",
        "dispatch_succeeded",
        deps.now(),
        claim,
      ),
    );
  }
  return {
    outcome: "dispatched",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    intendedRunId,
  };
}

async function validateTask(
  deps: DispatchDeps,
  task: AgentTaskV1,
  allowDispatching: boolean,
): Promise<string | undefined> {
  if (task.executor.kind !== "harness") return "executor_not_harness";
  if (
    task.lifecycle !== "approved"
    && !(allowDispatching && task.lifecycle === "dispatching")
  ) {
    return "not_approved";
  }
  if (!await agentTaskApprovalHashMatches(task)) return "approval_hash_mismatch";
  if (taskPolicyDrifted(task, requireActivePolicyIdentity(deps))) {
    return "policy_drift";
  }
  if (!allowDispatching && !(Date.parse(task.deadline) > deps.now().getTime())) {
    return "deadline_expired";
  }
  return undefined;
}

async function refuseForBackpressure(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId?: string,
): Promise<boolean> {
  const observedInflight = await deps.countInflight();
  if (observedInflight < deps.maxInflight) return false;
  const transition = await deps.transitionBackpressure({
    active: true,
    observedInflight,
    maxInflight: deps.maxInflight,
  });
  if (transition.changed) {
    await deps.recordDecision(
      buildDispatchDecision(
        task,
        "dispatch_refusal",
        "backpressure",
        deps.now(),
      ),
    );
    await deps.alertSink({
      severity: "warn",
      code: "dispatch_backpressure",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      ...(intendedRunId ? { harnessRunId: intendedRunId } : {}),
      message: `Harness dispatch is backpressured at ${observedInflight}/${deps.maxInflight} non-terminal bound runs.`,
      at: deps.now().toISOString(),
    });
  }
  return true;
}

async function clearBackpressureIfBelowBound(deps: DispatchDeps): Promise<void> {
  const observedInflight = await deps.countInflight();
  if (observedInflight >= deps.maxInflight) return;
  const transition = await deps.transitionBackpressure({
    active: false,
    observedInflight,
    maxInflight: deps.maxInflight,
  });
  if (transition.changed) {
    deps.logger?.info?.({
      observedInflight,
      maxInflight: deps.maxInflight,
    }, "Harness dispatch backpressure cleared");
  }
}

function backpressureResult(
  task: AgentTaskV1,
  intendedRunId?: string,
): DispatchAttemptResult {
  return {
    outcome: "refused",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    ...(intendedRunId ? { intendedRunId } : {}),
    reason: "backpressure",
  };
}

async function refuseBeforeIdentity(
  deps: DispatchDeps,
  task: AgentTaskV1,
  reason: string,
): Promise<DispatchAttemptResult> {
  await blockAndRecordRefusal(deps, task, undefined, reason);
  return {
    outcome: "refused",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    reason,
  };
}

async function refuse(
  deps: DispatchDeps,
  task: AgentTaskV1,
  intendedRunId: string,
  reason: string,
  alert?: RefusalAlert,
): Promise<DispatchAttemptResult> {
  await blockAndRecordRefusal(deps, task, intendedRunId, reason, alert);
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
  alert?: RefusalAlert,
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
    buildDispatchDecision(
      blockedTask,
      "dispatch_refusal",
      refusalDecisionReason(deps, task, reason),
      deps.now(),
    ),
  );
  const policyAlert = reason === "policy_drift"
    ? policyDriftAlert(task, requireActivePolicyIdentity(deps))
    : undefined;
  await deps.alertSink({
    severity: alert?.severity ?? policyAlert?.severity ?? "warn",
    code: alert?.code ?? policyAlert?.code ?? "dispatch_refusal",
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    ...(intendedRunId ? { harnessRunId: intendedRunId } : {}),
    message: alert?.message
      ?? policyAlert?.message
      ?? `Harness dispatch was refused: ${reason}.`,
    at: deps.now().toISOString(),
  });
  deps.logger?.warn({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    ...(intendedRunId ? { intendedRunId } : {}),
    reason,
  }, "Harness dispatch refused");
}

function taskPolicyDrifted(
  task: AgentTaskV1,
  activePolicy: DispatchPolicyIdentity,
): boolean {
  return task.approval.policyVersion !== activePolicy.version
    || task.approval.policyHash !== activePolicy.hash;
}

function refusalDecisionReason(
  deps: DispatchDeps,
  task: AgentTaskV1,
  reason: string,
): string {
  if (reason !== "policy_drift") return reason;
  return `policy_drift approved_policy_hash=${task.approval.policyHash} active_policy_hash=${requireActivePolicyIdentity(deps).hash}`;
}

function requireActivePolicyIdentity(
  deps: DispatchDeps,
): DispatchPolicyIdentity {
  if (!deps.activePolicyIdentity) {
    throw new Error(
      "Harness dispatch active policy identity is required while dispatch is enabled",
    );
  }
  return deps.activePolicyIdentity;
}

function policyDriftAlert(
  task: AgentTaskV1,
  activePolicy: DispatchPolicyIdentity,
): RefusalAlert {
  return {
    severity: "warn",
    code: "policy_drift",
    message:
      `Harness dispatch policy drift: approved ${task.approval.policyVersion} ${task.approval.policyHash}; active ${activePolicy.version} ${activePolicy.hash}.`,
  };
}

interface RefusalAlert {
  severity: "warn" | "critical";
  code: string;
  message: string;
}

function dependencyRefusalAlert(
  error: WorkspacePrepError,
): RefusalAlert | undefined {
  if (
    error.reason !== "dependency_cache_missing"
    && error.reason !== "dependency_cache_stale"
    && error.reason !== "dependency_seed_failed"
  ) {
    return undefined;
  }
  return {
    severity: error.reason === "dependency_cache_stale" ? "critical" : "warn",
    code: error.reason,
    message: `Harness dispatch dependency preparation failed: ${error.message}.`,
  };
}

function buildDispatchDecision(
  task: AgentTaskV1,
  decisionType: "dispatch_approval" | "dispatch_refusal",
  reason: string,
  generatedAt: Date,
  claim?: DispatchClaim,
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
      name: claim
        ? `approved-task:claim-generation-${claim.claimGeneration}`
        : "approved-task",
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
