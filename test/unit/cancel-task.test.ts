import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentTaskV1Schema,
  type AgentTaskLifecycle,
  type AgentTaskV1,
} from "@avg/schemas";
import {
  deriveIntendedRunId,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  cancelAgentTask,
  type CancelAgentTaskDeps,
} from "../../services/harness-dispatcher/src/cancel-task.js";
import {
  readHaltFile,
} from "../../services/harness-dispatcher/src/dispatch-attempt.js";
import {
  createHarnessControlPort,
  HarnessControlError,
  type HarnessCommandExecutor,
} from "../../services/harness-dispatcher/src/harness-control-port.js";
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-07-25T14:00:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("operator AgentTask cancellation", () => {
  it("refuses a non-operator actor", async () => {
    const task = await activeTask();
    const deps = cancelDeps(task);

    await expect(cancelAgentTask({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      actor: { type: "hermes", id: "hermes-one" },
      reason: "Operator did not request this.",
    }, deps)).rejects.toThrow("Only an operator may cancel");

    expect(deps.getTask).not.toHaveBeenCalled();
    expect(deps.controlPort.cancel).not.toHaveBeenCalled();
    expect(deps.saveTask).not.toHaveBeenCalled();
  });

  it("works while dispatch is disabled and is independent of HALT", async () => {
    const task = await activeTask();
    const execute = vi.fn<HarnessCommandExecutor>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const deps = cancelDeps(task, {
      // This is the real disabled control port. cancel is deliberately not
      // coupled to a dispatch-enabled or HALT predicate.
      controlPort: createHarnessControlPort({
        enabled: false,
        execute,
      }),
    });

    const cancelled = await cancelAgentTask(cancelInput(task), deps);

    expect(cancelled).toMatchObject({
      lifecycle: "cancelled",
      timestamps: {
        terminalAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "harness",
      ["run", "cancel", RUN_ID],
      { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
    );
    expect(deps.alertSink).not.toHaveBeenCalled();
  });

  it("works while HALT_FILE is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-cancel-halt-"));
    const haltFile = path.join(root, "HALT");
    const previous = process.env.HALT_FILE;
    try {
      await writeFile(haltFile, "halt\n", "utf8");
      process.env.HALT_FILE = haltFile;
      expect(readHaltFile()).toBe(true);

      const task = await activeTask();
      const deps = cancelDeps(task);
      await expect(cancelAgentTask(cancelInput(task), deps)).resolves
        .toMatchObject({ lifecycle: "cancelled" });

      expect(deps.controlPort.cancel).toHaveBeenCalledWith(RUN_ID);
    } finally {
      if (previous === undefined) delete process.env.HALT_FILE;
      else process.env.HALT_FILE = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "handoff_ready",
    "failed",
    "cancelled",
  ] satisfies AgentTaskLifecycle[])(
    "refuses an already-terminal %s task",
    async (lifecycle) => {
      const task = await activeTask(lifecycle);
      const deps = cancelDeps(task);

      await expect(cancelAgentTask(cancelInput(task), deps)).rejects.toThrow(
        "Terminal AgentTasks cannot be cancelled",
      );

      expect(deps.controlPort.cancel).not.toHaveBeenCalled();
      expect(deps.saveTask).not.toHaveBeenCalled();
      expect(deps.recordDecision).not.toHaveBeenCalled();
    },
  );

  it("still cancels the AgentTask and flags an unacknowledged control failure", async () => {
    const task = await activeTask();
    const deps = cancelDeps(task, {
      controlPort: {
        cancel: vi.fn(async () => {
          throw new HarnessControlError(
            "cli_timeout",
            "Harness control command timed out",
            true,
          );
        }),
      },
    });

    const cancelled = await cancelAgentTask(cancelInput(task), deps);

    expect(cancelled.lifecycle).toBe("cancelled");
    expect(savedTasks(deps)).toEqual([
      expect.objectContaining({
        lifecycle: "cancelled",
        timestamps: expect.objectContaining({
          terminalAt: NOW.toISOString(),
        }),
      }),
    ]);
    expect(recordedDecisions(deps)).toEqual([
      expect.objectContaining({
        decisionType: "escalation",
        proposal: expect.objectContaining({
          why: [
            "Stop this supervised task.",
            "harness_cancel_unacknowledged_cli_timeout",
          ],
        }),
        approval: expect.objectContaining({
          actor: { type: "operator", id: "operator-one" },
        }),
        next: expect.objectContaining({
          owner: "operator",
          blockedBy: ["harness_cancel_unacknowledged_cli_timeout"],
        }),
      }),
    ]);
    expect(deps.alertSink).toHaveBeenCalledOnce();
    expect(deps.alertSink).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        code: "cancel_unacknowledged",
        harnessRunId: RUN_ID,
      }),
    );
  });

  it("cancels a derivable intended run when the read port confirms it exists", async () => {
    const task = agentTaskV1Schema.parse({
      ...await activeTask("dispatching"),
      bindings: undefined,
      timestamps: {
        ...(await activeTask("dispatching")).timestamps,
        runBoundAt: undefined,
      },
    });
    const intendedRunId = deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      task.approval.approvedTaskHash!,
    );
    const deps = cancelDeps(task, {
      getRunBinding: vi.fn(async () => undefined),
      readPort: {
        readRun: vi.fn(async () => ({
          status: {
            runId: intendedRunId,
            state: "executing",
            attempt: 1,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
          events: [],
          deliverables: [],
        })),
      },
    });

    const cancelled = await cancelAgentTask(cancelInput(task), deps);

    expect(deps.readPort.readRun).toHaveBeenCalledWith({
      harnessRunId: intendedRunId,
    });
    expect(deps.controlPort.cancel).toHaveBeenCalledWith(intendedRunId);
    expect(cancelled.bindings?.harnessRunId).toBe(intendedRunId);
  });
});

function cancelInput(task: AgentTaskV1) {
  return {
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    actor: { type: "operator" as const, id: "operator-one" },
    reason: "Stop this supervised task.",
  };
}

function cancelDeps(
  task: AgentTaskV1,
  overrides: Partial<CancelAgentTaskDeps> = {},
): CancelAgentTaskDeps {
  return {
    now: overrides.now ?? vi.fn(() => NOW),
    getTask: overrides.getTask ?? vi.fn(async () => task),
    saveTask: overrides.saveTask ?? vi.fn(async (saved) => saved),
    getRunBinding: overrides.getRunBinding ?? vi.fn(async () => ({
      workItemId: task.workItemId,
      harnessRunId: RUN_ID,
      boundAt: "2026-07-25T12:06:00.000Z",
    })),
    readPort: overrides.readPort ?? {
      readRun: vi.fn(async () => {
        throw new Error("unexpected Harness read");
      }),
    },
    controlPort: overrides.controlPort ?? {
      cancel: vi.fn(async () => undefined),
    },
    recordDecision:
      overrides.recordDecision ?? vi.fn(async () => undefined),
    alertSink: overrides.alertSink ?? vi.fn(async () => undefined),
  };
}

async function activeTask(
  lifecycle: AgentTaskLifecycle = "running",
): Promise<AgentTaskV1> {
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
  return agentTaskV1Schema.parse({
    ...raw,
    lifecycle,
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
      ...(lifecycle === "handoff_ready"
        || lifecycle === "failed"
        || lifecycle === "cancelled"
        ? { terminalAt: "2026-07-25T13:00:00.000Z" }
        : {}),
      updatedAt: "2026-07-25T12:06:00.000Z",
    },
    bindings: {
      harnessRunId: RUN_ID,
    },
  });
}

function savedTasks(deps: CancelAgentTaskDeps): AgentTaskV1[] {
  return vi.mocked(deps.saveTask!).mock.calls.map(([task]) => task);
}

function recordedDecisions(
  deps: CancelAgentTaskDeps,
): Parameters<NonNullable<CancelAgentTaskDeps["recordDecision"]>>[0][] {
  return vi.mocked(deps.recordDecision!).mock.calls.map(([record]) => record);
}
