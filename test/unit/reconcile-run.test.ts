import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  agentRunProjectionV1Schema,
  agentTaskV1Schema,
  harnessRunStateSchema,
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
import { afterAll, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-07-25T12:30:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_HASH =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const MANIFEST_REF = {
  uri: "artifact://sha256/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  sha256: MANIFEST_HASH,
  mediaType: "application/json",
} as const;
const TERMINAL_LIFECYCLES = new Set<AgentTaskLifecycle>([
  "handoff_ready",
  "failed",
  "cancelled",
]);
type TerminalOutcome = NonNullable<
  AgentRunProjectionV1["run"]["outcome"]
>;

type BudgetD4Case =
  | "live-over-budget"
  | "terminal-verified-over-budget"
  | "terminal-verification-failed-over-budget"
  | "terminal-inside-budget";

interface BudgetD4Evidence {
  case: BudgetD4Case;
  lifecycle: AgentTaskLifecycle;
  cancelled: boolean;
  failureSource: "budget_exhausted" | "verification_failed" | "none";
  alertSeverity: "warn" | "critical" | "none";
  alertMessage: string;
  decisionReasons: string[];
}

interface BudgetD4MutationEvidence {
  case: BudgetD4Case;
  mutation: string;
  observedFailure: string;
}

class BudgetD4EvidenceError extends Error {}

const budgetD4Evidence: BudgetD4Evidence[] = [];
const budgetD4Mutations: BudgetD4MutationEvidence[] = [];

afterAll(async () => {
  const evidenceDir = process.env.HARNESS_BUDGET_OVERRUN_EVIDENCE_DIR?.trim();
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, "suite-summary.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      executedCases: budgetD4Evidence.length,
      expectedCases: 4,
      cases: budgetD4Evidence,
      mutations: budgetD4Mutations,
    }, null, 2)}\n`,
    "utf8",
  );
});

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
    ["completed", true, "handoff_ready"],
    ["completed", false, "failed"],
    ["partial", undefined, "failed"],
    ["failed", undefined, "failed"],
    ["cancelled", undefined, "cancelled"],
  ] satisfies Array<
    [TerminalOutcome, boolean | undefined, AgentTaskLifecycle]
  >)(
    "projects terminal learning_processed outcome %s (verification=%s) to %s",
    async (outcome, verificationPassed, expectedLifecycle) => {
      const task = await runningTask();
      const deps = reconcileDeps(
        task,
        snapshot("learning_processed", {
          outcome,
          ...(verificationPassed === undefined
            ? {}
            : { verificationPassed }),
        }),
      );

      const [reconciled] = await reconcileDispatchedRuns(deps);

      expect(reconciled?.lifecycle).toBe(expectedLifecycle);
      expect(reconciled?.projection?.run).toMatchObject({
        state: "learning_processed",
        terminal: true,
        outcome,
      });
      expect(TERMINAL_LIFECYCLES.has(reconciled!.lifecycle)).toBe(true);
      expect(savedTasks(deps).at(-1)?.lifecycle).toBe(expectedLifecycle);
      expect(deps.controlPort.cancel).not.toHaveBeenCalled();
      expect(deps.alertSink).not.toHaveBeenCalled();
    },
  );

  it("projects terminal learning_queued from its outcome", async () => {
    const task = await runningTask();
    const deps = reconcileDeps(
      task,
      snapshot("learning_queued", { outcome: "partial" }),
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      lifecycle: "failed",
      healthy: true,
      projection: {
        run: {
          state: "learning_queued",
          terminal: true,
          outcome: "partial",
        },
      },
    });
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("failed");
  });

  it.each(harnessRunStateSchema.options)(
    "resolves terminal Harness state %s to a terminal lifecycle",
    async (state) => {
      const task = await runningTask();
      const deps = reconcileDeps(
        task,
        snapshot(state, { outcome: "failed" }),
      );

      const [reconciled] = await reconcileDispatchedRuns(deps);

      expect(reconciled?.projection?.run).toMatchObject({
        state,
        terminal: true,
        outcome: "failed",
      });
      expect(reconciled?.lifecycle).toBe("failed");
      expect(TERMINAL_LIFECYCLES.has(reconciled!.lifecycle)).toBe(true);
      expect(reconciled?.lifecycle).not.toBe(task.lifecycle);
      expect(deps.controlPort.cancel).not.toHaveBeenCalled();
      expect(deps.alertSink).not.toHaveBeenCalled();
    },
  );

  it("alerts and blocks an unresolvable terminal projection", async () => {
    const task = await runningTask();
    const unresolved: AgentRunProjectionV1 = {
      ...projectionFor(task, "learning_processed"),
      run: {
        state: "learning_processed",
        attempt: 1,
        terminal: true,
      },
    };
    const deps = reconcileDeps(task, snapshot("learning_processed"), {
      projectRun: vi.fn(() => unresolved),
    });

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "refused",
      lifecycle: "blocked",
      healthy: false,
      reason: expect.stringContaining("terminal_projection_unresolved"),
    });
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("blocked");
    expect(deps.controlPort.cancel).not.toHaveBeenCalled();
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "terminal_projection_unresolved",
        harnessRunId: RUN_ID,
      }),
    );
  });

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

  it("D4: cancels and fails a live budget-exhausted run with one alert", async () => {
    const task = await runningTask();
    const projection = projectionFor(task, "executing");
    const exhausted = agentRunProjectionV1Schema.parse({
      ...projection,
      budget: {
        ...projection.budget,
        elapsedSecondsUsed: task.budget.elapsedSeconds + 5,
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
      `budget_exhaustion_dimension=elapsed_seconds used=${task.budget.elapsedSeconds + 5} limit=${task.budget.elapsedSeconds} over_by=5`,
    ]);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "budget_exhausted",
        message: expect.stringContaining(
          `elapsed_seconds used=${task.budget.elapsedSeconds + 5} limit=${task.budget.elapsedSeconds} over_by=5`,
        ),
      }),
    );

    recordBudgetD4Evidence(
      budgetEvidence("live-over-budget", reconciled!, deps),
      (mutated) => {
        mutated.cancelled = false;
      },
      "live_cancelled",
      "invert the live-overrun guard so cancellation is skipped",
    );
  });

  it("D4: preserves a verified terminal outcome and records its token overrun", async () => {
    const task = await runningTask();
    const projection = terminalProjection(task, true, {
      modelTokensUsed: task.budget.modelTokens + 1_049,
      exhausted: true,
    });
    const deps = reconcileDeps(
      task,
      snapshot("learning_processed", {
        outcome: "completed",
        verificationPassed: true,
      }),
      { projectRun: vi.fn(() => projection) },
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "handoff_ready",
      lifecycle: "handoff_ready",
      healthy: true,
      handoff: {
        verification: { verified: true, decision: "accept" },
      },
    });
    expect(deps.controlPort.cancel).not.toHaveBeenCalled();
    expect(savedTasks(deps).at(-1)?.lifecycle).toBe("handoff_ready");
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        code: "budget_exhausted",
        message: expect.stringContaining(
          `model_tokens used=${task.budget.modelTokens + 1_049} limit=${task.budget.modelTokens} over_by=1049`,
        ),
      }),
    );
    expect(recordedDecisions(deps).at(-1)?.proposal.why).toEqual([
      "verified_handoff_ready_for_operator",
      "eligible_for_pr_open=true",
      "eligible_for_pr_open_reason=completed_outcome_verified_acceptance_all_checks_passed",
      "budget_status=exhausted",
      `budget_exhaustion_dimension=model_tokens used=${task.budget.modelTokens + 1_049} limit=${task.budget.modelTokens} over_by=1049`,
    ]);

    recordBudgetD4Evidence(
      budgetEvidence("terminal-verified-over-budget", reconciled!, deps),
      (mutated) => {
        mutated.lifecycle = "failed";
        mutated.cancelled = true;
      },
      "terminal_completed_lifecycle",
      "remove the terminal guard so the completed verified run is cancelled and failed",
    );
  });

  it("D4: fails a terminal over-budget run on verification, not budget", async () => {
    const task = await runningTask();
    const projection = terminalProjection(task, false, {
      toolCallsUsed: task.budget.toolCalls + 2,
      exhausted: true,
    });
    const deps = reconcileDeps(
      task,
      snapshot("learning_processed", {
        outcome: "completed",
        verificationPassed: false,
      }),
      { projectRun: vi.fn(() => projection) },
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "advanced",
      lifecycle: "failed",
      healthy: true,
      projection: { verification: { status: "failed" } },
    });
    expect(reconciled?.reason).not.toBe("budget_exhausted");
    expect(reconciled?.handoff).toBeUndefined();
    expect(deps.controlPort.cancel).not.toHaveBeenCalled();
    expect(recordedDecisions(deps)).toEqual([]);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        code: "budget_exhausted",
        message: expect.stringContaining(
          `tool_calls used=${task.budget.toolCalls + 2} limit=${task.budget.toolCalls} over_by=2`,
        ),
      }),
    );

    recordBudgetD4Evidence(
      budgetEvidence(
        "terminal-verification-failed-over-budget",
        reconciled!,
        deps,
      ),
      (mutated) => {
        mutated.failureSource = "budget_exhausted";
        mutated.cancelled = true;
      },
      "verification_failed_lifecycle",
      "remove the terminal guard so budget cancellation pre-empts verification",
    );
  });

  it("D4: leaves a verified terminal run inside budget unchanged", async () => {
    const task = await runningTask();
    const projection = terminalProjection(task, true, { exhausted: false });
    const deps = reconcileDeps(
      task,
      snapshot("learning_processed", {
        outcome: "completed",
        verificationPassed: true,
      }),
      { projectRun: vi.fn(() => projection) },
    );

    const [reconciled] = await reconcileDispatchedRuns(deps);

    expect(reconciled).toMatchObject({
      outcome: "handoff_ready",
      lifecycle: "handoff_ready",
      healthy: true,
    });
    expect(deps.controlPort.cancel).not.toHaveBeenCalled();
    expect(deps.alertSink).not.toHaveBeenCalled();
    expect(recordedDecisions(deps).at(-1)?.proposal.why).toContain(
      "budget_status=within_limits",
    );

    recordBudgetD4Evidence(
      budgetEvidence("terminal-inside-budget", reconciled!, deps),
      (mutated) => {
        mutated.alertSeverity = "warn";
        mutated.alertMessage = "budget exhausted";
        mutated.decisionReasons = ["budget_status=exhausted"];
      },
      "inside_budget_alert",
      "make the non-exhausted projection enter the terminal-overrun branch",
    );
    expect(budgetD4Evidence).toHaveLength(4);
    expect(budgetD4Mutations).toHaveLength(4);
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
    const handoff = reconciled?.handoff;
    if (!handoff) throw new Error("Expected a verified handoff");
    expect(handoff.runManifestRef.sha256).toBe(handoff.runManifestHash);
    expect(handoff.deliverables.patchRef).toBeDefined();
    expect(handoff).not.toHaveProperty("pullRequest");

    const handoffDecisions = recordedDecisions(deps).filter(
      (record) => record.decisionType === "handoff",
    );
    expect(handoffDecisions).toHaveLength(1);
    expect(handoffDecisions[0]).toMatchObject({
      decisionType: "handoff",
      proposal: {
        why: [
          "verified_handoff_ready_for_operator",
          "eligible_for_pr_open=true",
          "eligible_for_pr_open_reason=completed_outcome_verified_acceptance_all_checks_passed",
          "budget_status=within_limits",
        ],
      },
      next: { owner: "operator" },
      effects: {
        mutates: false,
        mutations: [],
        authorityChanged: false,
        budgetChanged: false,
      },
    });
    expect(handoffDecisions[0]?.proposal.evidenceRefs).toEqual(
      expect.arrayContaining(handoff.verification.evidenceRefs),
    );

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
    outcome?: TerminalOutcome;
  } = {},
): HarnessRunReadSnapshot {
  const terminalOutcome = options.outcome
    ?? (state === "completed"
      ? "completed"
      : state === "partial"
        ? "partial"
        : state === "failed"
          ? "failed"
          : state === "cancelled"
            ? "cancelled"
            : undefined);
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
      ...(terminalOutcome === "failed" || state === "quarantined"
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

function terminalProjection(
  task: AgentTaskV1,
  verificationPassed: boolean,
  budget: Partial<AgentRunProjectionV1["budget"]>,
): AgentRunProjectionV1 {
  const base = projectionFor(task, "learning_processed");
  const verificationRef = deliverable(
    "verification_report",
    "6666666666666666666666666666666666666666666666666666666666666666",
  ).artifact;
  return agentRunProjectionV1Schema.parse({
    ...base,
    heartbeat: {
      status: "terminal",
      lastEventAt: "2026-07-25T12:29:00.000Z",
      ageSeconds: 60,
    },
    run: {
      state: "learning_processed",
      attempt: 1,
      terminal: true,
      outcome: "completed",
      lastEventAt: "2026-07-25T12:29:00.000Z",
    },
    budget: {
      ...base.budget,
      modelTokensUsed: 1,
      ...budget,
    },
    artifacts: [verificationRef],
    verification: {
      status: verificationPassed ? "passed" : "failed",
      decisionRef: verificationRef,
      decisionHash: verificationRef.sha256,
    },
  });
}

function budgetEvidence(
  caseName: BudgetD4Case,
  reconciled: ReconcileResult,
  deps: ReconcileRunDeps,
): BudgetD4Evidence {
  const alert = vi.mocked(deps.alertSink).mock.calls.at(-1)?.[0];
  const reasons = recordedDecisions(deps).flatMap(
    (decision) => decision.proposal.why,
  );
  const verificationFailed =
    reconciled.projection?.verification?.status === "failed";
  return {
    case: caseName,
    lifecycle: reconciled.lifecycle,
    cancelled: vi.mocked(deps.controlPort.cancel).mock.calls.length > 0,
    failureSource: reconciled.reason === "budget_exhausted"
      ? "budget_exhausted"
      : verificationFailed
        ? "verification_failed"
        : "none",
    alertSeverity: alert?.severity ?? "none",
    alertMessage: alert?.message ?? "",
    decisionReasons: reasons,
  };
}

function recordBudgetD4Evidence(
  evidence: BudgetD4Evidence,
  mutate: (value: BudgetD4Evidence) => void,
  expectedFailure: string,
  mutation: string,
): void {
  expect(() => verifyBudgetD4Evidence(evidence)).not.toThrow();
  budgetD4Evidence.push(evidence);

  const mutated = structuredClone(evidence);
  mutate(mutated);
  let observed = "";
  try {
    verifyBudgetD4Evidence(mutated);
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetD4EvidenceError);
    observed = (error as Error).message;
  }
  expect(observed).toContain(expectedFailure);
  budgetD4Mutations.push({
    case: evidence.case,
    mutation,
    observedFailure: expectedFailure,
  });
}

function verifyBudgetD4Evidence(evidence: BudgetD4Evidence): void {
  switch (evidence.case) {
    case "live-over-budget":
      assertBudgetD4(evidence.lifecycle === "failed", "live_lifecycle");
      assertBudgetD4(evidence.cancelled, "live_cancelled");
      assertBudgetD4(
        evidence.failureSource === "budget_exhausted",
        "live_failure_source",
      );
      assertBudgetD4(
        evidence.alertSeverity === "critical",
        "live_alert_severity",
      );
      assertBudgetD4(
        evidence.alertMessage.includes("elapsed_seconds")
          && evidence.alertMessage.includes("over_by=5")
          && evidence.decisionReasons.some(
            (reason) => reason.includes("elapsed_seconds")
              && reason.includes("over_by=5"),
          ),
        "live_dimension_evidence",
      );
      return;
    case "terminal-verified-over-budget":
      assertBudgetD4(
        evidence.lifecycle === "handoff_ready" && !evidence.cancelled,
        "terminal_completed_lifecycle",
      );
      assertBudgetD4(evidence.failureSource === "none", "terminal_failure_source");
      assertBudgetD4(
        evidence.alertSeverity === "warn"
          && evidence.alertMessage.includes("model_tokens")
          && evidence.alertMessage.includes("over_by=1049"),
        "terminal_overrun_alert",
      );
      assertBudgetD4(
        evidence.decisionReasons.includes("budget_status=exhausted")
          && evidence.decisionReasons.some(
            (reason) => reason.includes("model_tokens")
              && reason.includes("over_by=1049"),
          ),
        "terminal_overrun_decision",
      );
      return;
    case "terminal-verification-failed-over-budget":
      assertBudgetD4(
        evidence.lifecycle === "failed" && !evidence.cancelled,
        "verification_failed_lifecycle",
      );
      assertBudgetD4(
        evidence.failureSource === "verification_failed",
        "verification_failure_source",
      );
      assertBudgetD4(
        evidence.alertSeverity === "warn"
          && evidence.alertMessage.includes("tool_calls")
          && evidence.alertMessage.includes("over_by=2"),
        "verification_failed_overrun_alert",
      );
      return;
    case "terminal-inside-budget":
      assertBudgetD4(
        evidence.lifecycle === "handoff_ready" && !evidence.cancelled,
        "inside_budget_lifecycle",
      );
      assertBudgetD4(evidence.alertSeverity === "none", "inside_budget_alert");
      assertBudgetD4(
        evidence.decisionReasons.includes("budget_status=within_limits")
          && !evidence.decisionReasons.includes("budget_status=exhausted"),
        "within_budget_marker",
      );
      return;
    default:
      return assertNeverBudgetCase(evidence.case);
  }
}

function assertBudgetD4(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new BudgetD4EvidenceError(reason);
}

function assertNeverBudgetCase(value: never): never {
  throw new BudgetD4EvidenceError(`unknown_case:${String(value)}`);
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
    readTimeoutMs: 15_000,
    intentDir: "/tmp/harness-intents",
    heartbeatPath: "/tmp/harness-heartbeat.json",
    harnessBin: "harness",
  };
}

function heartbeats(deps: DispatcherProcessDeps): DispatcherHeartbeat[] {
  return vi.mocked(deps.writeHeartbeat).mock.calls.map(([heartbeat]) =>
    heartbeat);
}
