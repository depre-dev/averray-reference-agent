import { readFile } from "node:fs/promises";

import {
  agentRunProjectionV1Schema,
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  type AgentRunProjectionV1,
  type AgentTaskLifecycle,
  type AgentTaskV1,
  type HarnessRunState,
} from "@avg/schemas";
import {
  deriveIntendedRunId,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  HarnessReadError,
  type HarnessRunReadSnapshot,
} from "../../packages/averray-mcp/src/harness-read-port.js";
import {
  createDispatcherProcess,
  type DispatcherConfig,
  type DispatcherHeartbeat,
  type DispatcherProcessDeps,
} from "../../services/harness-dispatcher/src/index.js";
import {
  reconcileDispatchedRuns,
  type ReconcileResult,
  type ReconcileRunDeps,
} from "../../services/harness-dispatcher/src/reconcile-run.js";
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-07-25T12:30:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_HASH =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const MANIFEST_REF = {
  uri: "artifact://sha256/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  sha256: MANIFEST_HASH,
  mediaType: "application/json",
} as const;

describe("dispatched Harness run reconciliation", () => {
  it.each([
    ["accepted", "running"],
    ["contract_compiled", "running"],
    ["environment_preparing", "running"],
    ["environment_ready", "running"],
    ["strategy_selected", "running"],
    ["executing", "running"],
    ["verifying", "verifying"],
    ["repairing", "verifying"],
    ["replanning", "verifying"],
    ["finalizing", "verifying"],
    ["approval_required", "blocked"],
    ["suspended", "blocked"],
    ["completed", "handoff_ready"],
    ["partial", "failed"],
    ["failed", "failed"],
    ["quarantined", "blocked"],
    ["cancel_requested", "cancelled"],
    ["compensating", "cancelled"],
    ["cancelled", "cancelled"],
    ["learning_queued", "running"],
    ["learning_processed", "running"],
  ] satisfies Array<[HarnessRunState, AgentTaskLifecycle]>)(
    "projects Harness state %s to AgentTask lifecycle %s",
    async (state, expectedLifecycle) => {
      const task = await runningTask();
      const deps = reconcileDeps(task, snapshot(state, {
        verificationPassed: state === "completed",
      }));

      const [reconciled] = await reconcileDispatchedRuns(deps);

      expect(reconciled?.lifecycle).toBe(expectedLifecycle);
      if (expectedLifecycle !== task.lifecycle) {
        expect(savedTasks(deps).at(-1)?.lifecycle).toBe(expectedLifecycle);
      }
      if (
        state === "approval_required"
        || state === "suspended"
        || state === "quarantined"
      ) {
        expect(recordedDecisions(deps).at(-1)?.decisionType)
          .toBe("dispatch_refusal");
        expect(reconciled?.healthy).toBe(false);
        expect(deps.controlPort.cancel).toHaveBeenCalledWith(RUN_ID);
        expect(deps.alertSink).toHaveBeenCalledOnce();
        expect(deps.alertSink).toHaveBeenCalledWith(
          expect.objectContaining({
            severity: "critical",
            code: state === "approval_required"
              ? "approval_required"
              : state === "suspended"
                ? "run_suspended"
                : "run_quarantined",
          }),
        );
      }
      if (state === "quarantined") {
        expect(deps.alertSink).toHaveBeenCalledWith(
          expect.objectContaining({
            code: "run_quarantined",
            severity: "critical",
          }),
        );
      }
    },
  );

  it.each([
    {
      name: "capability",
      mutate(projection: AgentRunProjectionV1): AgentRunProjectionV1 {
        return agentRunProjectionV1Schema.parse({
          ...projection,
          manifest: {
            ...projection.manifest,
            effectiveCapabilities: [
              ...projection.manifest.effectiveCapabilities,
              "shell.root",
            ],
          },
        });
      },
    },
    {
      name: "network",
      mutate(projection: AgentRunProjectionV1): AgentRunProjectionV1 {
        return agentRunProjectionV1Schema.parse({
          ...projection,
          manifest: {
            ...projection.manifest,
            network: { allowlist: ["expanded.example"] },
          },
        });
      },
    },
    {
      name: "budget",
      mutate(projection: AgentRunProjectionV1): AgentRunProjectionV1 {
        return agentRunProjectionV1Schema.parse({
          ...projection,
          budget: {
            ...projection.budget,
            elapsedSecondsLimit: 1_801,
          },
        });
      },
    },
  ])("blocks and alerts on $name containment expansion", async ({ mutate }) => {
    const task = await runningTask();
    const read = snapshot("executing");
    const expanded = mutate(projectionFor(task, "executing"));
    const deps = reconcileDeps(task, read, {
      projectRun: vi.fn(() => expanded),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "blocked",
      healthy: false,
    });
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("blocked");
    expect(recordedDecisions(deps).at(-1)).toMatchObject({
      decisionType: "dispatch_refusal",
      next: { owner: "operator" },
    });
    expect(recordedDecisions(deps).at(-1)?.proposal.why[0])
      .toContain("projection_containment_failed");
    expect(deps.controlPort.cancel).toHaveBeenCalledWith(RUN_ID);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "containment_expansion",
        severity: "critical",
      }),
    );
  });

  it("cancels and fails an overdue non-terminal task with one alert", async () => {
    const task = agentTaskV1Schema.parse({
      ...await runningTask(),
      deadline: "2026-07-25T12:29:59.000Z",
    });
    const deps = reconcileDeps(task, snapshot("executing"));

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "failed",
      healthy: false,
      reason: "deadline_exceeded",
    });
    expect(deps.readPort.readRun).not.toHaveBeenCalled();
    expect(deps.controlPort.cancel).toHaveBeenCalledOnce();
    expect(deps.controlPort.cancel).toHaveBeenCalledWith(RUN_ID);
    expect(savedTasks(deps).at(-1)).toMatchObject({
      lifecycle: "failed",
      timestamps: { terminalAt: NOW.toISOString() },
    });
    expect(recordedDecisions(deps).at(-1)).toMatchObject({
      decisionType: "dispatch_refusal",
      proposal: {
        why: ["deadline_exceeded", "harness_cancel_acknowledged"],
      },
    });
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "deadline_exceeded",
      }),
    );
  });

  it("cancels and fails a budget-exhausted run with one alert", async () => {
    const task = await runningTask();
    const projection = projectionFor(task, "executing");
    const exhausted = agentRunProjectionV1Schema.parse({
      ...projection,
      budget: {
        ...projection.budget,
        elapsedSecondsUsed: task.budget.elapsedSeconds,
        exhausted: true,
      },
    });
    const deps = reconcileDeps(task, snapshot("executing"), {
      projectRun: vi.fn(() => exhausted),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "failed",
      healthy: false,
      reason: "budget_exhausted",
    });
    expect(deps.controlPort.cancel).toHaveBeenCalledOnce();
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("failed");
    expect(recordedDecisions(deps).at(-1)?.proposal.why).toEqual([
      "budget_exhausted",
      "harness_cancel_acknowledged",
    ]);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "budget_exhausted",
      }),
    );
  });

  it("treats an ApprovalPacket event as a cancel-and-block anomaly", async () => {
    const task = await runningTask();
    const read = snapshot("executing");
    read.events.push({
      seq: 3,
      type: "ApprovalRequested",
      payload: { capability: "external_effect" },
    });
    const deps = reconcileDeps(task, read);

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      lifecycle: "blocked",
      healthy: false,
      reason: "approval_packet_detected",
    });
    expect(deps.controlPort.cancel).toHaveBeenCalledWith(RUN_ID);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "approval_packet_detected",
      }),
    );
  });

  it("cancels one live bound run on HALT and never dispatches", async () => {
    const task = await runningTask();
    const deps = reconcileDeps(task, snapshot("executing"), {
      isHalted: vi.fn(() => true),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "cancelled",
      healthy: false,
      reason: "halt_active_run_cancelled",
    });
    expect(deps.controlPort.cancel).toHaveBeenCalledOnce();
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("cancelled");
    expect(recordedDecisions(deps).at(-1)?.decisionType).toBe("escalation");
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "halt_active_run_cancelled",
      }),
    );
    expect("submit" in deps.controlPort).toBe(false);
  });

  it("marks completed-but-unverified work failed without a handoff", async () => {
    const task = await runningTask();
    const deps = reconcileDeps(
      task,
      snapshot("completed", { verificationPassed: false }),
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "failed",
      healthy: true,
    });
    expect(reconciled?.handoff).toBeUndefined();
    expect(recordedDecisions(deps).filter(
      (record) => record.decisionType === "handoff",
    )).toEqual([]);
  });

  it("constructs an asserted VerifiedHandoff without any actuation path", async () => {
    const task = await runningTask();
    const deps = reconcileDeps(
      task,
      snapshot("completed", { verificationPassed: true }),
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "handoff_ready",
      lifecycle: "handoff_ready",
      healthy: true,
      handoff: {
        kind: "verified_handoff",
        eligibleForPrOpen: true,
        verification: {
          verified: true,
          decision: "accept",
        },
      },
    });
    expect(recordedDecisions(deps).at(-1)).toMatchObject({
      decisionType: "handoff",
      next: { owner: "operator" },
      effects: {
        mutates: false,
        authorityChanged: false,
        budgetChanged: false,
      },
    });

    const moduleSource = await readFile(
      new URL(
        "../../services/harness-dispatcher/src/reconcile-run.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(moduleSource).not.toMatch(
      /\.(?:submit|approve|deny|release|openPullRequest)\s*\(/,
    );
    expect(moduleSource).not.toMatch(/\baverray_(?:claim|submit)\b/i);
    expect(moduleSource).not.toContain("@octokit");
  });

  it("recovers an existing ambiguous submit by binding only", async () => {
    const task = await ambiguousBlockedTask();
    const intendedRunId = deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      task.approval.approvedTaskHash!,
    );
    const deps = reconcileDeps(
      task,
      snapshot("accepted", { runId: intendedRunId }),
      {
        getRunBinding: vi.fn(async () => undefined),
      },
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "recovered",
      lifecycle: "running",
      healthy: true,
    });
    expect(deps.readPort.readRun).toHaveBeenCalledWith({
      harnessRunId: intendedRunId,
    });
    expect(deps.bindRun).toHaveBeenCalledWith({
      workItemId: task.workItemId,
      harnessRunId: intendedRunId,
    });
    expect(savedTasks(deps).at(-1)).toMatchObject({
      lifecycle: "running",
      bindings: { harnessRunId: intendedRunId },
    });
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "orphan_run_detected",
        harnessRunId: intendedRunId,
      }),
    );
    expect("submit" in deps).toBe(false);
    expect(recordedDecisions(deps)).toEqual([]);
  });

  it("leaves an ambiguous task blocked when the intended run is absent", async () => {
    const task = await ambiguousBlockedTask();
    const deps = reconcileDeps(task, snapshot("accepted"), {
      readPort: {
        readRun: vi.fn(async () => {
          throw new HarnessReadError(
            "run_not_started",
            "Harness run record is not available",
            true,
          );
        }),
      },
      getRunBinding: vi.fn(async () => undefined),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "run_missing",
      lifecycle: "blocked",
      healthy: false,
    });
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(deps.saveTask).not.toHaveBeenCalled();
    expect(deps.recordDecision).not.toHaveBeenCalled();
  });

  it("keeps lifecycle unchanged on Harness source failure", async () => {
    const task = await runningTask();
    const deps = reconcileDeps(task, snapshot("executing"), {
      readPort: {
        readRun: vi.fn(async () => {
          throw new HarnessReadError(
            "cli_failed",
            "Harness data source refused the read",
            true,
          );
        }),
      },
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "read_degraded",
      previousLifecycle: "running",
      lifecycle: "running",
      healthy: false,
    });
    expect(deps.saveTask).not.toHaveBeenCalled();
    expect(deps.recordDecision).not.toHaveBeenCalled();
  });

  it("persists a newly observed manifest through the immutable outbox binding", async () => {
    const task = agentTaskV1Schema.parse({
      ...await runningTask(),
      bindings: {
        harnessRunId: RUN_ID,
      },
    });
    const deps = reconcileDeps(task, snapshot("executing"), {
      getRunBinding: vi.fn(async () => ({
        workItemId: task.workItemId,
        harnessRunId: RUN_ID,
        boundAt: "2026-07-25T12:06:00.000Z",
      })),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      lifecycle: "running",
      healthy: true,
    });
    expect(deps.bindRun).toHaveBeenCalledWith({
      workItemId: task.workItemId,
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    });
    expect(savedTasks(deps).at(-1)?.bindings).toMatchObject({
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    });
  });
});

describe("dispatcher tick reconciliation order", () => {
  it("reconciles before dispatch and still observes while dispatch is disabled", async () => {
    const calls: string[] = [];
    const deps = processDeps({
      runReconcile: vi.fn(async () => {
        calls.push("reconcile");
        return [];
      }),
      runAttempt: vi.fn(async () => {
        calls.push("dispatch");
        return { outcome: "disabled" as const };
      }),
      isDispatchEnabled: vi.fn(() => false),
    });
    const process = createDispatcherProcess(dispatcherConfig(), deps);

    await expect(process.tick()).resolves.toEqual({ outcome: "disabled" });

    expect(calls).toEqual(["reconcile", "dispatch"]);
    expect(heartbeats(deps).at(-1)).toMatchObject({
      status: "disabled",
      lastOutcome: "disabled",
      reconciledCount: 0,
    });
  });

  it("runs stop-only reconciliation and does not dispatch while HALT is present", async () => {
    const deps = processDeps({
      isHalted: vi.fn(() => true),
    });
    const process = createDispatcherProcess(dispatcherConfig(), deps);

    await expect(process.tick()).resolves.toEqual({ outcome: "halted" });

    expect(deps.runReconcile).toHaveBeenCalledOnce();
    expect(deps.runAttempt).not.toHaveBeenCalled();
    expect(heartbeats(deps).at(-1)).toMatchObject({
      status: "halted",
      reconciledCount: 0,
    });
  });

  it("reports containment refusal as error rather than healthy idle", async () => {
    const refusal: ReconcileResult = {
      workItemId: "work-001",
      taskVersion: 1,
      outcome: "refused",
      previousLifecycle: "running",
      lifecycle: "blocked",
      healthy: false,
      reason: "projection_containment_failed",
    };
    const deps = processDeps({
      runReconcile: vi.fn(async () => [refusal]),
    });
    const process = createDispatcherProcess(dispatcherConfig(), deps);

    await expect(process.tick()).resolves.toEqual({ outcome: "idle" });

    expect(heartbeats(deps).at(-1)).toMatchObject({
      status: "error",
      lastOutcome: "idle",
      reconciledCount: 1,
    });
  });
});

async function runningTask(): Promise<AgentTaskV1> {
  const raw = agentTaskV1Schema.parse(JSON.parse(
    await readFile(
      new URL(
        "../fixtures/agent-integration/agent-task-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ));
  const approvedAt = "2026-07-25T12:00:00.000Z";
  const candidate = {
    ...raw,
    lifecycle: "running",
    deadline: "2026-07-26T12:00:00.000Z",
    approval: {
      ...raw.approval,
      status: "approved",
      actor: { type: "operator", id: "operator-one" },
      decidedAt: approvedAt,
      approvedTaskHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    timestamps: {
      ...raw.timestamps,
      approvedAt,
      dispatchClaimedAt: "2026-07-25T12:05:00.000Z",
      runBoundAt: "2026-07-25T12:06:00.000Z",
      updatedAt: "2026-07-25T12:06:00.000Z",
    },
    bindings: {
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    },
  } satisfies Omit<AgentTaskV1, "approval"> & {
    approval: Omit<AgentTaskV1["approval"], "status"> & {
      status: "approved";
    };
  };
  const approvedTaskHash = await hashAgentTaskApprovalPayload(
    candidate as AgentTaskV1,
  );
  return agentTaskV1Schema.parse({
    ...candidate,
    approval: {
      ...candidate.approval,
      approvedTaskHash,
    },
  });
}

async function ambiguousBlockedTask(): Promise<AgentTaskV1> {
  const task = await runningTask();
  return agentTaskV1Schema.parse({
    ...task,
    lifecycle: "blocked",
    timestamps: {
      ...task.timestamps,
      runBoundAt: undefined,
      updatedAt: "2026-07-25T12:07:00.000Z",
    },
    bindings: undefined,
  });
}

function reconcileDeps(
  task: AgentTaskV1,
  read: HarnessRunReadSnapshot,
  overrides: Partial<ReconcileRunDeps> = {},
): ReconcileRunDeps {
  return {
    now: overrides.now ?? vi.fn(() => NOW),
    isHalted: overrides.isHalted ?? vi.fn(() => false),
    listTasks: overrides.listTasks ?? vi.fn(async () => [task]),
    saveTask: overrides.saveTask ?? vi.fn(async () => undefined),
    getRunBinding: overrides.getRunBinding ?? vi.fn(async () => ({
      workItemId: task.workItemId,
      harnessRunId: task.bindings?.harnessRunId ?? read.status.runId,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
      boundAt: "2026-07-25T12:06:00.000Z",
    })),
    bindRun: overrides.bindRun ?? vi.fn(async () => undefined),
    readPort: overrides.readPort ?? {
      readRun: vi.fn(async () => read),
    },
    controlPort: overrides.controlPort ?? {
      cancel: vi.fn(async () => undefined),
    },
    recordDecision:
      overrides.recordDecision ?? vi.fn(async () => undefined),
    alertSink:
      overrides.alertSink ?? vi.fn(async () => undefined),
    logger: overrides.logger ?? {
      warn: vi.fn(),
    },
    ...(overrides.projectRun
      ? { projectRun: overrides.projectRun }
      : {}),
  };
}

function snapshot(
  state: HarnessRunState,
  options: {
    verificationPassed?: boolean;
    runId?: string;
  } = {},
): HarnessRunReadSnapshot {
  const terminalOutcome = state === "completed"
    ? "completed"
    : state === "partial"
      ? "partial"
      : state === "failed"
        ? "failed"
        : state === "cancelled"
          ? "cancelled"
          : undefined;
  const verificationPassed = options.verificationPassed;
  const events: HarnessRunReadSnapshot["events"] = [
    {
      seq: 1,
      type: "ContractCompiled",
      payload: { risk_class: "low" },
    },
    {
      seq: 2,
      type: "EnvironmentPrepared",
      payload: { manifest_hash: MANIFEST_HASH },
    },
  ];
  if (verificationPassed !== undefined) {
    events.push({
      seq: 3,
      type: "VerificationCompleted",
      payload: {
        passed: verificationPassed,
        verdict: verificationPassed ? "completed" : "failed",
        report_ref:
          "artifact://sha256/6666666666666666666666666666666666666666666666666666666666666666",
      },
    });
  }
  const deliverables = verificationPassed === true
    ? [
        deliverable(
          "workspace_patch",
          "1111111111111111111111111111111111111111111111111111111111111111",
        ),
        deliverable(
          "change_summary",
          "2222222222222222222222222222222222222222222222222222222222222222",
        ),
        deliverable(
          "verification_report",
          "6666666666666666666666666666666666666666666666666666666666666666",
        ),
      ]
    : verificationPassed === false
      ? [
          deliverable(
            "verification_report",
            "6666666666666666666666666666666666666666666666666666666666666666",
          ),
        ]
      : [];
  return {
    status: {
      runId: options.runId ?? RUN_ID,
      state,
      attempt: 1,
      ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
      ...(state === "failed" || state === "quarantined"
        ? { outcomeReason: "verification_failed" }
        : {}),
      egressPolicy: "deny",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:29:00.000Z",
    },
    events,
    deliverables,
  };
}

function deliverable(type: string, digest: string) {
  return {
    deliverableType: type,
    artifact: {
      uri: `artifact://sha256/${digest}`,
      sha256: `sha256:${digest}` as const,
    },
  };
}

function projectionFor(
  task: AgentTaskV1,
  state: HarnessRunState,
): AgentRunProjectionV1 {
  return agentRunProjectionV1Schema.parse({
    schemaVersion: 1,
    kind: "agent_run_projection",
    workItemId: task.workItemId,
    correlationId: task.correlationId,
    harnessRunId: RUN_ID,
    taskVersion: task.taskVersion,
    source: {
      system: "agent-harness",
      health: "healthy",
      observedAt: NOW.toISOString(),
      sourceUpdatedAt: "2026-07-25T12:29:00.000Z",
    },
    heartbeat: {
      status: "active",
      ageSeconds: 60,
    },
    run: {
      state,
      attempt: 1,
      terminal: false,
    },
    manifest: {
      ref: MANIFEST_REF,
      hash: MANIFEST_HASH,
      profile: task.intent.profile,
      riskClass: "low",
      effectiveCapabilities: task.requestedAuthority.grants.map(
        (grant) => grant.capabilityId,
      ),
      network: task.requestedAuthority.network,
      policyHash: task.approval.policyHash,
      verifierHash: task.acceptance.verifierPlanHash,
      modelBindings: [],
      skillVersions: [],
    },
    progress: {
      phase: state,
      summary: "Harness is executing the bounded task.",
    },
    budget: {
      elapsedSecondsUsed: 60,
      elapsedSecondsLimit: task.budget.elapsedSeconds,
      modelTokensLimit: task.budget.modelTokens,
      toolCallsUsed: 0,
      toolCallsLimit: task.budget.toolCalls,
      estimatedUsdMicrosLimit: task.budget.estimatedUsdMicros,
      exhausted: false,
    },
    artifacts: [],
    verification: { status: "pending" },
    bindings: {
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    },
  });
}

function savedTasks(deps: ReconcileRunDeps): AgentTaskV1[] {
  return vi.mocked(deps.saveTask).mock.calls.map(([task]) => task);
}

function recordedDecisions(
  deps: ReconcileRunDeps,
): Parameters<ReconcileRunDeps["recordDecision"]>[0][] {
  return vi.mocked(deps.recordDecision).mock.calls.map(([record]) => record);
}

function processDeps(
  overrides: Partial<DispatcherProcessDeps> = {},
): DispatcherProcessDeps {
  return {
    runReconcile: overrides.runReconcile ?? vi.fn(async () => []),
    runAttempt:
      overrides.runAttempt ?? vi.fn(async () => ({ outcome: "idle" })),
    isDispatchEnabled:
      overrides.isDispatchEnabled ?? vi.fn(() => true),
    isHalted: overrides.isHalted ?? vi.fn(() => false),
    releaseLease:
      overrides.releaseLease ?? vi.fn(async () => true),
    writeHeartbeat:
      overrides.writeHeartbeat ?? vi.fn(async () => undefined),
    now: overrides.now ?? vi.fn(() => NOW),
    logger: overrides.logger ?? {
      info: vi.fn(),
      warn: vi.fn(),
    },
    scheduler: overrides.scheduler ?? {
      setTimeout: vi.fn(() => {
        throw new Error("unexpected timer");
      }),
      clearTimeout: vi.fn(),
    },
  };
}

function dispatcherConfig(): DispatcherConfig {
  return {
    dispatcherId: "dispatcher-one",
    pollIntervalMs: 15_000,
    leaseTtlSeconds: 120,
    intentDir: "/tmp/harness-intents",
    heartbeatPath: "/tmp/harness-heartbeat.json",
    harnessBin: "harness",
  };
}

function heartbeats(deps: DispatcherProcessDeps): DispatcherHeartbeat[] {
  return vi.mocked(deps.writeHeartbeat).mock.calls.map(([heartbeat]) =>
    heartbeat);
}
