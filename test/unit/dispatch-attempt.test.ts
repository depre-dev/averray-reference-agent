import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  agentTaskApprovalHashMatches,
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  type AgentTaskV1,
  type HermesDecisionRecordV2,
  type PilotProfileManifest,
} from "../../packages/schemas/src/index.js";
import {
  DispatchClaimError,
  deriveIntendedRunId,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  buildTaskIntentArtifact,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  readHaltFile,
  runSingleDispatch,
  type DispatchDeps,
} from "../../services/harness-dispatcher/src/dispatch-attempt.js";
import {
  HarnessControlError,
} from "../../services/harness-dispatcher/src/harness-control-port.js";
import {
  WorkspacePrepError,
} from "../../services/harness-dispatcher/src/workspace-prep.js";

const NOW = "2026-07-24T12:00:00.000Z";
const DEADLINE = "2026-07-24T13:00:00.000Z";
const OTHER_HASH = `sha256:${"f".repeat(64)}`;
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";

const CAPABILITIES: PilotProfileManifest["capabilities"] = [
  { id: "fs.read_file", effectClass: "none", delegable: false },
  { id: "fs.write_file", effectClass: "local", delegable: false },
  { id: "fs.list_files", effectClass: "none", delegable: false },
  { id: "shell.run", effectClass: "local", delegable: false },
  { id: "git.status", effectClass: "none", delegable: false },
  { id: "git.diff", effectClass: "none", delegable: false },
  { id: "artifact.put", effectClass: "local", delegable: false },
  { id: "artifact.get", effectClass: "none", delegable: false },
];

describe("single-attempt Harness dispatch orchestration", () => {
  it("reads HALT_FILE from the supplied environment", () => {
    expect(readHaltFile({
      HALT_FILE: path.resolve(process.cwd(), "package.json"),
    })).toBe(true);
    expect(readHaltFile({
      HALT_FILE: path.resolve(process.cwd(), "missing-halt-file"),
    })).toBe(false);
  });

  it("returns disabled without touching the lease, store, or control port", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.isDispatchEnabled).mockReturnValue(false);

    await expect(runSingleDispatch(deps)).resolves.toEqual({ outcome: "disabled" });

    expect(deps.acquireLease).not.toHaveBeenCalled();
    expect(deps.releaseLease).not.toHaveBeenCalled();
    expect(deps.listDispatchable).not.toHaveBeenCalled();
    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
  });

  it("gives HALT precedence without claiming, listing, or submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.isHalted).mockReturnValue(true);

    await expect(runSingleDispatch(deps)).resolves.toEqual({ outcome: "halted" });

    expect(deps.acquireLease).not.toHaveBeenCalled();
    expect(deps.releaseLease).not.toHaveBeenCalled();
    expect(deps.listDispatchable).not.toHaveBeenCalled();
    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
  });

  it("returns lease_unavailable without claiming or submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.acquireLease).mockResolvedValue(false);

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "lease_unavailable",
    });

    expect(deps.listDispatchable).not.toHaveBeenCalled();
    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.releaseLease).not.toHaveBeenCalled();
  });

  it("returns idle after releasing the acquired lease", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.listDispatchable).mockResolvedValue([]);

    await expect(runSingleDispatch(deps)).resolves.toEqual({ outcome: "idle" });

    expect(deps.listDispatchable).toHaveBeenCalledTimes(1);
    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledOnce();
    expect(deps.releaseLease).toHaveBeenCalledWith(deps.dispatcherId);
  });

  it("refuses an approval hash mismatch without submitting", async () => {
    const approved = await approvedTask();
    const task = {
      ...approved,
      proposal: {
        ...approved.proposal,
        objective: `${approved.proposal.objective} Materially changed.`,
      },
    } as AgentTaskV1;
    const deps = dispatchDeps(task);
    vi.mocked(deps.countInflight).mockResolvedValue(1);

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "approval_hash_mismatch",
    });

    assertRefusal(deps, "approval_hash_mismatch");
    expect(deps.countInflight).not.toHaveBeenCalled();
  });

  it("refuses active policy drift before claim or submit and names both hashes", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    deps.activePolicyIdentity = {
      version: "dispatch-policy-v2",
      hash: OTHER_HASH,
    };

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "policy_drift",
    });

    assertRefusal(
      deps,
      `policy_drift approved_policy_hash=${task.approval.policyHash} active_policy_hash=${OTHER_HASH}`,
      {
      severity: "warn",
      code: "policy_drift",
      },
    );
    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(vi.mocked(deps.alertSink).mock.calls[0]?.[0].message).toContain(
      task.approval.policyHash,
    );
    expect(vi.mocked(deps.alertSink).mock.calls[0]?.[0].message).toContain(
      OTHER_HASH,
    );
  });

  it("fails closed if enabled dispatch has no active policy identity", async () => {
    const deps = dispatchDeps(await approvedTask());
    deps.activePolicyIdentity = undefined;

    await expect(runSingleDispatch(deps)).rejects.toThrow(
      "active policy identity is required",
    );
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("refuses an executor other than Harness before deriving or claiming", async () => {
    const task = await reapprove({
      ...await approvedTask(),
      executor: {
        kind: "direct",
        directAgent: "codex",
        selectionReason: "The direct path was selected.",
      },
    });
    const deps = dispatchDeps(task);

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "refused",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      reason: "executor_not_harness",
    });

    assertRefusal(deps, "executor_not_harness");
    expect(deps.getRunBinding).not.toHaveBeenCalled();
    expect(deps.claimDispatch).not.toHaveBeenCalled();
  });

  it("refuses a non-approved lifecycle before deriving or claiming", async () => {
    const task = await reapprove({
      ...await approvedTask(),
      lifecycle: "proposed",
    });
    const deps = dispatchDeps(task);

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "refused",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      reason: "not_approved",
    });

    assertRefusal(deps, "not_approved");
    expect(deps.getRunBinding).not.toHaveBeenCalled();
    expect(deps.claimDispatch).not.toHaveBeenCalled();
  });

  it("refuses an expired deadline without submitting", async () => {
    const task = await reapprove({
      ...await approvedTask(),
      deadline: "2026-07-24T12:00:00.000Z",
    });
    const deps = dispatchDeps(task);

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "deadline_expired",
    });

    assertRefusal(deps, "deadline_expired");
  });

  it("refuses a TaskIntent template hash mismatch without submitting", async () => {
    const approved = await approvedTask();
    const task = await reapprove({
      ...approved,
      intent: {
        ...approved.intent,
        templateHash: OTHER_HASH,
        templateRef: {
          ...approved.intent.templateRef,
          uri: `artifact://sha256/${OTHER_HASH.slice("sha256:".length)}`,
          sha256: OTHER_HASH,
        },
      },
    });
    const deps = dispatchDeps(task);

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "template_hash_mismatch",
    });

    assertRefusal(deps, "template_hash_mismatch");
    expect(deps.loadProfileManifest).not.toHaveBeenCalled();
  });

  it("propagates an AttenuationError reason verbatim without submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.loadProfileManifest).mockResolvedValue({
      ...profileFor(task),
      capabilities: CAPABILITIES.map((capability, index) =>
        index === 0
          ? { ...capability, effectClass: "external_write" }
          : capability),
    });

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "capability_effect_external",
    });

    assertRefusal(deps, "capability_effect_external");
  });

  it("refuses a claim conflict without submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.claimDispatch).mockRejectedValue(
      new DispatchClaimError("claim_conflict", "immutable claim conflict"),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "claim_conflict",
    });

    assertRefusal(deps, "claim_conflict");
    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.writeIntentArtifact).not.toHaveBeenCalled();
  });

  it("refuses a workspace preparation error after claiming without submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.prepareWorkspace).mockRejectedValue(
      new WorkspacePrepError("clone_failed", "Public checkout failed"),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "workspace_prep_failed",
      intendedRunId: intendedId(task),
    });

    assertRefusal(deps, "workspace_prep_failed");
    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.prepareWorkspace).toHaveBeenCalledOnce();
    expect(deps.writeIntentArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["dependency_cache_missing", "warn"],
    ["dependency_cache_stale", "critical"],
    ["dependency_seed_failed", "warn"],
  ] as const)("emits one distinct %s alert and never submits", async (
    workspaceReason,
    severity,
  ) => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    const expectedHash = `sha256:${"a".repeat(64)}`;
    vi.mocked(deps.prepareWorkspace).mockRejectedValue(
      new WorkspacePrepError(
        workspaceReason,
        `Dependency preparation failed for expected ${expectedHash}`,
      ),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "workspace_prep_failed",
      intendedRunId: intendedId(task),
    });

    assertRefusal(deps, "workspace_prep_failed", {
      severity,
      code: workspaceReason,
    });
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(expectedHash),
      }),
    );
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.writeIntentArtifact).not.toHaveBeenCalled();
  });

  it("refuses a prepared path that differs from the shared deterministic path", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.prepareWorkspace).mockResolvedValue(
      "/var/lib/harness-dispatcher/workspaces/unapproved-v1",
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "workspace_prep_failed",
    });

    assertRefusal(deps, "workspace_prep_failed");
    expect(deps.writeIntentArtifact).not.toHaveBeenCalled();
  });

  it("refuses a conflicting recovery binding without claiming or submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.getRunBinding).mockResolvedValue({
      workItemId: task.workItemId,
      harnessRunId: OTHER_RUN_ID,
      boundAt: NOW,
    });

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "binding_conflict",
    });

    assertRefusal(deps, "binding_conflict");
    expect(deps.claimDispatch).not.toHaveBeenCalled();
  });

  it("re-checks HALT immediately before submit and refuses when it trips", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.isHalted)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "halted_before_submit",
    });

    assertRefusal(deps, "halted_before_submit");
    expect(deps.isHalted).toHaveBeenCalledTimes(2);
    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.writeIntentArtifact).toHaveBeenCalledOnce();
  });

  it("submits and binds exactly once, preserving the approved task hash", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    const intendedRunId = intendedId(task);
    const ignoredTask = await reapprove({
      ...task,
      workItemId: "work-ignored",
      taskVersion: 2,
    });
    vi.mocked(deps.listDispatchable).mockResolvedValue([task, ignoredTask]);

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "dispatched",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      intendedRunId,
    });

    expect(deps.listDispatchable).toHaveBeenCalledOnce();
    expect(deps.renewLease).not.toHaveBeenCalled();
    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.prepareWorkspace).toHaveBeenCalledOnce();
    expect(deps.prepareWorkspace).toHaveBeenCalledWith(task);
    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.controlPort.submit).toHaveBeenCalledWith(
      intendedRunId,
      expect.any(String),
    );
    const intentPath = vi.mocked(deps.controlPort.submit).mock.calls[0]?.[1];
    expect(intentPath && path.isAbsolute(intentPath)).toBe(true);
    const intentBytes = vi.mocked(deps.writeIntentArtifact).mock.calls[0]?.[0];
    const writtenIntent = JSON.parse(intentBytes ?? "{}") as {
      spec?: { context?: { workspace?: { path?: string } } };
    };
    expect(writtenIntent.spec?.context?.workspace?.path).toBe(
      workspacePathForTask(task.workItemId, task.taskVersion),
    );
    expect(deps.bindRun).toHaveBeenCalledOnce();
    expect(deps.bindRun).toHaveBeenCalledWith({
      workItemId: task.workItemId,
      harnessRunId: intendedRunId,
    });
    expect(deps.saveTask).toHaveBeenCalledTimes(2);
    const finalTask = savedTask(deps, 1);
    expect(finalTask.lifecycle).toBe("running");
    expect(finalTask.bindings?.harnessRunId).toBe(intendedRunId);
    expect(finalTask.timestamps.runBoundAt).toBe(NOW);
    await expect(agentTaskApprovalHashMatches(finalTask)).resolves.toBe(true);
    expect(decisionRecords(deps)).toHaveLength(1);
    expect(decisionRecords(deps)[0]?.decisionType).toBe("dispatch_approval");
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("recovers an identical existing binding without claiming or submitting", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    const intendedRunId = intendedId(task);
    vi.mocked(deps.getRunBinding).mockResolvedValue({
      workItemId: task.workItemId,
      harnessRunId: intendedRunId,
      boundAt: "2026-07-24T11:59:00.000Z",
    });

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "already_bound",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      intendedRunId,
    });

    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.prepareWorkspace).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(deps.saveTask).toHaveBeenCalledOnce();
    expect(savedTask(deps, 0)).toMatchObject({
      lifecycle: "running",
      bindings: { harnessRunId: intendedRunId },
      timestamps: { runBoundAt: "2026-07-24T11:59:00.000Z" },
    });
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("blocks an ambiguous submit without binding or marking the task failed", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.controlPort.submit).mockRejectedValue(
      new HarnessControlError("cli_timeout", "timed out", true),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "submit_failed",
      ambiguous: true,
      reason: "submit_ambiguous",
      intendedRunId: intendedId(task),
    });

    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(deps.saveTask).toHaveBeenCalledTimes(2);
    expect(savedTask(deps, 1).lifecycle).toBe("blocked");
    expect(savedTask(deps, 1).lifecycle).not.toBe("failed");
    assertDecision(deps, "submit_ambiguous");
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("blocks a definitely-no-run submit refusal as non-ambiguous", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.controlPort.submit).mockRejectedValue(
      new HarnessControlError(
        "invalid_intent_path",
        "intent path is invalid",
        false,
      ),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "submit_failed",
      ambiguous: false,
      reason: "submit_refused",
      intendedRunId: intendedId(task),
    });

    expect(deps.claimDispatch).toHaveBeenCalledOnce();
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(savedTask(deps, 1).lifecycle).toBe("blocked");
    assertDecision(deps, "submit_refused");
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("refuses a successful submit response with the wrong run identity", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.controlPort.submit).mockResolvedValue(OTHER_RUN_ID);

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "submit_identity_mismatch",
      intendedRunId: intendedId(task),
    });

    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(savedTask(deps, 1).lifecycle).toBe("blocked");
    assertDecision(deps, "submit_identity_mismatch");
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("refuses an outbox binding conflict after a single successful submit", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.bindRun).mockRejectedValue(
      new DispatchClaimError("binding_conflict", "immutable binding conflict"),
    );

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "binding_conflict",
      intendedRunId: intendedId(task),
    });

    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.bindRun).toHaveBeenCalledOnce();
    expect(savedTask(deps, 1).lifecycle).toBe("blocked");
    assertDecision(deps, "binding_conflict");
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });

  it("takes over one expired pre-submit claim with the same derived id at generation two", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    const runId = intendedId(task);
    vi.mocked(deps.getNextExpiredClaim).mockResolvedValue({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: runId,
      claimState: "claimed",
      claimHolder: "dead-holder",
      claimGeneration: 1,
      claimedAt: NOW,
      leaseExpiresAt: NOW,
    });
    vi.mocked(deps.acquireNextExpiredClaim).mockResolvedValue({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: runId,
      claimState: "claimed",
      claimHolder: "dispatcher-one",
      claimGeneration: 2,
      claimedAt: NOW,
      leaseExpiresAt: DEADLINE,
    });

    await expect(runSingleDispatch(deps)).resolves.toEqual({
      outcome: "dispatched",
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      intendedRunId: runId,
    });

    expect(deps.claimDispatch).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.controlPort.submit).toHaveBeenCalledWith(runId, expect.any(String));
    expect(deps.recordClaimProgress).toHaveBeenCalledTimes(2);
    expect(deps.recordClaimProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ claimGeneration: 2, progress: "submitted" }),
    );
    expect(deps.recordClaimProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ claimGeneration: 2, progress: "bound" }),
    );
  });

  it("adopts an expired submitted claim by replaying the derived id and binds as the new holder", async () => {
    const approved = await approvedTask();
    const task = agentTaskV1Schema.parse({
      ...approved,
      lifecycle: "dispatching",
      timestamps: {
        ...approved.timestamps,
        dispatchClaimedAt: NOW,
        updatedAt: NOW,
      },
    });
    const deps = dispatchDeps(task);
    const runId = intendedId(task);
    const preview = {
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: runId,
      claimState: "submitted" as const,
      claimHolder: "dead-holder",
      claimGeneration: 1,
      claimedAt: NOW,
      leaseExpiresAt: NOW,
    };
    vi.mocked(deps.getNextExpiredClaim).mockResolvedValue(preview);
    vi.mocked(deps.acquireNextExpiredClaim).mockResolvedValue({
      ...preview,
      claimHolder: "dispatcher-one",
      claimGeneration: 2,
      leaseExpiresAt: DEADLINE,
    });

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "dispatched",
      intendedRunId: runId,
    });

    expect(deps.controlPort.submit).toHaveBeenCalledOnce();
    expect(deps.controlPort.submit).toHaveBeenCalledWith(runId, expect.any(String));
    expect(deps.bindRun).toHaveBeenCalledOnce();
    expect(deps.bindRun).toHaveBeenCalledWith({
      workItemId: task.workItemId,
      harnessRunId: runId,
    });
    expect(deps.recordClaimProgress).toHaveBeenCalledTimes(2);
    expect(deps.recordClaimProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ claimGeneration: 2, progress: "submitted" }),
    );
    expect(deps.recordClaimProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ claimGeneration: 2, progress: "bound" }),
    );
    expect(savedTask(deps, 1)).toMatchObject({
      lifecycle: "running",
      bindings: { harnessRunId: runId },
    });
  });

  it("blocks an exhausted generation with one critical alert and no third submit", async () => {
    const approved = await approvedTask();
    const task = agentTaskV1Schema.parse({
      ...approved,
      lifecycle: "dispatching",
      timestamps: {
        ...approved.timestamps,
        dispatchClaimedAt: NOW,
        updatedAt: NOW,
      },
    });
    const deps = dispatchDeps(task);
    const runId = intendedId(task);
    const preview = {
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: runId,
      claimState: "claimed" as const,
      claimHolder: "retry-holder",
      claimGeneration: 2,
      claimedAt: NOW,
      leaseExpiresAt: NOW,
    };
    vi.mocked(deps.getNextExpiredClaim).mockResolvedValue(preview);
    vi.mocked(deps.acquireNextExpiredClaim).mockResolvedValue({
      ...preview,
      claimState: "exhausted",
      claimHolder: "dispatcher-one",
      leaseExpiresAt: undefined,
    });

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "dispatch_retry_exhausted_generation_2",
    });

    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.bindRun).not.toHaveBeenCalled();
    expect(savedTask(deps, 0).lifecycle).toBe("blocked");
    expect(deps.alertSink).toHaveBeenCalledWith(expect.objectContaining({
      severity: "critical",
      code: "dispatch_retry_exhausted",
      message: expect.stringContaining("generation 2"),
    }));
  });

  it("records one warn transition while repeated backpressure remains active", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.countInflight).mockResolvedValue(1);
    vi.mocked(deps.transitionBackpressure)
      .mockResolvedValueOnce({
        state: {
          active: true,
          observedInflight: 1,
          maxInflight: 1,
          changedAt: NOW,
        },
        changed: true,
      })
      .mockResolvedValueOnce({
        state: {
          active: true,
          observedInflight: 1,
          maxInflight: 1,
          changedAt: NOW,
        },
        changed: false,
      });

    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "backpressure",
    });
    await expect(runSingleDispatch(deps)).resolves.toMatchObject({
      outcome: "refused",
      reason: "backpressure",
    });

    expect(deps.saveTask).not.toHaveBeenCalled();
    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.recordDecision).toHaveBeenCalledOnce();
    expect(decisionRecords(deps)[0]?.proposal.why).toEqual(["backpressure"]);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(expect.objectContaining({
      severity: "warn",
      code: "dispatch_backpressure",
    }));
  });

  it("releases the lease before propagating an unexpected dependency error", async () => {
    const task = await approvedTask();
    const deps = dispatchDeps(task);
    vi.mocked(deps.listDispatchable).mockRejectedValue(
      new Error("unexpected store failure"),
    );

    await expect(runSingleDispatch(deps)).rejects.toThrow(
      "unexpected store failure",
    );

    expect(deps.controlPort.submit).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledOnce();
  });
});

function dispatchDeps(task: AgentTaskV1): DispatchDeps {
  return {
    now: vi.fn(() => new Date(NOW)),
    dispatcherId: "dispatcher-one",
    leaseTtlSeconds: 30,
    claimTtlMs: 600_000,
    maxInflight: 1,
    activePolicyIdentity: {
      version: task.approval.policyVersion,
      hash: task.approval.policyHash,
    },
    isDispatchEnabled: vi.fn(() => true),
    isHalted: vi.fn(() => false),
    listDispatchable: vi.fn(async () => [task]),
    getTask: vi.fn(async (workItemId, taskVersion) =>
      workItemId === task.workItemId && taskVersion === task.taskVersion
        ? task
        : undefined),
    saveTask: vi.fn(async () => undefined),
    acquireLease: vi.fn(async () => true),
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => true),
    claimDispatch: vi.fn(async (input) => ({
      created: true,
      acquired: true,
      claim: {
        workItemId: input.workItemId,
        taskVersion: input.taskVersion,
        approvedTaskHash: input.approvedTaskHash,
        intendedRunId: input.intendedRunId,
        claimState: "claimed" as const,
        claimHolder: input.holder,
        claimGeneration: 1,
        claimedAt: NOW,
        leaseExpiresAt: DEADLINE,
      },
    })),
    getNextExpiredClaim: vi.fn(async () => undefined),
    acquireNextExpiredClaim: vi.fn(async () => undefined),
    recordClaimProgress: vi.fn(async (input) => ({
      workItemId: input.workItemId,
      taskVersion: input.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: intendedId(task),
      claimState: input.progress,
      claimHolder: input.holder,
      claimGeneration: input.claimGeneration,
      claimedAt: NOW,
      leaseExpiresAt: DEADLINE,
    })),
    countInflight: vi.fn(async () => 0),
    transitionBackpressure: vi.fn(async (input) => ({
      state: {
        active: input.active,
        observedInflight: input.observedInflight,
        maxInflight: input.maxInflight,
        changedAt: NOW,
      },
      changed: false,
    })),
    getRunBinding: vi.fn(async () => undefined),
    bindRun: vi.fn(async () => undefined),
    loadProfileManifest: vi.fn(async () => profileFor(task)),
    prepareWorkspace: vi.fn(async (candidate) =>
      workspacePathForTask(candidate.workItemId, candidate.taskVersion)),
    writeIntentArtifact: vi.fn(async (_bytes, workItemId) =>
      `/tmp/${workItemId}-intent.json`),
    controlPort: {
      submit: vi.fn(async (runId) => runId),
      cancel: vi.fn(async () => undefined),
    },
    recordDecision: vi.fn(async () => undefined),
    alertSink: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

function assertRefusal(
  deps: DispatchDeps,
  reason: string,
  alert: { severity: "warn" | "critical"; code: string } = {
    severity: "warn",
    code: "dispatch_refusal",
  },
): void {
  expect(deps.controlPort.submit).not.toHaveBeenCalled();
  expect(deps.saveTask).toHaveBeenCalledOnce();
  expect(savedTask(deps, 0).lifecycle).toBe("blocked");
  assertDecision(deps, reason, alert);
  expect(deps.releaseLease).toHaveBeenCalledOnce();
}

function assertDecision(
  deps: DispatchDeps,
  reason: string,
  alert: { severity: "warn" | "critical"; code: string } = {
    severity: "warn",
    code: "dispatch_refusal",
  },
): void {
  const records = decisionRecords(deps);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    decisionType: "dispatch_refusal",
    proposal: { why: [reason] },
    effects: { mutates: false },
    next: { owner: "operator" },
  });
  expect(deps.alertSink).toHaveBeenCalledOnce();
  expect(deps.alertSink).toHaveBeenCalledWith(
    expect.objectContaining({
      severity: alert.severity,
      code: alert.code,
      workItemId: expect.any(String),
    }),
  );
}

function savedTask(deps: DispatchDeps, call: number): AgentTaskV1 {
  const task = vi.mocked(deps.saveTask).mock.calls[call]?.[0];
  if (!task) throw new Error(`No saved task at call ${call}`);
  return task;
}

function decisionRecords(deps: DispatchDeps): HermesDecisionRecordV2[] {
  return vi.mocked(deps.recordDecision).mock.calls.map(([record]) => record);
}

function intendedId(task: AgentTaskV1): string {
  return deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    task.approval.approvedTaskHash!,
  );
}

function profileFor(task: AgentTaskV1): PilotProfileManifest {
  return {
    profileId: task.intent.profile,
    strategies: ["direct_execution"],
    capabilities: CAPABILITIES.map((capability) => ({ ...capability })),
  };
}

async function approvedTask(): Promise<AgentTaskV1> {
  const base = agentTaskFixture();
  const withApproval = {
    ...base,
    lifecycle: "approved",
    requestedAuthority: {
      ...base.requestedAuthority,
      grants: CAPABILITIES.map((capability) => ({
        capabilityId: capability.id,
        resource: base.repository.nameWithOwner,
        constraints: {},
      })),
    },
    deadline: DEADLINE,
    approval: {
      ...base.approval,
      status: "approved",
      actor: { type: "operator", id: "operator-one" },
      decidedAt: "2026-07-24T11:55:00.000Z",
      approvedTaskHash: OTHER_HASH,
    },
    timestamps: {
      ...base.timestamps,
      approvedAt: "2026-07-24T11:55:00.000Z",
      updatedAt: "2026-07-24T11:55:00.000Z",
    },
  } as AgentTaskV1;
  const artifact = await buildTaskIntentArtifact(withApproval, {
    workspacePath: workspacePathForTask(
      withApproval.workItemId,
      withApproval.taskVersion,
    ),
  });
  return reapprove({
    ...withApproval,
    intent: {
      ...withApproval.intent,
      templateRef: {
        ...withApproval.intent.templateRef,
        uri: `artifact://sha256/${artifact.templateHash.slice("sha256:".length)}`,
        sha256: artifact.templateHash,
      },
      templateHash: artifact.templateHash,
    },
  });
}

async function reapprove(task: AgentTaskV1): Promise<AgentTaskV1> {
  const withPlaceholder = agentTaskV1Schema.parse({
    ...task,
    approval: {
      ...task.approval,
      approvedTaskHash: OTHER_HASH,
    },
  });
  const approvedTaskHash = await hashAgentTaskApprovalPayload(withPlaceholder);
  return agentTaskV1Schema.parse({
    ...withPlaceholder,
    approval: {
      ...withPlaceholder.approval,
      approvedTaskHash,
    },
  });
}

function agentTaskFixture(): AgentTaskV1 {
  return agentTaskV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/agent-integration/agent-task-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
}
