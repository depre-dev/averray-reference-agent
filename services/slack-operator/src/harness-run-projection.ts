import {
  agentRunProjectionV1Schema,
  artifactRefSchema,
  type AgentRunProjectionV1,
  type ArtifactRef,
  type HarnessRunState,
} from "@avg/schemas";

import {
  HarnessReadError,
  type HarnessEventRead,
  type HarnessReadPort,
  type HarnessRunReadSnapshot,
} from "./harness-read-port.js";
import type {
  HarnessRunBinding,
  HarnessRunRegistry,
} from "./harness-run-registry.js";

export interface HarnessRunBoardProjection {
  binding: Pick<
    HarnessRunBinding,
    "workItemId" | "correlationId" | "harnessRunId" | "repository" | "title" | "summary"
  >;
  projection: AgentRunProjectionV1;
}

export interface HarnessProjectionFailure {
  binding: Pick<
    HarnessRunBinding,
    "workItemId" | "correlationId" | "harnessRunId" | "repository" | "title" | "summary"
  >;
  code: string;
  message: string;
  retryable: boolean;
  observedAt: string;
}

export interface HarnessProjectionSnapshot {
  schemaVersion: 1;
  kind: "harness_projection_snapshot";
  enabled: true;
  observedAt: string;
  items: HarnessRunBoardProjection[];
  failures: HarnessProjectionFailure[];
}

export class HarnessProjectionError extends Error {
  constructor(
    readonly code: "manifest_mismatch" | "projection_invalid",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HarnessProjectionError";
  }
}

export async function collectHarnessRunProjections(
  registry: HarnessRunRegistry,
  port: HarnessReadPort,
  options: { now?: Date } = {},
): Promise<HarnessProjectionSnapshot> {
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  const items: HarnessRunBoardProjection[] = [];
  const failures: HarnessProjectionFailure[] = [];

  // The pilot registry is intentionally small. Reading sequentially avoids an
  // operator typo turning the monitor refresh into an unbounded CLI fan-out.
  for (const binding of registry.bindings) {
    const presentation = presentationFor(binding);
    try {
      const read = await port.readRun(binding);
      items.push({
        binding: presentation,
        projection: projectHarnessRun(binding, read, { now }),
      });
    } catch (error) {
      const known = error instanceof HarnessReadError || error instanceof HarnessProjectionError;
      failures.push({
        binding: presentation,
        code: known ? error.code : "projection_failed",
        message: known ? error.message : "Harness run projection failed",
        retryable: known ? error.retryable : true,
        observedAt,
      });
    }
  }

  return {
    schemaVersion: 1,
    kind: "harness_projection_snapshot",
    enabled: true,
    observedAt,
    items,
    failures,
  };
}

export function projectHarnessRun(
  binding: HarnessRunBinding,
  read: HarnessRunReadSnapshot,
  options: { now?: Date } = {},
): AgentRunProjectionV1 {
  const now = options.now ?? new Date();
  assertManifestMatchesLiveRead(binding, read);

  const terminal = read.status.outcome !== undefined;
  const sourceUpdatedAtMs = Date.parse(read.status.updatedAt);
  const rawAgeSeconds = Math.floor((now.getTime() - sourceUpdatedAtMs) / 1_000);
  const ageSeconds = Math.max(0, rawAgeSeconds);
  const clockAhead = rawAgeSeconds < -5;
  const stale = !terminal && ageSeconds > binding.staleAfterSeconds;
  const sourceHealth = clockAhead ? "degraded" : stale ? "stale" : "healthy";
  const sourceReason = clockAhead
    ? "Harness source timestamp is ahead of the monitor clock"
    : stale
      ? `Harness source has not updated for ${ageSeconds} seconds`
      : undefined;
  const verification = verificationFromEvents(read.events);
  const artifacts = artifactsFromRead(read);
  const failure = failureFromRead(read);
  const budget = budgetFromRead(binding, read);
  const progress = progressFor(read.status.state, read.events.length, read.status.outcomeReason);
  const bindings = {
    harnessRunId: binding.harnessRunId,
    ...(binding.manifest.ref
      ? {
          runManifestRef: binding.manifest.ref,
          runManifestHash: binding.manifest.hash,
        }
      : {}),
    ...(binding.averrayJobId ? { averrayJobId: binding.averrayJobId } : {}),
    ...(binding.averraySessionId ? { averraySessionId: binding.averraySessionId } : {}),
    ...(binding.pullRequest ? { pullRequest: binding.pullRequest } : {}),
  };

  const candidate: AgentRunProjectionV1 = {
    schemaVersion: 1,
    kind: "agent_run_projection",
    workItemId: binding.workItemId,
    correlationId: binding.correlationId,
    harnessRunId: binding.harnessRunId,
    taskVersion: binding.taskVersion,
    source: {
      system: "agent-harness",
      health: sourceHealth,
      observedAt: now.toISOString(),
      sourceUpdatedAt: read.status.updatedAt,
      ...(sourceReason ? { reason: sourceReason } : {}),
    },
    heartbeat: {
      status: terminal ? "terminal" : stale ? "stale" : "active",
      ageSeconds,
    },
    run: {
      state: read.status.state,
      attempt: read.status.attempt,
      terminal,
      ...(read.status.outcome ? { outcome: read.status.outcome } : {}),
      ...(read.status.outcomeReason ? { reason: sanitizeProjectionText(read.status.outcomeReason) } : {}),
    },
    manifest: binding.manifest,
    progress,
    budget,
    artifacts,
    verification,
    ...(failure ? { failure } : {}),
    bindings,
  };

  const parsed = agentRunProjectionV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new HarnessProjectionError(
      "projection_invalid",
      `Harness run could not be represented by AgentRunProjection v1: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

function assertManifestMatchesLiveRead(
  binding: HarnessRunBinding,
  read: HarnessRunReadSnapshot,
): void {
  if (read.status.egressPolicy !== undefined
      && !networkPoliciesMatch(read.status.egressPolicy, binding.manifest.network)) {
    throw new HarnessProjectionError(
      "manifest_mismatch",
      "Harness live egress policy does not match the pinned pilot manifest",
    );
  }
  for (const event of read.events) {
    if (event.type === "ContractCompiled") {
      const riskClass = stringField(event.payload, "risk_class");
      if (riskClass && riskClass !== binding.manifest.riskClass) {
        throw new HarnessProjectionError(
          "manifest_mismatch",
          "Harness compiled risk class does not match the pinned pilot manifest",
        );
      }
    }
    if (event.type === "ModelRequested") {
      const role = stringField(event.payload, "role");
      const modelRef = stringField(event.payload, "model_ref");
      if (!role || !modelRef) continue;
      const pinned = binding.manifest.modelBindings.find((model) => model.role === role);
      if (!pinned || pinned.modelRef !== modelRef) {
        throw new HarnessProjectionError(
          "manifest_mismatch",
          "Harness model binding does not match the pinned pilot manifest",
        );
      }
    }
  }
}

function networkPoliciesMatch(
  live: NonNullable<HarnessRunReadSnapshot["status"]["egressPolicy"]>,
  pinned: HarnessRunBinding["manifest"]["network"],
): boolean {
  if (live === "deny" || pinned === "deny") return live === pinned;
  const liveDestinations = [...live.allowlist].sort();
  const pinnedDestinations = [...pinned.allowlist].sort();
  return liveDestinations.length === pinnedDestinations.length
    && liveDestinations.every((value, index) => value === pinnedDestinations[index]);
}

function budgetFromRead(
  binding: HarnessRunBinding,
  read: HarnessRunReadSnapshot,
): AgentRunProjectionV1["budget"] {
  const elapsedSecondsUsed = Math.max(
    0,
    Math.floor((Date.parse(read.status.updatedAt) - Date.parse(read.status.createdAt)) / 1_000),
  );
  let modelTokensUsed = 0;
  let modelUsageComplete = true;
  let toolCallsUsed = 0;
  for (const event of read.events) {
    if (event.type === "ModelResponded") {
      const usage = recordField(event.payload, "usage");
      const inputTokens = optionalNonNegativeIntegerField(usage, "input_tokens");
      const outputTokens = optionalNonNegativeIntegerField(usage, "output_tokens");
      if (inputTokens === undefined || outputTokens === undefined) modelUsageComplete = false;
      else modelTokensUsed += inputTokens + outputTokens;
    }
    if (event.type === "CapabilityDispatched") toolCallsUsed += 1;
  }
  const exhausted = (
    binding.budget.elapsedSecondsLimit !== undefined
      && elapsedSecondsUsed >= binding.budget.elapsedSecondsLimit
  ) || (
    modelUsageComplete
      && binding.budget.modelTokensLimit !== undefined
      && modelTokensUsed >= binding.budget.modelTokensLimit
  ) || (
    binding.budget.toolCallsLimit !== undefined
      && toolCallsUsed >= binding.budget.toolCallsLimit
  );
  return {
    elapsedSecondsUsed,
    ...(binding.budget.elapsedSecondsLimit !== undefined
      ? { elapsedSecondsLimit: binding.budget.elapsedSecondsLimit }
      : {}),
    ...(modelUsageComplete ? { modelTokensUsed } : {}),
    ...(binding.budget.modelTokensLimit !== undefined
      ? { modelTokensLimit: binding.budget.modelTokensLimit }
      : {}),
    toolCallsUsed,
    ...(binding.budget.toolCallsLimit !== undefined
      ? { toolCallsLimit: binding.budget.toolCallsLimit }
      : {}),
    ...(binding.budget.estimatedUsdMicrosLimit !== undefined
      ? { estimatedUsdMicrosLimit: binding.budget.estimatedUsdMicrosLimit }
      : {}),
    exhausted,
  };
}

function artifactsFromRead(read: HarnessRunReadSnapshot): ArtifactRef[] {
  const artifacts = new Map<string, ArtifactRef>();
  for (const deliverable of read.deliverables) {
    artifacts.set(deliverable.artifact.uri, deliverable.artifact);
  }
  for (const event of read.events) {
    if (event.type !== "ArtifactCreated") continue;
    const uri = stringField(event.payload, "artifact_uri");
    const artifact = artifactFromUri(uri);
    if (!uri || !artifact) {
      throw new HarnessProjectionError(
        "projection_invalid",
        "Harness ArtifactCreated event has an unsupported artifact reference",
      );
    }
    const declaredHash = stringField(event.payload, "artifact_hash");
    if (declaredHash && declaredHash !== artifact.sha256) {
      throw new HarnessProjectionError(
        "projection_invalid",
        "Harness ArtifactCreated hash does not match its artifact reference",
      );
    }
    artifacts.set(artifact.uri, artifact);
  }
  return [...artifacts.values()].sort((left, right) => left.uri.localeCompare(right.uri));
}

function verificationFromEvents(
  events: HarnessEventRead[],
): AgentRunProjectionV1["verification"] {
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "VerificationCompleted"
    && stringField(candidate.payload, "scope") !== "plan_node"
  );
  if (!event) return { status: "pending" };
  const passed = booleanField(event.payload, "passed");
  const verdict = stringField(event.payload, "verdict");
  const status = passed === true
    ? "passed"
    : passed === false
      ? verdict === "failed" || verdict === "partial"
        ? "failed"
        : "inconclusive"
      : "inconclusive";
  const reportUri = stringField(event.payload, "report_ref");
  const decisionRef = artifactFromUri(reportUri);
  if (reportUri && !decisionRef) {
    throw new HarnessProjectionError(
      "projection_invalid",
      "Harness verification report has an unsupported artifact reference",
    );
  }
  return {
    status,
    ...(decisionRef
      ? {
          decisionRef,
          decisionHash: decisionRef.sha256,
        }
      : {}),
  };
}

function failureFromRead(
  read: HarnessRunReadSnapshot,
): AgentRunProjectionV1["failure"] {
  if (
    read.status.state !== "failed"
    && read.status.state !== "quarantined"
    && read.status.outcome !== "failed"
  ) return undefined;
  const completed = [...read.events].reverse().find((event) => event.type === "RunCompleted");
  const eventReason = stringField(completed?.payload, "reason");
  const reason = read.status.outcomeReason || eventReason || `${read.status.state} without a recorded reason`;
  return {
    code: failureCode(reason, read.status.state),
    message: sanitizeProjectionText(reason),
    retryable: retryableFailure(reason),
  };
}

function progressFor(
  state: HarnessRunState,
  eventCount: number,
  outcomeReason?: string,
): AgentRunProjectionV1["progress"] {
  const summaries: Record<HarnessRunState, string> = {
    accepted: "Harness accepted the bounded task.",
    contract_compiled: "Harness compiled the immutable run contract.",
    environment_preparing: "Harness is preparing the isolated environment.",
    environment_ready: "Harness prepared the isolated environment.",
    strategy_selected: "Harness selected the execution strategy.",
    executing: "Harness is executing the bounded task.",
    verifying: "Harness is verifying the recorded deliverables.",
    repairing: "Harness is repairing a failed verification.",
    replanning: "Harness is replanning within the approved contract.",
    approval_required: "Harness paused at an approval boundary.",
    suspended: "Harness suspended the run.",
    finalizing: "Harness is finalizing immutable deliverables.",
    completed: "Harness completed the bounded run.",
    partial: "Harness completed the run with a partial outcome.",
    failed: "Harness recorded a failed run.",
    cancel_requested: "Harness is processing a cancellation request.",
    compensating: "Harness is applying bounded compensation.",
    cancelled: "Harness recorded a cancelled run.",
    quarantined: "Harness quarantined the run.",
    learning_queued: "Harness queued post-run learning.",
    learning_processed: "Harness processed post-run learning.",
  };
  const blocker = state === "approval_required"
    || state === "suspended"
    || state === "quarantined"
    || state === "failed"
    ? sanitizeProjectionText(outcomeReason || summaries[state])
    : undefined;
  return {
    phase: state,
    summary: summaries[state],
    completedUnits: eventCount,
    ...(blocker ? { blocker } : {}),
  };
}

function artifactFromUri(uri: string | undefined): ArtifactRef | undefined {
  if (!uri) return undefined;
  const digest = /^artifact:\/\/sha256\/([a-f0-9]{64})$/.exec(uri)?.[1];
  if (!digest) return undefined;
  const result = artifactRefSchema.safeParse({ uri, sha256: `sha256:${digest}` });
  return result.success ? result.data : undefined;
}

function presentationFor(binding: HarnessRunBinding): HarnessRunBoardProjection["binding"] {
  return {
    workItemId: binding.workItemId,
    correlationId: binding.correlationId,
    harnessRunId: binding.harnessRunId,
    repository: binding.repository,
    title: binding.title,
    ...(binding.summary ? { summary: binding.summary } : {}),
  };
}

function recordField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeIntegerField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function failureCode(reason: string, state: HarnessRunState): string {
  const normalized = reason.toLowerCase();
  if (/verification/.test(normalized)) return "verification_failed";
  if (/safety|tripwire|quarantin/.test(normalized)) return "safety_tripwire_triggered";
  if (/policy[_ -]?denied/.test(normalized)) return "policy_denied";
  if (/approval[_ -]?denied/.test(normalized)) return "approval_denied";
  if (/invalid[_ -]?contract/.test(normalized)) return "invalid_contract";
  if (/timed?[_ -]?out|timeout/.test(normalized)) return "timeout";
  return `harness_${state}`;
}

function retryableFailure(reason: string): boolean {
  return !/(?:policy_denied|approval_denied|safety|quarantin|invalid_contract|protected)/i.test(reason);
}

function sanitizeProjectionText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|database[_-]?url|dsn)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "Harness recorded no safe failure detail";
}
