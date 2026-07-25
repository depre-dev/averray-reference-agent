import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDispatcherProcess,
  createIntentArtifactWriter,
  parseDispatcherConfig,
  type DispatcherConfig,
  type DispatcherHeartbeat,
  type DispatcherProcessDeps,
  type DispatcherScheduler,
} from "../../services/harness-dispatcher/src/index.js";
import {
  buildTaskIntentArtifact,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  agentTaskV1Schema,
} from "../../packages/schemas/src/index.js";
import type {
  DispatchAttemptResult,
  DispatchDeps,
} from "../../services/harness-dispatcher/src/dispatch-attempt.js";
import {
  runSingleDispatch,
} from "../../services/harness-dispatcher/src/dispatch-attempt.js";

const NOW = new Date("2026-07-25T12:00:00.000Z");

describe("Harness dispatcher process", () => {
  it("parses startup config once with bounded polling and lease values", () => {
    expect(parseDispatcherConfig({
      HARNESS_DISPATCHER_ID: "dispatcher-one",
      HARNESS_DISPATCH_POLL_INTERVAL_MS: "1",
      HARNESS_DISPATCH_LEASE_TTL_SECONDS: "9999",
      HARNESS_DISPATCH_INTENT_DIR: "./intents",
      HARNESS_DISPATCH_HEARTBEAT_PATH: "./heartbeat.json",
      HARNESS_BIN: "/opt/harness/bin/harness",
    }, {
      hostname: "host",
      pid: 42,
      tmpdir: "/tmp",
    })).toMatchObject({
      dispatcherId: "dispatcher-one",
      pollIntervalMs: 5_000,
      leaseTtlSeconds: 900,
      harnessBin: "/opt/harness/bin/harness",
    });

    expect(parseDispatcherConfig({}, {
      hostname: "host",
      pid: 42,
      tmpdir: "/tmp",
    })).toEqual({
      dispatcherId: "host-42",
      pollIntervalMs: 15_000,
      leaseTtlSeconds: 120,
      intentDir: "/tmp/averray-reference-agent/harness-dispatch-intents",
      heartbeatPath:
        "/tmp/averray-reference-agent/harness-dispatcher-heartbeat.json",
      harnessBin: "harness",
    });
  });

  it("reports disabled honestly while the guarded attempt touches no store dependency", async () => {
    const attemptDeps = dispatchAttemptDeps(false, false);
    const harness = processHarness({
      runAttempt: vi.fn(() => runSingleDispatch(attemptDeps)),
      isDispatchEnabled: vi.fn(() => false),
    });

    await expect(harness.process.tick()).resolves.toEqual({
      outcome: "disabled",
    });

    expect(harness.deps.runAttempt).toHaveBeenCalledOnce();
    expect(attemptDeps.acquireLease).not.toHaveBeenCalled();
    expect(attemptDeps.listDispatchable).not.toHaveBeenCalled();
    expect(heartbeats(harness.deps)).toEqual([
      expect.objectContaining({
        status: "disabled",
        lastOutcome: "disabled",
      }),
    ]);
    expect(heartbeats(harness.deps)).not.toContainEqual(
      expect.objectContaining({ status: "dispatching" }),
    );

    await harness.process.shutdown();
    expect(harness.deps.releaseLease).not.toHaveBeenCalled();
    expect(heartbeats(harness.deps).at(-1)).toMatchObject({
      status: "disabled",
    });
  });

  it("reports HALT honestly without starting store work", async () => {
    const attemptDeps = dispatchAttemptDeps(true, true);
    const harness = processHarness({
      runAttempt: vi.fn(() => runSingleDispatch(attemptDeps)),
      isHalted: vi.fn(() => true),
    });

    await expect(harness.process.tick()).resolves.toEqual({
      outcome: "halted",
    });

    expect(harness.deps.runAttempt).toHaveBeenCalledOnce();
    expect(attemptDeps.acquireLease).not.toHaveBeenCalled();
    expect(attemptDeps.listDispatchable).not.toHaveBeenCalled();
    expect(heartbeats(harness.deps)).toEqual([
      expect.objectContaining({
        status: "halted",
        lastOutcome: "halted",
      }),
    ]);
  });

  it("shares an in-flight tick so a slow attempt never overlaps", async () => {
    const pending = deferred<DispatchAttemptResult>();
    const runAttempt = vi.fn(() => pending.promise);
    const harness = processHarness({ runAttempt });

    const first = harness.process.tick();
    const second = harness.process.tick();

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(runAttempt).toHaveBeenCalledOnce();
    });
    pending.resolve({ outcome: "idle" });
    await expect(first).resolves.toEqual({ outcome: "idle" });
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(heartbeats(harness.deps).map(({ status }) => status)).toEqual([
      "dispatching",
      "idle",
    ]);
  });

  it("still runs exactly one attempt when the dispatching heartbeat fails", async () => {
    const runAttempt = vi.fn(async () => ({ outcome: "idle" as const }));
    const writeHeartbeat = vi.fn()
      .mockRejectedValueOnce(new Error("heartbeat unavailable"))
      .mockResolvedValueOnce(undefined);
    const harness = processHarness({ runAttempt, writeHeartbeat });

    await expect(harness.process.tick()).resolves.toEqual({
      outcome: "idle",
    });

    expect(runAttempt).toHaveBeenCalledOnce();
    expect(harness.deps.logger.warn).toHaveBeenCalledWith(
      { errorName: "Error", status: "dispatching" },
      "Harness dispatcher heartbeat could not be written",
    );
    expect(heartbeats(harness.deps).at(-1)).toMatchObject({
      status: "idle",
      lastOutcome: "idle",
    });
  });

  it.each([
    {
      outcome: "refused" as const,
      workItemId: "work-1",
      taskVersion: 1,
      reason: "attenuation_failed",
    },
    {
      outcome: "submit_failed" as const,
      workItemId: "work-1",
      taskVersion: 1,
      intendedRunId: "00000000-0000-4000-8000-000000000001",
      reason: "submit_refused" as const,
      ambiguous: false,
    },
  ])("warns operators when an attempt is $outcome", async (result) => {
    const harness = processHarness({
      runAttempt: vi.fn(async () => result),
    });

    await expect(harness.process.tick()).resolves.toEqual(result);

    expect(harness.deps.logger.info).toHaveBeenCalledOnce();
    expect(harness.deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: result.outcome }),
      "Harness dispatch attempt requires attention",
    );
  });

  it("shutdown awaits the active attempt, releases the lease, and flushes a final heartbeat", async () => {
    const pending = deferred<DispatchAttemptResult>();
    const harness = processHarness({
      runAttempt: vi.fn(() => pending.promise),
    });

    const tick = harness.process.tick();
    await vi.waitFor(() => {
      expect(harness.deps.runAttempt).toHaveBeenCalledOnce();
    });
    const shutdown = harness.process.shutdown();
    expect(harness.deps.releaseLease).not.toHaveBeenCalled();

    pending.resolve({ outcome: "idle" });
    await tick;
    await shutdown;

    expect(harness.deps.releaseLease).toHaveBeenCalledOnce();
    expect(harness.deps.releaseLease).toHaveBeenCalledWith("dispatcher-one");
    expect(heartbeats(harness.deps).at(-1)).toMatchObject({
      status: "idle",
      lastOutcome: "idle",
      message: "Harness dispatcher stopped after releasing its lease.",
    });
  });

  it("catches a failed attempt, logs an error heartbeat, and schedules the next tick", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler: DispatcherScheduler = {
      setTimeout: vi.fn((callback) => {
        callbacks.push(callback);
        return { hasRef: () => true } as NodeJS.Timeout;
      }),
      clearTimeout: vi.fn(),
    };
    const runAttempt = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ outcome: "idle" });
    const harness = processHarness({ runAttempt, scheduler });

    harness.process.start();
    await vi.waitFor(() => {
      expect(runAttempt).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);
    });
    expect(heartbeats(harness.deps)).toContainEqual(
      expect.objectContaining({
        status: "error",
        lastOutcome: "error",
      }),
    );
    expect(harness.deps.logger.warn).toHaveBeenCalledWith(
      { errorName: "Error" },
      "Harness dispatch attempt failed",
    );

    callbacks.shift()?.();
    await vi.waitFor(() => {
      expect(runAttempt).toHaveBeenCalledTimes(2);
      expect(callbacks).toHaveLength(1);
    });
    expect(heartbeats(harness.deps).at(-1)).toMatchObject({
      status: "idle",
      lastOutcome: "idle",
    });

    await harness.process.shutdown();
    expect(scheduler.clearTimeout).toHaveBeenCalledOnce();
  });

  it("writes canonical intent bytes to the configured versioned absolute path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-intent-test-"));
    try {
      const task = agentTaskV1Schema.parse(JSON.parse(
        await readFile(
          new URL(
            "../fixtures/agent-integration/agent-task-v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ));
      const artifact = await buildTaskIntentArtifact(task, {
        workspacePath: workspacePathForTask(
          task.workItemId,
          task.taskVersion,
        ),
      });
      const writer = createIntentArtifactWriter(root);

      const target = await writer(artifact.canonicalBytes, task.workItemId);

      expect(target).toBe(path.join(
        root,
        `${task.workItemId}-v${task.taskVersion}.json`,
      ));
      expect(path.isAbsolute(target)).toBe(true);
      await expect(readFile(target, "utf8")).resolves.toBe(
        artifact.canonicalBytes,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function processHarness(
  overrides: Partial<DispatcherProcessDeps> = {},
): {
  process: ReturnType<typeof createDispatcherProcess>;
  deps: DispatcherProcessDeps;
} {
  const deps: DispatcherProcessDeps = {
    runAttempt: overrides.runAttempt ?? vi.fn(async () => ({ outcome: "idle" })),
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
        throw new Error("Unexpected scheduled timer in direct tick test");
      }),
      clearTimeout: vi.fn(),
    },
  };
  return {
    process: createDispatcherProcess(dispatcherConfig(), deps),
    deps,
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

function dispatchAttemptDeps(
  enabled: boolean,
  halted: boolean,
): DispatchDeps {
  return {
    now: vi.fn(() => NOW),
    dispatcherId: "dispatcher-one",
    leaseTtlSeconds: 120,
    isDispatchEnabled: vi.fn(() => enabled),
    isHalted: vi.fn(() => halted),
    listDispatchable: vi.fn(async () => []),
    saveTask: vi.fn(async () => undefined),
    acquireLease: vi.fn(async () => true),
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => true),
    claimDispatch: vi.fn(async () => undefined),
    getRunBinding: vi.fn(async () => undefined),
    bindRun: vi.fn(async () => undefined),
    loadProfileManifest: vi.fn(async (profileId) => ({
      profileId,
      strategies: ["direct_execution"],
      capabilities: [],
    })),
    prepareWorkspace: vi.fn(async () => "/workspace"),
    writeIntentArtifact: vi.fn(async () => "/intent.json"),
    controlPort: {
      submit: vi.fn(async (runId) => runId),
      cancel: vi.fn(async () => undefined),
    },
    recordDecision: vi.fn(async () => undefined),
  };
}

function heartbeats(deps: DispatcherProcessDeps): DispatcherHeartbeat[] {
  return vi.mocked(deps.writeHeartbeat).mock.calls.map(([heartbeat]) =>
    heartbeat);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
