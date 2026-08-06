import { createHash } from "node:crypto";

import {
  assertAgentRunProjectionWithinTask,
  assertVerifiedHandoffMatchesTaskAndRun,
  agentTaskV1Schema,
  artifactRefSchema,
  verifiedHandoffV1Schema,
  type AgentRunProjectionV1,
  type AgentTaskLifecycle,
  type AgentTaskV1,
  type ArtifactRef,
  type GithubPullRequestRef,
  type HarnessRunState,
  type HermesDecisionRecordV2,
  type MutationRef,
  type VerifiedHandoffV1,
} from "@avg/schemas";
import {
  deriveIntendedRunId,
} from "@avg/averray-mcp/dispatch-claim";
import {
  findBindingIntegrityViolations,
  type DispatchQuarantine,
  type MarkDispatchQuarantineInput,
  type RunBindingAuditRow,
} from "@avg/averray-mcp/dispatch-quarantine";
import {
  buildHermesDecisionRecordV2,
} from "@avg/averray-mcp/decision-records";
import {
  projectHarnessRun,
  type HarnessProjectionBinding,
} from "@avg/averray-mcp/harness-run-projection";
import {
  HarnessReadError,
  type HarnessReadPort,
  type HarnessRunReadSnapshot,
} from "@avg/averray-mcp/harness-read-port";
import type {
  BindRunInput,
  RunBinding,
} from "@avg/averray-mcp/run-binding-outbox";

import {
  type AlertSink,
  type DispatchAlert,
} from "./alerts.js";
import {
  HarnessControlError,
  type HarnessControlPort,
} from "./harness-control-port.js";

const ACTIVE_LIFECYCLES = new Set<AgentTaskLifecycle>([
  "dispatching",
  "running",
  "verifying",
]);

const RUNNING_STATES = new Set<HarnessRunState>([
  "accepted",
  "contract_compiled",
  "environment_preparing",
  "environment_ready",
  "strategy_selected",
  "executing",
]);

const VERIFYING_STATES = new Set<HarnessRunState>([
  "verifying",
  "repairing",
  "replanning",
  "finalizing",
]);

const CANCELLED_STATES = new Set<HarnessRunState>([
  "cancel_requested",
  "compensating",
  "cancelled",
]);

type BudgetDimension = "elapsed_seconds" | "model_tokens" | "tool_calls";

interface BudgetExhaustion {
  dimension: BudgetDimension;
  used: number;
  limit: number;
  overBy: number;
}

export interface ReconcileLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ReconcileRunDeps {
  now(): Date;
  isHalted(): boolean;
  listTasks(): Promise<AgentTaskV1[]>;
  saveTask(task: AgentTaskV1): Promise<unknown>;
  getRunBinding(workItemId: string): Promise<RunBinding | undefined>;
  getActiveQuarantine(
    workItemId: string,
    taskVersion: number,
  ): Promise<DispatchQuarantine | undefined>;
  markQuarantine(input: MarkDispatchQuarantineInput): Promise<{
    marker: DispatchQuarantine;
    activated: boolean;
  }>;
  listBindingAuditRows(): Promise<RunBindingAuditRow[]>;
  bindRun(input: BindRunInput): Promise<unknown>;
  readPort: HarnessReadPort;
  controlPort: Pick<HarnessControlPort, "cancel">;
  recordDecision(record: HermesDecisionRecordV2): Promise<unknown>;
  alertSink: AlertSink;
  logger?: ReconcileLogger;
  poisonThreshold: number;
  poisonFailures: PoisonFailureTracker;
  projectRun?: (
    binding: HarnessProjectionBinding,
    read: HarnessRunReadSnapshot,
    options: { now: Date },
  ) => AgentRunProjectionV1;
}

export interface ReconcileResult {
  workItemId: string;
  taskVersion: number;
  outcome:
    | "unchanged"
    | "advanced"
    | "recovered"
    | "run_missing"
    | "awaiting_manifest"
    | "read_degraded"
    | "quarantined"
    | "refused"
    | "handoff_ready";
  previousLifecycle: AgentTaskLifecycle;
  lifecycle: AgentTaskLifecycle;
  healthy: boolean;
  reason?: string;
  projection?: AgentRunProjectionV1;
  handoff?: VerifiedHandoffV1;
}

export interface PoisonFailureObservation {
  fingerprint: string;
  cycleCount: number;
  counted: boolean;
}

export interface PoisonFailureTracker {
  record(
    workItemId: string,
    taskVersion: number,
    error: unknown,
    options: { transient: boolean; now: Date },
  ): PoisonFailureObservation;
  reset(workItemId: string, taskVersion: number): void;
}

export function createPoisonFailureTracker(options: {
  countTransientFailures?: boolean;
  includeTimestampInFingerprint?: boolean;
} = {}): PoisonFailureTracker {
  const failures = new Map<string, { fingerprint: string; cycleCount: number }>();
  return {
    record(workItemId, taskVersion, error, observation) {
      const key = taskKey(workItemId, taskVersion);
      if (observation.transient && options.countTransientFailures !== true) {
        failures.delete(key);
        return {
          fingerprint: poisonFingerprint(error),
          cycleCount: 0,
          counted: false,
        };
      }
      const base = poisonFingerprint(error);
      const fingerprint = options.includeTimestampInFingerprint === true
        ? `${base}:${observation.now.toISOString()}`
        : base;
      const previous = failures.get(key);
      const cycleCount = previous?.fingerprint === fingerprint
        ? previous.cycleCount + 1
        : 1;
      failures.set(key, { fingerprint, cycleCount });
      return { fingerprint, cycleCount, counted: true };
    },
    reset(workItemId, taskVersion) {
      failures.delete(taskKey(workItemId, taskVersion));
    },
  };
}

export interface PullRequestActuationDecisionInput {
  outcome: "opened" | "adopted";
  pullRequest: GithubPullRequestRef;
  payloadArtifact: ArtifactRef;
  githubIdentity: string;
  githubRepository: string;
  mutation?: MutationRef;
}

/**
 * Builds the post-actuation evidence record without giving reconciliation any
 * GitHub transport capability. An adopted PR is observable but non-mutating;
 * a PR opened by this actuation must carry its concrete mutation ref.
 */
export function buildPullRequestActuationDecision(
  task: AgentTaskV1,
  input: PullRequestActuationDecisionInput,
  generatedAt: Date,
): HermesDecisionRecordV2 {
  if (input.pullRequest.repository !== input.githubRepository) {
    throw new Error("pull request and authorization repository disagree");
  }
  if (input.outcome === "opened" && !input.mutation) {
    throw new Error("opened pull request requires a mutation ref");
  }
  if (input.outcome === "adopted" && input.mutation) {
    throw new Error("adopted pull request cannot claim a local mutation");
  }
  const mutations = input.mutation ? [input.mutation] : [];
  return buildReconcileDecision(
    task,
    "handoff",
    input.outcome === "opened"
      ? "verified_payload_pull_request_opened"
      : "verified_payload_pull_request_adopted",
    generatedAt,
    [input.payloadArtifact],
    undefined,
    [
      `pull_request=${input.pullRequest.repository}#${input.pullRequest.number}`,
      `github_identity=${input.githubIdentity}`,
      `github_repository_scope=${input.githubRepository}`,
    ],
    {
      mutations,
      proposal: input.outcome === "opened"
        ? "Record the pull request opened from the verified payload."
        : "Record the existing pull request adopted for the verified payload.",
      nextAction: "Operator reviews the pull request; merge remains human-only.",
    },
  );
}

export async function reconcileDispatchedRuns(
  deps: ReconcileRunDeps,
): Promise<ReconcileResult[]> {
  const haltedAtStart = deps.isHalted();
  const tasks = (await deps.listTasks()).filter(
    haltedAtStart ? isHaltCandidate : isReconcileCandidate,
  );
  const integrityMarkers = await quarantineBindingIntegrityViolations(deps);
  const results: ReconcileResult[] = [];
  for (const task of tasks) {
    const marker = integrityMarkers.get(taskKey(task.workItemId, task.taskVersion))
      ?? await deps.getActiveQuarantine(task.workItemId, task.taskVersion);
    if (marker) {
      results.push(quarantinedResult(task, marker));
      continue;
    }
    if (deps.isHalted()) {
      results.push(await cancelTaskForHalt(deps, task));
      continue;
    }
    results.push(
      isAmbiguousSubmitCandidate(task)
        ? await recoverAmbiguousSubmit(deps, task)
        : await reconcileTask(deps, task),
    );
  }
  return results;
}

function isHaltCandidate(task: AgentTaskV1): boolean {
  return task.executor.kind === "harness"
    && task.lifecycle !== "handoff_ready"
    && task.lifecycle !== "failed"
    && task.lifecycle !== "cancelled";
}

function isReconcileCandidate(task: AgentTaskV1): boolean {
  return task.executor.kind === "harness"
    && (
      ACTIVE_LIFECYCLES.has(task.lifecycle)
      || isAmbiguousSubmitCandidate(task)
    );
}

function isAmbiguousSubmitCandidate(task: AgentTaskV1): boolean {
  // AgentTask V1 intentionally has no mutable error-detail field. A blocked
  // task that crossed dispatchClaimedAt but never acquired a run binding is
  // therefore the durable, schema-valid ambiguity marker. The recovery read
  // is safe for definite refusals too: a missing run remains blocked.
  return task.lifecycle === "blocked"
    && task.timestamps.dispatchClaimedAt !== undefined
    && task.bindings?.harnessRunId === undefined;
}

async function recoverAmbiguousSubmit(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
): Promise<ReconcileResult> {
  const approvedTaskHash = task.approval.approvedTaskHash;
  if (!approvedTaskHash) {
    return refuseTask(deps, task, "ambiguous_submit_missing_approval_hash");
  }
  const intendedRunId = deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    approvedTaskHash,
  );
  if (deps.now().getTime() > Date.parse(task.deadline)) {
    return forceCancelTask(deps, task, intendedRunId, {
      lifecycle: "failed",
      decisionType: "dispatch_refusal",
      reason: "deadline_exceeded",
      alert: {
        severity: "critical",
        code: "deadline_exceeded",
        message:
          "The ambiguous AgentTask exceeded its deadline; cancellation was issued and the task failed.",
      },
    });
  }

  try {
    await deps.readPort.readRun({ harnessRunId: intendedRunId });
  } catch (error) {
    if (isRunMissing(error)) {
      return result(task, {
        outcome: "run_missing",
        healthy: false,
        reason: "submit_ambiguous_run_not_found",
      });
    }
    return degradedRead(deps, task, error);
  }

  const existing = await deps.getRunBinding(task.workItemId);
  if (existing && existing.harnessRunId !== intendedRunId) {
    return refuseTask(deps, task, "binding_conflict");
  }
  try {
    await deps.bindRun({
      workItemId: task.workItemId,
      harnessRunId: intendedRunId,
    });
  } catch {
    return refuseTask(deps, task, "binding_conflict");
  }

  const updatedAt = deps.now().toISOString();
  const recovered: AgentTaskV1 = {
    ...task,
    lifecycle: "running",
    timestamps: {
      ...task.timestamps,
      runBoundAt: existing?.boundAt ?? updatedAt,
      updatedAt,
    },
    bindings: {
      ...task.bindings,
      harnessRunId: intendedRunId,
    },
  };
  await deps.saveTask(recovered);
  await emitTaskAlert(deps, recovered, {
    severity: "critical",
    code: "orphan_run_detected",
    harnessRunId: intendedRunId,
    message:
      "An existing Harness run was detected for an ambiguous submit and its immutable binding was recovered.",
  });
  return result(task, {
    outcome: "recovered",
    lifecycle: "running",
    healthy: true,
    reason: "submit_ambiguous_run_recovered",
  });
}

async function cancelTaskForHalt(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
): Promise<ReconcileResult> {
  const outboxBinding = await deps.getRunBinding(task.workItemId);
  const taskRunId = task.bindings?.harnessRunId;
  if (
    outboxBinding
    && taskRunId
    && outboxBinding.harnessRunId !== taskRunId
  ) {
    return refuseTask(deps, task, "binding_conflict");
  }
  const harnessRunId = outboxBinding?.harnessRunId
    ?? taskRunId
    ?? intendedRunIdForAmbiguousTask(task);
  if (!harnessRunId) {
    return result(task, {
      outcome: "unchanged",
      healthy: true,
      reason: "halt_no_active_run_binding",
    });
  }

  try {
    const read = await deps.readPort.readRun({ harnessRunId });
    if (read.status.outcome !== undefined) {
      return result(task, {
        outcome: "unchanged",
        healthy: true,
        reason: "halt_run_already_terminal",
      });
    }
  } catch (error) {
    if (isRunMissing(error)) {
      return result(task, {
        outcome: "run_missing",
        healthy: false,
        reason: "halt_run_not_found",
      });
    }
    // A degraded read must not prevent an emergency stop for a bound run.
  }

  return forceCancelTask(deps, task, harnessRunId, {
    lifecycle: "cancelled",
    decisionType: "escalation",
    reason: "halt_active_run_cancelled",
    alert: {
      severity: "critical",
      code: "halt_active_run_cancelled",
      message:
        "HALT was present with an active Harness run; cancellation was issued and the AgentTask was cancelled.",
    },
    outboxBinding,
  });
}

async function reconcileTask(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
): Promise<ReconcileResult> {
  const outboxBinding = await deps.getRunBinding(task.workItemId);
  const taskRunId = task.bindings?.harnessRunId;
  if (
    outboxBinding
    && taskRunId
    && outboxBinding.harnessRunId !== taskRunId
  ) {
    return refuseTask(deps, task, "binding_conflict");
  }

  const harnessRunId = outboxBinding?.harnessRunId
    ?? taskRunId
    ?? intendedRunIdForDispatching(task);
  if (!harnessRunId) {
    return degradedResult(
      deps,
      task,
      "run_binding_missing",
      "Harness run reconciliation has no immutable run binding",
    );
  }
  if (deps.now().getTime() > Date.parse(task.deadline)) {
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "failed",
      decisionType: "dispatch_refusal",
      reason: "deadline_exceeded",
      alert: {
        severity: "critical",
        code: "deadline_exceeded",
        message:
          "The AgentTask deadline was exceeded; the active Harness run was cancelled and the task failed.",
      },
      outboxBinding,
    });
  }

  let read: HarnessRunReadSnapshot;
  try {
    read = await deps.readPort.readRun({ harnessRunId });
  } catch (error) {
    if (isRunMissing(error) && task.lifecycle === "dispatching") {
      return result(task, {
        outcome: "run_missing",
        healthy: false,
        reason: "dispatching_run_not_found",
      });
    }
    return observePoisonFailure(deps, task, harnessRunId, error);
  }
  deps.poisonFailures.reset(task.workItemId, task.taskVersion);

  const projectionBinding = buildProjectionBinding(
    task,
    harnessRunId,
    outboxBinding,
    read,
  );
  if (!projectionBinding) {
    return result(task, {
      outcome: "awaiting_manifest",
      healthy: false,
      reason: "run_manifest_not_observed",
    });
  }

  let projection: AgentRunProjectionV1 | undefined;
  try {
    projection = (deps.projectRun ?? projectHarnessRun)(
      projectionBinding,
      read,
      { now: deps.now() },
    );
  } catch (error) {
    return observePoisonFailure(deps, task, harnessRunId, error);
  }
  try {
    assertAgentRunProjectionWithinTask(task, projection);
  } catch (error) {
    if (
      projection?.run.terminal
      && !isTerminalOutcome(projection.run.outcome)
    ) {
      const reason =
        `terminal_projection_unresolved: ${safeErrorMessage(error)}`;
      return refuseTask(deps, task, reason, {
        severity: "critical",
        code: "terminal_projection_unresolved",
        harnessRunId,
        message:
          "A terminal Harness projection had no resolvable outcome; "
          + "reconciliation stopped for operator review.",
      });
    }
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "blocked",
      decisionType: "dispatch_refusal",
      reason: `projection_containment_failed: ${safeErrorMessage(error)}`,
      alert: {
        severity: "critical",
        code: "containment_expansion",
        message:
          "Harness projection exceeded the approved task authority; the run was cancelled and blocked.",
      },
      outboxBinding,
    });
  }

  if (projection.source.health !== "healthy") {
    return degradedResult(
      deps,
      task,
      projection.source.reason ?? "Harness projection source is not healthy",
      "Harness run projection is degraded",
      projection,
    );
  }
  const budgetExhaustions = projection.budget.exhausted
    ? exhaustedBudgetDimensions(projection)
    : [];
  const budgetReasons = budgetDecisionReasons(budgetExhaustions);
  if (projection.budget.exhausted && !projection.run.terminal) {
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "failed",
      decisionType: "dispatch_refusal",
      reason: "budget_exhausted",
      additionalReasons: budgetReasons,
      alert: {
        severity: "critical",
        code: "budget_exhausted",
        message: `${budgetAlertSummary(budgetExhaustions)}; the live run was cancelled and the task failed.`,
      },
      projection,
      outboxBinding,
    });
  }

  const nextLifecycle = lifecycleForProjection(task.lifecycle, projection);
  const manifestRef = projection.manifest.ref;
  const manifestHash = projection.manifest.hash;
  if (
    manifestRef
    && (
      outboxBinding?.runManifestRef?.uri !== manifestRef.uri
      || outboxBinding?.runManifestHash !== manifestHash
    )
  ) {
    try {
      await deps.bindRun({
        workItemId: task.workItemId,
        harnessRunId,
        runManifestRef: manifestRef,
        runManifestHash: manifestHash,
      });
    } catch {
      return refuseTask(deps, task, "binding_conflict");
    }
  }

  const updatedTask = taskWithProjectionFacts(
    task,
    harnessRunId,
    nextLifecycle,
    projection,
    deps.now(),
    outboxBinding,
  );

  const approvalPacketObserved = read.events.some(
    (event) => event.type === "ApprovalRequested",
  );
  if (
    approvalPacketObserved
    || (
      !projection.run.terminal
      && projection.run.state === "approval_required"
    )
  ) {
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "blocked",
      decisionType: "dispatch_refusal",
      reason: approvalPacketObserved
        ? "approval_packet_detected"
        : "unexpected_harness_state_approval_required",
      alert: {
        severity: "critical",
        code: approvalPacketObserved
          ? "approval_packet_detected"
          : "approval_required",
        message:
          "An unexpected Harness approval boundary appeared; the run was cancelled without approving or denying it.",
      },
      projection,
      outboxBinding,
    });
  }
  if (!projection.run.terminal && projection.run.state === "suspended") {
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "blocked",
      decisionType: "dispatch_refusal",
      reason: "unexpected_harness_state_suspended",
      alert: {
        severity: "critical",
        code: "run_suspended",
        message:
          "The Harness run suspended unexpectedly; it was cancelled and blocked for operator review.",
      },
      projection,
      outboxBinding,
    });
  }
  if (!projection.run.terminal && projection.run.state === "quarantined") {
    return forceCancelTask(deps, task, harnessRunId, {
      lifecycle: "blocked",
      decisionType: "dispatch_refusal",
      reason: "harness_run_quarantined",
      alert: {
        severity: "critical",
        code: "run_quarantined",
        message:
          "The Harness run was quarantined; it was cancelled and blocked for operator review.",
      },
      projection,
      outboxBinding,
    });
  }

  if (projection.budget.exhausted) {
    await emitTaskAlert(deps, updatedTask, {
      severity: "warn",
      code: "budget_exhausted",
      harnessRunId,
      message: `${budgetAlertSummary(budgetExhaustions)}; the run was already terminal, so its outcome was preserved.`,
    });
  }

  if (nextLifecycle === "handoff_ready") {
    let handoff: VerifiedHandoffV1;
    try {
      handoff = buildVerifiedHandoff(updatedTask, projection, read, deps.now());
      await assertVerifiedHandoffMatchesTaskAndRun(
        updatedTask,
        projection,
        handoff,
      );
    } catch (error) {
      return refuseTask(
        deps,
        task,
        `verified_handoff_invalid: ${safeErrorMessage(error)}`,
      );
    }
    await deps.saveTask(updatedTask);
    await deps.recordDecision(
      buildReconcileDecision(
        updatedTask,
        "handoff",
        "verified_handoff_ready_for_operator",
        deps.now(),
        handoff.verification.evidenceRefs,
        projection,
        [
          `eligible_for_pr_open=${handoff.eligibleForPrOpen}`,
          "eligible_for_pr_open_reason=completed_outcome_verified_acceptance_all_checks_passed",
          ...(projection.budget.exhausted
            ? ["budget_status=exhausted", ...budgetReasons]
            : ["budget_status=within_limits"]),
        ],
      ),
    );
    return result(task, {
      outcome: "handoff_ready",
      lifecycle: "handoff_ready",
      healthy: true,
      projection,
      handoff,
    });
  }

  const changed = JSON.stringify(updatedTask) !== JSON.stringify(task);
  if (changed) await deps.saveTask(updatedTask);
  return result(task, {
    outcome: changed ? "advanced" : "unchanged",
    lifecycle: nextLifecycle,
    healthy: true,
    projection,
  });
}

async function quarantineBindingIntegrityViolations(
  deps: ReconcileRunDeps,
): Promise<Map<string, DispatchQuarantine>> {
  const grouped = new Map<string, ReturnType<typeof findBindingIntegrityViolations>>();
  for (const violation of findBindingIntegrityViolations(
    await deps.listBindingAuditRows(),
  )) {
    const key = taskKey(violation.workItemId, violation.taskVersion);
    const entries = grouped.get(key) ?? [];
    entries.push(violation);
    grouped.set(key, entries);
  }
  const markers = new Map<string, DispatchQuarantine>();
  for (const [key, violations] of grouped) {
    const first = violations[0]!;
    const detail = violations.map(bindingViolationDetail).sort().join("; ");
    const { marker, activated } = await deps.markQuarantine({
      workItemId: first.workItemId,
      taskVersion: first.taskVersion,
      reason: "binding_integrity",
      fingerprint: stableFingerprint("binding_integrity", detail),
      cycleCount: 1,
    });
    markers.set(key, marker);
    if (activated) {
      await deps.alertSink({
        severity: "critical",
        code: "binding_integrity_quarantined",
        workItemId: marker.workItemId,
        taskVersion: marker.taskVersion,
        harnessRunId: first.harnessRunId,
        message:
          `Harness run binding integrity failed and the work item was quarantined: ${detail}.`,
        at: deps.now().toISOString(),
      });
    }
  }
  return markers;
}

async function observePoisonFailure(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  harnessRunId: string,
  error: unknown,
): Promise<ReconcileResult> {
  const observation = deps.poisonFailures.record(
    task.workItemId,
    task.taskVersion,
    error,
    { transient: isTransientReadFailure(error), now: deps.now() },
  );
  if (!observation.counted || observation.cycleCount < deps.poisonThreshold) {
    return degradedRead(deps, task, error);
  }
  const { marker, activated } = await deps.markQuarantine({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    reason: "poison_read",
    fingerprint: observation.fingerprint,
    cycleCount: observation.cycleCount,
  });
  if (activated) {
    await emitTaskAlert(deps, task, {
      severity: "critical",
      code: "poison_read_quarantined",
      harnessRunId,
      message:
        `Harness run read was quarantined after ${marker.cycleCount} consecutive cycles with fingerprint ${marker.fingerprint}.`,
    });
  }
  return quarantinedResult(task, marker);
}

function quarantinedResult(
  task: AgentTaskV1,
  marker: DispatchQuarantine,
): ReconcileResult {
  return result(task, {
    outcome: "quarantined",
    healthy: false,
    reason:
      `dispatch_quarantined reason=${marker.reason} fingerprint=${marker.fingerprint} cycles=${marker.cycleCount}`,
  });
}

function bindingViolationDetail(
  violation: ReturnType<typeof findBindingIntegrityViolations>[number],
): string {
  if (violation.kind === "run_id_mismatch") {
    return `work_item=${violation.workItemId}@${violation.taskVersion} actual_run_id=${violation.harnessRunId} intended_run_id=${violation.intendedRunId ?? "missing_approval_hash"}`;
  }
  return `work_item=${violation.workItemId}@${violation.taskVersion} run_id=${violation.harnessRunId} conflicts_with=${violation.conflictingWorkItemId}@${violation.conflictingTaskVersion}`;
}

function poisonFingerprint(error: unknown): string {
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  const message = safeErrorMessage(error)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<timestamp>")
    .replace(/\b(?:cycle|attempt|retry|counter)\s*[=:]?\s*\d+\b/giu, "counter=<counter>");
  return stableFingerprint(errorClass, message);
}

function stableFingerprint(errorClass: string, message: string): string {
  return `sha256:${createHash("sha256")
    .update(`${errorClass}\0${message}`, "utf8")
    .digest("hex")}`;
}

function taskKey(workItemId: string, taskVersion: number): string {
  return `${workItemId}\0${taskVersion}`;
}

function isTransientReadFailure(error: unknown): boolean {
  return asHarnessReadError(error)?.retryable === true;
}

interface ForceCancelOptions {
  lifecycle: "blocked" | "failed" | "cancelled";
  decisionType: "dispatch_refusal" | "escalation";
  reason: string;
  additionalReasons?: string[];
  alert: Pick<DispatchAlert, "severity" | "code" | "message">;
  projection?: AgentRunProjectionV1;
  outboxBinding?: RunBinding;
}

async function forceCancelTask(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  harnessRunId: string,
  options: ForceCancelOptions,
): Promise<ReconcileResult> {
  let controlAcknowledged = true;
  let controlReason = "harness_cancel_acknowledged";
  try {
    await deps.controlPort.cancel(harnessRunId);
  } catch (error) {
    const code = harnessControlErrorCode(error);
    if (!code) throw error;
    controlAcknowledged = false;
    controlReason = `harness_cancel_unacknowledged_${code}`;
  }

  const now = deps.now();
  const updatedTask = options.projection
    ? taskWithProjectionFacts(
        task,
        harnessRunId,
        options.lifecycle,
        options.projection,
        now,
        options.outboxBinding,
      )
    : agentTaskV1Schema.parse({
        ...task,
        lifecycle: options.lifecycle,
        timestamps: {
          ...task.timestamps,
          ...(options.lifecycle === "failed" || options.lifecycle === "cancelled"
            ? { terminalAt: task.timestamps.terminalAt ?? now.toISOString() }
            : {}),
          updatedAt: now.toISOString(),
        },
        bindings: {
          ...task.bindings,
          harnessRunId,
        },
      });
  await deps.saveTask(updatedTask);
  await deps.recordDecision(
    buildForcedCancelDecision(
      updatedTask,
      options.decisionType,
      options.reason,
      controlReason,
      harnessRunId,
      controlAcknowledged,
      now,
      options.projection,
      options.additionalReasons,
    ),
  );
  await emitTaskAlert(deps, updatedTask, {
    ...options.alert,
    harnessRunId,
    message: controlAcknowledged
      ? options.alert.message
      : `${options.alert.message} Harness did not acknowledge the cancel request.`,
  });
  return result(task, {
    outcome: "advanced",
    lifecycle: options.lifecycle,
    healthy: false,
    reason: options.reason,
    ...(options.projection ? { projection: options.projection } : {}),
  });
}

function buildProjectionBinding(
  task: AgentTaskV1,
  harnessRunId: string,
  outboxBinding: RunBinding | undefined,
  read: HarnessRunReadSnapshot,
): HarnessProjectionBinding | undefined {
  const manifestRef = task.bindings?.runManifestRef
    ?? outboxBinding?.runManifestRef
    ?? manifestRefFromRead(read);
  const manifestHash = task.bindings?.runManifestHash
    ?? outboxBinding?.runManifestHash
    ?? manifestRef?.sha256;
  if (!manifestHash) return undefined;

  const observedCapabilities = read.events.flatMap((event) => {
    if (event.type !== "CapabilityDispatched") return [];
    const capability = stringField(event.payload, "capability")
      ?? stringField(event.payload, "capability_id");
    return capability ? [capability] : [];
  });
  const effectiveCapabilities = [...new Set([
    ...task.requestedAuthority.grants.map((grant) => grant.capabilityId),
    ...observedCapabilities,
  ])];
  const modelBindings = new Map<string, {
    role: string;
    adapter: string;
    provider: string;
    modelRef: string;
    profileHash: string;
  }>();
  for (const event of read.events) {
    if (event.type !== "ModelRequested") continue;
    const role = stringField(event.payload, "role");
    const modelRef = stringField(event.payload, "model_ref");
    if (!role || !modelRef || modelBindings.has(role)) continue;
    modelBindings.set(role, {
      role,
      adapter: "harness-observed",
      provider: "harness-observed",
      modelRef,
      profileHash: task.approval.policyHash,
    });
  }

  return {
    workItemId: task.workItemId,
    correlationId: task.correlationId,
    harnessRunId,
    taskVersion: task.taskVersion,
    repository: task.repository.nameWithOwner,
    title: task.proposal.title,
    summary: task.proposal.objective,
    registeredAt: task.timestamps.runBoundAt
      ?? outboxBinding?.boundAt
      ?? task.timestamps.dispatchClaimedAt
      ?? task.timestamps.updatedAt,
    staleAfterSeconds: 300,
    manifest: {
      ...(manifestRef ? { ref: manifestRef } : {}),
      hash: manifestHash,
      profile: task.intent.profile,
      riskClass: riskClassForTask(task),
      effectiveCapabilities,
      network: read.status.egressPolicy ?? task.requestedAuthority.network,
      policyHash: task.approval.policyHash,
      verifierHash: task.acceptance.verifierPlanHash,
      modelBindings: [...modelBindings.values()],
      skillVersions: [],
    },
    budget: {
      elapsedSecondsLimit: task.budget.elapsedSeconds,
      modelTokensLimit: task.budget.modelTokens,
      toolCallsLimit: task.budget.toolCalls,
      estimatedUsdMicrosLimit: task.budget.estimatedUsdMicros,
    },
    ...(task.bindings?.averrayJobId
      ? { averrayJobId: task.bindings.averrayJobId }
      : {}),
    ...(task.bindings?.averraySessionId
      ? { averraySessionId: task.bindings.averraySessionId }
      : {}),
    ...(task.bindings?.pullRequest
      ? { pullRequest: task.bindings.pullRequest }
      : {}),
  };
}

function exhaustedBudgetDimensions(
  projection: AgentRunProjectionV1,
): BudgetExhaustion[] {
  const candidates: Array<{
    dimension: BudgetDimension;
    used: number | undefined;
    limit: number | undefined;
  }> = [
    {
      dimension: "elapsed_seconds",
      used: projection.budget.elapsedSecondsUsed,
      limit: projection.budget.elapsedSecondsLimit,
    },
    {
      dimension: "model_tokens",
      used: projection.budget.modelTokensUsed,
      limit: projection.budget.modelTokensLimit,
    },
    {
      dimension: "tool_calls",
      used: projection.budget.toolCallsUsed,
      limit: projection.budget.toolCallsLimit,
    },
  ];
  const exhausted = candidates.flatMap(({ dimension, used, limit }) => {
    if (used === undefined || limit === undefined || used < limit) return [];
    return [{
      dimension,
      used,
      limit,
      overBy: used - limit,
    }];
  });
  if (projection.budget.exhausted && exhausted.length === 0) {
    throw new Error(
      "exhausted Harness budget did not identify a used and limit dimension",
    );
  }
  return exhausted;
}

function budgetDecisionReasons(exhaustions: BudgetExhaustion[]): string[] {
  return exhaustions.map(
    ({ dimension, used, limit, overBy }) =>
      `budget_exhaustion_dimension=${dimension} used=${used} limit=${limit} over_by=${overBy}`,
  );
}

function budgetAlertSummary(exhaustions: BudgetExhaustion[]): string {
  return `The approved Harness budget was exhausted: ${exhaustions.map(
    ({ dimension, used, limit, overBy }) =>
      `${dimension} used=${used} limit=${limit} over_by=${overBy}`,
  ).join("; ")}`;
}

function lifecycleForProjection(
  current: AgentTaskLifecycle,
  projection: AgentRunProjectionV1,
): AgentTaskLifecycle {
  if (projection.run.terminal) {
    const outcome = projection.run.outcome;
    if (outcome === undefined) {
      throw new Error("terminal Harness projection has no outcome");
    }
    switch (outcome) {
      case "completed":
        return projection.verification?.status === "passed"
          ? "handoff_ready"
          : "failed";
      case "partial":
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return assertNever(outcome);
    }
  }

  const state = projection.run.state;
  if (RUNNING_STATES.has(state)) return "running";
  if (VERIFYING_STATES.has(state)) return "verifying";
  if (state === "approval_required" || state === "suspended") {
    return "blocked";
  }
  if (state === "completed") {
    return projection.verification?.status === "passed"
      ? "handoff_ready"
      : "failed";
  }
  if (state === "partial" || state === "failed" || state === "quarantined") {
    return "failed";
  }
  if (CANCELLED_STATES.has(state)) return "cancelled";
  return current;
}

function isTerminalOutcome(
  value: AgentRunProjectionV1["run"]["outcome"],
): value is NonNullable<AgentRunProjectionV1["run"]["outcome"]> {
  return value === "completed"
    || value === "partial"
    || value === "failed"
    || value === "cancelled";
}

function assertNever(value: never): never {
  throw new Error(
    `terminal Harness projection has unknown outcome: ${String(value)}`,
  );
}

function taskWithProjectionFacts(
  task: AgentTaskV1,
  harnessRunId: string,
  lifecycle: AgentTaskLifecycle,
  projection: AgentRunProjectionV1,
  now: Date,
  outboxBinding: RunBinding | undefined,
): AgentTaskV1 {
  const updatedAt = now.toISOString();
  const terminal = lifecycle === "handoff_ready"
    || lifecycle === "failed"
    || lifecycle === "cancelled";
  const bindings: NonNullable<AgentTaskV1["bindings"]> = {
    ...task.bindings,
    harnessRunId,
    ...(projection.manifest.ref
      ? {
          runManifestRef: projection.manifest.ref,
          runManifestHash: projection.manifest.hash,
        }
      : {}),
  };
  const factsChanged = lifecycle !== task.lifecycle
    || JSON.stringify(bindings) !== JSON.stringify(task.bindings);
  if (!factsChanged) return task;
  return {
    ...task,
    lifecycle,
    timestamps: {
      ...task.timestamps,
      runBoundAt: task.timestamps.runBoundAt
        ?? outboxBinding?.boundAt
        ?? updatedAt,
      ...(terminal
        ? { terminalAt: task.timestamps.terminalAt ?? updatedAt }
        : {}),
      updatedAt,
    },
    bindings,
  };
}

export function buildVerifiedHandoff(
  task: AgentTaskV1,
  projection: AgentRunProjectionV1,
  read: HarnessRunReadSnapshot,
  now: Date,
): VerifiedHandoffV1 {
  const patchRef = deliverable(read, "workspace_patch");
  const summaryRef = requiredDeliverable(read, "change_summary");
  const verificationRef = projection.verification?.decisionRef
    ?? requiredDeliverable(read, "verification_report");
  const runManifestRef = projection.manifest.ref;
  if (!runManifestRef) {
    throw new Error("verified handoff requires an immutable run manifest ref");
  }
  const evidenceRefs = uniqueArtifacts([
    verificationRef,
    ...read.deliverables.map((item) => item.artifact),
  ]);
  const handoff = verifiedHandoffV1Schema.parse({
    schemaVersion: 1,
    kind: "verified_handoff",
    workItemId: task.workItemId,
    correlationId: task.correlationId,
    harnessRunId: projection.harnessRunId,
    taskVersion: task.taskVersion,
    taskHash: task.approval.approvedTaskHash,
    taskIntentRef: task.intent.templateRef,
    taskIntentHash: task.intent.templateHash,
    runManifestRef,
    runManifestHash: projection.manifest.hash,
    outcome: "completed",
    deliverables: {
      ...(patchRef ? { patchRef } : {}),
      summaryRef,
      structuredSubmissionRef: verificationRef,
      artifacts: uniqueArtifacts(read.deliverables.map((item) => item.artifact)),
    },
    checks: task.acceptance.criteria.map((criterion) => ({
      name: criterion.id,
      status: "passed",
      evidenceRef: verificationRef,
    })),
    verification: {
      verified: true,
      decision: "accept",
      verifier: {
        type: "verifier",
        id: "agent-harness-independent-verifier",
      },
      planHash: task.acceptance.verifierPlanHash,
      decisionRef: verificationRef,
      decisionHash: verificationRef.sha256,
      evidenceRefs,
      verifiedAt: read.status.updatedAt,
    },
    openQuestions: [],
    eligibleForPrOpen: true,
    generatedAt: now.toISOString(),
  });
  return handoff;
}

async function refuseTask(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  reason: string,
  alert?: Pick<
    DispatchAlert,
    "severity" | "code" | "harnessRunId" | "message"
  >,
): Promise<ReconcileResult> {
  const updatedAt = deps.now().toISOString();
  const blocked: AgentTaskV1 = {
    ...task,
    lifecycle: "blocked",
    timestamps: {
      ...task.timestamps,
      updatedAt,
    },
  };
  await deps.saveTask(blocked);
  await deps.recordDecision(
    buildReconcileDecision(
      blocked,
      "dispatch_refusal",
      reason,
      deps.now(),
    ),
  );
  await emitTaskAlert(
    deps,
    blocked,
    alert ?? {
      severity: "warn",
      code: "dispatch_refusal",
      message: `Harness reconciliation refused to proceed: ${reason}.`,
    },
  );
  return result(task, {
    outcome: "refused",
    lifecycle: "blocked",
    healthy: false,
    reason,
  });
}

function buildForcedCancelDecision(
  task: AgentTaskV1,
  decisionType: "dispatch_refusal" | "escalation",
  reason: string,
  controlReason: string,
  harnessRunId: string,
  controlAcknowledged: boolean,
  generatedAt: Date,
  projection?: AgentRunProjectionV1,
  additionalReasons: string[] = [],
): HermesDecisionRecordV2 {
  const approval = task.approval;
  const mutations: MutationRef[] = [{
    system: "agent-task",
    action: task.lifecycle,
    target: `${task.workItemId}@${task.taskVersion}`,
  }];
  if (controlAcknowledged) {
    mutations.push({
      system: "agent-harness",
      action: "cancel",
      target: harnessRunId,
      idempotencyKey: harnessRunId,
    });
  }
  return buildHermesDecisionRecordV2({
    correlationId: task.correlationId,
    workItemId: task.workItemId,
    decisionType,
    proposal: {
      what: decisionType === "escalation"
        ? "Stop active Harness work under the global HALT control."
        : "Refuse continued execution and stop the active Harness run.",
      why: [reason, controlReason, ...additionalReasons],
      evidenceRefs: uniqueArtifacts([
        ...task.proposal.sourceRefs,
        ...(projection?.artifacts ?? []),
      ]),
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
      mutates: true,
      mutations,
      authorityChanged: false,
      budgetChanged: false,
    },
    next: {
      action: controlAcknowledged
        ? "Operator reviews the stopped task before any new task version."
        : "Operator verifies that the Harness run stopped before any new task version.",
      owner: "operator",
      blockedBy: controlAcknowledged
        ? [reason]
        : [reason, controlReason],
    },
    generatedAt,
  });
}

function buildReconcileDecision(
  task: AgentTaskV1,
  decisionType: "dispatch_refusal" | "anomaly_pause" | "handoff",
  reason: string,
  generatedAt: Date,
  evidenceRefs: ArtifactRef[] = [],
  projection?: AgentRunProjectionV1,
  additionalReasons: string[] = [],
  actuation?: {
    mutations: MutationRef[];
    proposal: string;
    nextAction: string;
  },
): HermesDecisionRecordV2 {
  const approval = task.approval;
  const inputs: Array<{
    name: string;
    ref?: ArtifactRef;
    hash?: string;
    observedAt?: string;
  }> = [{
    name: "approved-task",
    ...(approval.approvedTaskHash
      ? { hash: approval.approvedTaskHash }
      : {}),
    observedAt: generatedAt.toISOString(),
  }];
  if (projection?.manifest.ref) {
    inputs.push({
      name: "run-manifest",
      ref: projection.manifest.ref,
      hash: projection.manifest.hash,
      observedAt: projection.source.observedAt,
    });
  }
  if (projection?.verification?.decisionRef) {
    inputs.push({
      name: "verification-decision",
      ref: projection.verification.decisionRef,
      hash: projection.verification.decisionHash,
      observedAt: projection.source.observedAt,
    });
  }
  const mutations = actuation?.mutations ?? [];
  return buildHermesDecisionRecordV2({
    correlationId: task.correlationId,
    workItemId: task.workItemId,
    decisionType,
    proposal: {
      what: actuation?.proposal ?? (decisionType === "handoff"
        ? "Record a verified handoff for operator review."
        : "Pause supervised execution for operator review."),
      why: [reason, ...additionalReasons],
      evidenceRefs: uniqueArtifacts([
        ...task.proposal.sourceRefs,
        ...evidenceRefs,
      ]),
    },
    inputs,
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
      mutates: mutations.length > 0,
      mutations,
      authorityChanged: false,
      budgetChanged: false,
    },
    next: {
      action: actuation?.nextAction ?? (decisionType === "handoff"
        ? "Operator reviews the verified handoff; no PR is opened automatically."
        : "Operator reviews the blocked task before any further action."),
      owner: "operator",
      ...(decisionType === "handoff" ? {} : { blockedBy: [reason] }),
    },
    generatedAt,
  });
}

function degradedRead(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  error: unknown,
): ReconcileResult {
  const readError = asHarnessReadError(error);
  const reason = readError
    ? `${readError.code}: ${readError.message}`
    : `read_failed: ${safeErrorMessage(error)}`;
  return degradedResult(
    deps,
    task,
    reason,
    "Harness run read is degraded",
  );
}

function degradedResult(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  reason: string,
  message: string,
  projection?: AgentRunProjectionV1,
): ReconcileResult {
  deps.logger?.warn({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    reason,
  }, message);
  return result(task, {
    outcome: "read_degraded",
    healthy: false,
    reason,
    ...(projection ? { projection } : {}),
  });
}

function result(
  task: AgentTaskV1,
  patch: Omit<
    ReconcileResult,
    "workItemId" | "taskVersion" | "previousLifecycle" | "lifecycle"
  > & { lifecycle?: AgentTaskLifecycle },
): ReconcileResult {
  return {
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    previousLifecycle: task.lifecycle,
    lifecycle: patch.lifecycle ?? task.lifecycle,
    ...patch,
  };
}

function intendedRunIdForDispatching(task: AgentTaskV1): string | undefined {
  if (task.lifecycle !== "dispatching") return undefined;
  return intendedRunIdForAmbiguousTask(task);
}

function intendedRunIdForAmbiguousTask(
  task: AgentTaskV1,
): string | undefined {
  if (!task.timestamps.dispatchClaimedAt) return undefined;
  const approvedTaskHash = task.approval.approvedTaskHash;
  return approvedTaskHash
    ? deriveIntendedRunId(task.workItemId, task.taskVersion, approvedTaskHash)
    : undefined;
}

function manifestRefFromRead(
  read: HarnessRunReadSnapshot,
): ArtifactRef | undefined {
  for (const event of [...read.events].reverse()) {
    if (event.type !== "EnvironmentPrepared") continue;
    const hash = stringField(event.payload, "manifest_hash");
    const digest = /^sha256:([a-f0-9]{64})$/.exec(hash ?? "")?.[1];
    if (!digest) continue;
    return artifactRefSchema.parse({
      uri: `artifact://sha256/${digest}`,
      sha256: `sha256:${digest}`,
      mediaType: "application/json",
    });
  }
  return undefined;
}

function riskClassForTask(
  task: AgentTaskV1,
): HarnessProjectionBinding["manifest"]["riskClass"] {
  if (task.risk.tier === "low") return "low";
  if (task.risk.tier === "medium") return "standard";
  return "elevated";
}

function deliverable(
  read: HarnessRunReadSnapshot,
  type: string,
): ArtifactRef | undefined {
  return read.deliverables.find((item) => item.deliverableType === type)
    ?.artifact;
}

function requiredDeliverable(
  read: HarnessRunReadSnapshot,
  type: string,
): ArtifactRef {
  const artifact = deliverable(read, type);
  if (!artifact) {
    throw new Error(`verified handoff is missing ${type}`);
  }
  return artifact;
}

function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [...new Map(
    artifacts.map((artifact) => [artifact.uri, artifact] as const),
  ).values()];
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function isRunMissing(error: unknown): boolean {
  return asHarnessReadError(error)?.code === "run_not_started";
}

function asHarnessReadError(
  error: unknown,
): Pick<HarnessReadError, "code" | "message" | "retryable"> | undefined {
  if (error instanceof HarnessReadError) return error;
  if (
    error instanceof Error
    && error.name === "HarnessReadError"
    && "code" in error
    && typeof error.code === "string"
    && "retryable" in error
    && typeof error.retryable === "boolean"
  ) {
    return error as HarnessReadError;
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown reconciliation error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function harnessControlErrorCode(
  error: unknown,
): HarnessControlError["code"] | undefined {
  if (error instanceof HarnessControlError) return error.code;
  if (
    error instanceof Error
    && error.name === "HarnessControlError"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code as HarnessControlError["code"];
  }
  return undefined;
}

async function emitTaskAlert(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  alert: Pick<
    DispatchAlert,
    "severity" | "code" | "message" | "harnessRunId"
  >,
): Promise<void> {
  await deps.alertSink({
    ...alert,
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    at: deps.now().toISOString(),
  });
}
