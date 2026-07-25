import {
  assertAgentRunProjectionWithinTask,
  assertVerifiedHandoffMatchesTaskAndRun,
  artifactRefSchema,
  verifiedHandoffV1Schema,
  type AgentRunProjectionV1,
  type AgentTaskLifecycle,
  type AgentTaskV1,
  type ArtifactRef,
  type HarnessRunState,
  type HermesDecisionRecordV2,
  type VerifiedHandoffV1,
} from "@avg/schemas";
import {
  deriveIntendedRunId,
} from "@avg/averray-mcp/dispatch-claim";
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

export interface ReconcileLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ReconcileRunDeps {
  now(): Date;
  isHalted(): boolean;
  listTasks(): Promise<AgentTaskV1[]>;
  saveTask(task: AgentTaskV1): Promise<unknown>;
  getRunBinding(workItemId: string): Promise<RunBinding | undefined>;
  bindRun(input: BindRunInput): Promise<unknown>;
  readPort: HarnessReadPort;
  recordDecision(record: HermesDecisionRecordV2): Promise<unknown>;
  logger?: ReconcileLogger;
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
    | "refused"
    | "handoff_ready";
  previousLifecycle: AgentTaskLifecycle;
  lifecycle: AgentTaskLifecycle;
  healthy: boolean;
  reason?: string;
  projection?: AgentRunProjectionV1;
  handoff?: VerifiedHandoffV1;
}

export async function reconcileDispatchedRuns(
  deps: ReconcileRunDeps,
): Promise<ReconcileResult[]> {
  if (deps.isHalted()) return [];

  const tasks = (await deps.listTasks()).filter(isReconcileCandidate);
  const results: ReconcileResult[] = [];
  for (const task of tasks) {
    if (deps.isHalted()) break;
    results.push(
      isAmbiguousSubmitCandidate(task)
        ? await recoverAmbiguousSubmit(deps, task)
        : await reconcileTask(deps, task),
    );
  }
  return results;
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
  return result(task, {
    outcome: "recovered",
    lifecycle: "running",
    healthy: true,
    reason: "submit_ambiguous_run_recovered",
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
    return degradedRead(deps, task, error);
  }

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

  let projection: AgentRunProjectionV1;
  try {
    projection = (deps.projectRun ?? projectHarnessRun)(
      projectionBinding,
      read,
      { now: deps.now() },
    );
    assertAgentRunProjectionWithinTask(task, projection);
  } catch (error) {
    return refuseTask(
      deps,
      task,
      `projection_containment_failed: ${safeErrorMessage(error)}`,
    );
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

  if (
    projection.run.state === "approval_required"
    || projection.run.state === "suspended"
  ) {
    await deps.saveTask(updatedTask);
    const reason = `unexpected_harness_state_${projection.run.state}`;
    await deps.recordDecision(
      buildReconcileDecision(
        updatedTask,
        "anomaly_pause",
        reason,
        deps.now(),
        projection.artifacts,
      ),
    );
    alert(deps, updatedTask, reason);
    return result(task, {
      outcome: "advanced",
      lifecycle: "blocked",
      healthy: false,
      reason,
      projection,
    });
  }

  if (projection.run.state === "quarantined") {
    alert(deps, updatedTask, "harness_run_quarantined");
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
    healthy: projection.run.state !== "quarantined",
    ...(projection.run.state === "quarantined"
      ? { reason: "harness_run_quarantined" }
      : {}),
    projection,
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

function lifecycleForProjection(
  current: AgentTaskLifecycle,
  projection: AgentRunProjectionV1,
): AgentTaskLifecycle {
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

function buildVerifiedHandoff(
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
  alert(deps, blocked, reason);
  return result(task, {
    outcome: "refused",
    lifecycle: "blocked",
    healthy: false,
    reason,
  });
}

function buildReconcileDecision(
  task: AgentTaskV1,
  decisionType: "dispatch_refusal" | "anomaly_pause" | "handoff",
  reason: string,
  generatedAt: Date,
  evidenceRefs: ArtifactRef[] = [],
  projection?: AgentRunProjectionV1,
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
  return buildHermesDecisionRecordV2({
    correlationId: task.correlationId,
    workItemId: task.workItemId,
    decisionType,
    proposal: {
      what: decisionType === "handoff"
        ? "Record a verified handoff for operator review."
        : "Pause supervised execution for operator review.",
      why: [reason],
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
      mutates: false,
      mutations: [],
      authorityChanged: false,
      budgetChanged: false,
    },
    next: {
      action: decisionType === "handoff"
        ? "Operator reviews the verified handoff; no PR is opened automatically."
        : "Operator reviews the blocked task before any further action.",
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
): Pick<HarnessReadError, "code" | "message"> | undefined {
  if (error instanceof HarnessReadError) return error;
  if (
    error instanceof Error
    && error.name === "HarnessReadError"
    && "code" in error
    && typeof error.code === "string"
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

function alert(
  deps: ReconcileRunDeps,
  task: AgentTaskV1,
  reason: string,
): void {
  deps.logger?.warn({
    alert: true,
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    reason,
  }, "ALERT: Harness run reconciliation requires operator attention");
}
