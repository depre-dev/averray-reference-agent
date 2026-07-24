import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createHarnessCliReadPort,
  HarnessReadError,
  parseHarnessEvents,
  parseHarnessStatus,
  type HarnessCommandExecutor,
  type HarnessReadPort,
} from "../../services/slack-operator/src/harness-read-port.js";
import {
  collectHarnessRunProjections,
  projectHarnessRun,
} from "../../services/slack-operator/src/harness-run-projection.js";
import {
  harnessProjectionEnabled,
  harnessProjectionReadTimeoutMs,
  parseHarnessRunRegistry,
  type HarnessRunBinding,
} from "../../services/slack-operator/src/harness-run-registry.js";
import { buildHermesBoardSnapshotFromMonitor } from "../../services/slack-operator/src/monitor-hermes-board.js";
import { buildV2BoardSnapshot } from "../../services/slack-operator/src/monitor-v2.js";

const FIXTURE_ROOT = "test/fixtures/harness-integration";
const NOW = new Date("2026-07-23T12:11:10.000Z");

function textFixture(name: string): string {
  return readFileSync(`${FIXTURE_ROOT}/${name}`, "utf8");
}

function registryFixture() {
  return parseHarnessRunRegistry(JSON.parse(textFixture("pilot-registry-v1.json")));
}

function bindingAt(index: number): HarnessRunBinding {
  return registryFixture().bindings[index]!;
}

function capturedExecutor(calls: string[][]): HarnessCommandExecutor {
  return async (_command, args) => {
    calls.push([...args]);
    const runId = args[2];
    const verb = args[1];
    const prefix = runId?.startsWith("1111")
      ? "successful"
      : runId?.startsWith("2222")
        ? "failed"
        : "quarantined";
    const name = verb === "status"
      ? `${prefix}-status.txt`
      : verb === "events"
        ? `${prefix}-events.txt`
        : prefix !== "quarantined"
          ? `${prefix}-deliverables.txt`
          : undefined;
    return {
      code: 0,
      stdout: name ? textFixture(name) : "",
      stderr: "",
    };
  };
}

describe("INT-1 Harness pilot registry", () => {
  it("keeps projection off by default and bounds the read timeout", () => {
    expect(harnessProjectionEnabled({})).toBe(false);
    expect(harnessProjectionEnabled({ HARNESS_PROJECTION_ENABLED: "false" })).toBe(false);
    expect(harnessProjectionEnabled({ HARNESS_PROJECTION_ENABLED: "true" })).toBe(true);
    expect(harnessProjectionReadTimeoutMs({})).toBe(5_000);
    expect(harnessProjectionReadTimeoutMs({ HARNESS_PROJECTION_READ_TIMEOUT_MS: "1" })).toBe(250);
    expect(harnessProjectionReadTimeoutMs({ HARNESS_PROJECTION_READ_TIMEOUT_MS: "999999" })).toBe(30_000);
  });

  it("loads strict, secret-free, immutable pilot bindings", () => {
    const registry = registryFixture();
    expect(registry.schemaVersion).toBe(1);
    expect(registry.bindings).toHaveLength(3);
    expect(registry.bindings[0]?.staleAfterSeconds).toBe(300);
  });

  it("rejects unknown versions, duplicate identities, undeclared fields, and secret-like data", () => {
    const input = JSON.parse(textFixture("pilot-registry-v1.json")) as Record<string, unknown>;
    expect(() => parseHarnessRunRegistry({ ...input, schemaVersion: 2 })).toThrow(/invalid/i);
    expect(() => parseHarnessRunRegistry({ ...input, undeclared: true })).toThrow(/invalid/i);

    const bindings = structuredClone(input.bindings) as Array<Record<string, unknown>>;
    bindings[1]!.workItemId = bindings[0]!.workItemId;
    expect(() => parseHarnessRunRegistry({ ...input, bindings })).toThrow(/duplicate workItemId/);

    const optionBindings = structuredClone(input.bindings) as Array<Record<string, unknown>>;
    optionBindings[0]!.harnessRunId = "--help";
    expect(() => parseHarnessRunRegistry({ ...input, bindings: optionBindings })).toThrow(/invalid/i);

    const secretBindings = structuredClone(input.bindings) as Array<Record<string, unknown>>;
    secretBindings[0]!.apiToken = "sk-example-example-example";
    expect(() => parseHarnessRunRegistry({ ...input, bindings: secretBindings }))
      .toThrow(/secret-like value/);
  });
});

describe("INT-1 fixed Harness read port", () => {
  it("uses only status, events, and terminal deliverables for a successful immutable run id", async () => {
    const calls: string[][] = [];
    const read = await createHarnessCliReadPort({ execute: capturedExecutor(calls) })
      .readRun(bindingAt(0));

    expect(read.status).toMatchObject({
      runId: "11111111-1111-4111-8111-111111111111",
      state: "completed",
      outcome: "completed",
      egressPolicy: "deny",
    });
    expect(read.events.some((event) => event.type === "RunCompleted")).toBe(true);
    expect(read.events.at(-1)).toMatchObject({
      type: "ArtifactCreated",
      payload: { kind: "episode" },
    });
    expect(read.deliverables[0]?.artifact.sha256)
      .toBe("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(calls).toEqual([
      ["run", "status", "11111111-1111-4111-8111-111111111111"],
      ["run", "events", "11111111-1111-4111-8111-111111111111"],
      ["run", "deliverables", "11111111-1111-4111-8111-111111111111"],
    ]);
  });

  it("does not request deliverables for a quarantined non-terminal record", async () => {
    const calls: string[][] = [];
    const read = await createHarnessCliReadPort({ execute: capturedExecutor(calls) })
      .readRun(bindingAt(2));
    expect(read.status.state).toBe("quarantined");
    expect(read.status.outcome).toBeUndefined();
    expect(calls.map((args) => args[1])).toEqual(["status", "events"]);
  });

  it("refuses unknown run states and event versions visibly", () => {
    const secretState = "future_state_with_password";
    const status = textFixture("successful-status.txt").replace("state=completed", `state=${secretState}`);
    expect(() => parseHarnessStatus(status, bindingAt(0).harnessRunId))
      .toThrow(/unsupported run state/);
    expect(() => parseHarnessStatus(status, bindingAt(0).harnessRunId))
      .not.toThrow(new RegExp(secretState));
    const secretEvent = "FutureEventWithPassword";
    expect(() => parseHarnessEvents(`1 ${secretEvent} payload={"schemaVersion":2}\n`))
      .toThrow(/unsupported event type/);
    expect(() => parseHarnessEvents(`1 ${secretEvent} payload={"schemaVersion":2}\n`))
      .not.toThrow(new RegExp(secretEvent));
  });

  it("propagates bounded read failures without leaking CLI credentials", async () => {
    const port = createHarnessCliReadPort({
      execute: async () => ({
        code: 2,
        stdout: "",
        stderr: "connection failed for postgresql://pilot:super-secret@example.invalid/harness",
      }),
    });
    await expect(port.readRun(bindingAt(0))).rejects.toThrow(/Harness data source is unavailable/);
    await expect(port.readRun(bindingAt(0))).rejects.not.toThrow(/super-secret/);

    const timeoutPort = createHarnessCliReadPort({
      execute: async () => {
        throw new HarnessReadError("cli_timeout", "Harness read command timed out", true);
      },
    });
    await expect(timeoutPort.readRun(bindingAt(0))).rejects.toMatchObject({
      code: "cli_timeout",
      retryable: true,
    });
  });

  it("contains no mutating Harness argv path", () => {
    const source = readFileSync("services/slack-operator/src/harness-read-port.ts", "utf8");
    for (const verb of ["submit", "approve", "deny", "cancel", "release"]) {
      expect(source).not.toContain(`["run", "${verb}"`);
    }
    expect(source).not.toMatch(/\["(?:skills|wallet|github|artifact)",/);
    expect(() => createHarnessCliReadPort({ command: "bash" })).toThrow(/executable named harness/);
  });
});

describe("INT-1 deterministic AgentRunProjection", () => {
  it("projects successful and failed CLI fixtures deterministically", async () => {
    const port = createHarnessCliReadPort({ execute: capturedExecutor([]) });
    const successfulRead = await port.readRun(bindingAt(0));
    const first = projectHarnessRun(bindingAt(0), successfulRead, { now: NOW });
    const second = projectHarnessRun(bindingAt(0), successfulRead, { now: NOW });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      workItemId: "work-harness-success-001",
      run: { state: "completed", terminal: true, outcome: "completed" },
      source: { health: "healthy" },
      verification: {
        status: "passed",
        decisionHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      budget: { modelTokensUsed: 150, toolCallsUsed: 1 },
    });
    expect(first.artifacts).toHaveLength(1);

    const failed = projectHarnessRun(
      bindingAt(1),
      await port.readRun(bindingAt(1)),
      { now: NOW },
    );
    expect(failed).toMatchObject({
      run: { state: "failed", terminal: true, outcome: "failed" },
      verification: {
        status: "failed",
        decisionHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      failure: {
        code: "verification_failed",
        message: "verification_failed",
        retryable: true,
      },
    });
  });

  it("keeps quarantined runs visible with structured failure and no invented outcome", async () => {
    const port = createHarnessCliReadPort({ execute: capturedExecutor([]) });
    const projection = projectHarnessRun(
      bindingAt(2),
      await port.readRun(bindingAt(2)),
      { now: new Date("2026-07-23T12:02:10.000Z") },
    );
    expect(projection.run).toMatchObject({ state: "quarantined", terminal: false });
    expect(projection.run.outcome).toBeUndefined();
    expect(projection.failure).toMatchObject({
      code: "safety_tripwire_triggered",
      retryable: false,
    });
  });

  it("redacts failure details and never derives a failure code from secret text", async () => {
    const port = createHarnessCliReadPort({ execute: capturedExecutor([]) });
    const read = await port.readRun(bindingAt(1));
    const projection = projectHarnessRun(
      bindingAt(1),
      {
        ...read,
        status: {
          ...read.status,
          outcomeReason: "password=hunter2",
        },
      },
      { now: NOW },
    );
    expect(projection.run.reason).toBe("password=[redacted]");
    expect(projection.failure).toMatchObject({
      code: "harness_failed",
      message: "password=[redacted]",
    });
    expect(JSON.stringify(projection)).not.toContain("hunter2");
  });

  it("marks old reads stale and rejects a live/pinned manifest mismatch", async () => {
    const port = createHarnessCliReadPort({ execute: capturedExecutor([]) });
    const read = await port.readRun(bindingAt(0));
    const oldTerminal = projectHarnessRun(bindingAt(0), read, {
      now: new Date("2026-07-23T12:20:00.000Z"),
    });
    expect(oldTerminal.source.health).toBe("healthy");

    const stale = projectHarnessRun(bindingAt(2), await port.readRun(bindingAt(2)), {
      now: new Date("2026-07-23T12:20:00.000Z"),
    });
    expect(stale.source).toMatchObject({ health: "stale" });
    expect(stale.source.reason).toMatch(/not updated/);

    expect(() => projectHarnessRun(
      {
        ...bindingAt(0),
        manifest: {
          ...bindingAt(0).manifest,
          network: { allowlist: ["example.com"] },
        },
      },
      read,
      { now: NOW },
    )).toThrow(/does not match the pinned/);

    expect(() => projectHarnessRun(
      {
        ...bindingAt(0),
        manifest: {
          ...bindingAt(0).manifest,
          hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
      },
      read,
      { now: NOW },
    )).toThrow(/final manifest hash/);
  });

  it("turns source denial into a visible unavailable failure, never a healthy projection", async () => {
    const deniedPort: HarnessReadPort = {
      readRun: async () => {
        throw new HarnessReadError("cli_failed", "Harness data source refused the read", true);
      },
    };
    const snapshot = await collectHarnessRunProjections(
      { ...registryFixture(), bindings: [bindingAt(0)] },
      deniedPort,
      { now: NOW },
    );
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures[0]).toMatchObject({
      code: "cli_failed",
      message: "Harness data source refused the read",
      retryable: true,
    });
  });
});

describe("INT-1 monitor correlation", () => {
  it("renders one Harness-tagged work-queue card with structured facts only", async () => {
    const registry = { ...registryFixture(), bindings: [bindingAt(0)] };
    const harnessRuns = await collectHarnessRunProjections(
      registry,
      createHarnessCliReadPort({ execute: capturedExecutor([]) }),
      { now: NOW },
    );
    const raw = {
      generatedAt: NOW.toISOString(),
      active: [
        {
          correlationId: bindingAt(0).correlationId,
          title: "Legacy duplicate for the same work item",
          intent: "coding",
          status: "running",
        },
      ],
      recent: [],
      harnessRuns,
    };
    const board = buildV2BoardSnapshot(raw, { now: () => NOW });
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]).toMatchObject({
      id: "work-harness-success-001",
      correlationId: "correlation-harness-success-001",
      lane: "codex-needed",
      type: "task",
      agentType: "harness",
      taskStatus: "completed",
      harnessRun: {
        harnessRunId: "11111111-1111-4111-8111-111111111111",
      },
    });

    const hermesBoard = buildHermesBoardSnapshotFromMonitor(raw)!;
    expect(hermesBoard.items).toHaveLength(1);
    const context = JSON.stringify(hermesBoard.items?.[0]);
    expect(context).toContain('"sourceHealth":"healthy"');
    expect(context).not.toContain("ModelRequested");
    expect(context).not.toContain("input_tokens");
  });

  it("routes failed and source-unavailable Harness records to attention", async () => {
    const failedRuns = await collectHarnessRunProjections(
      { ...registryFixture(), bindings: [bindingAt(1)] },
      createHarnessCliReadPort({ execute: capturedExecutor([]) }),
      { now: NOW },
    );
    const failedCard = buildV2BoardSnapshot({
      generatedAt: NOW.toISOString(),
      active: [],
      recent: [],
      harnessRuns: failedRuns,
    }, { now: () => NOW }).cards[0]!;
    expect(failedCard).toMatchObject({
      lane: "needs-attention",
      agentType: "harness",
      taskStatus: "failed",
      failureReason: "verification_failed",
    });

    const unavailable = await collectHarnessRunProjections(
      { ...registryFixture(), bindings: [bindingAt(0)] },
      {
        readRun: async () => {
          throw new HarnessReadError("cli_failed", "Harness data source refused the read", true);
        },
      },
      { now: NOW },
    );
    const unavailableCard = buildV2BoardSnapshot({
      generatedAt: NOW.toISOString(),
      active: [],
      recent: [],
      harnessRuns: unavailable,
    }, { now: () => NOW }).cards[0]!;
    expect(unavailableCard).toMatchObject({
      lane: "needs-attention",
      state: "source-offline",
      sourceFailure: {
        source: "harness",
        code: "cli_failed",
      },
    });
  });
});
