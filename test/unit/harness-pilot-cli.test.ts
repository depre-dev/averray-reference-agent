import { describe, expect, it, vi } from "vitest";

import {
  handleApprove,
  parsePilotArgs,
  runPilotCli,
} from "../../scripts/ops/harness-pilot.mjs";

const HASH = `sha256:${"a".repeat(64)}`;
const VERIFIER_HASH = `sha256:${"b".repeat(64)}`;
const RUN_ID = "11111111-1111-5111-8111-111111111111";

describe("Harness pilot CLI", () => {
  it("proposes a pending task and never approves or submits it", async () => {
    const output: string[] = [];
    const services = pilotServices();

    const exitCode = await runPilotCli([
      "propose",
      "--fixture",
      "docs-fix",
      "--work-item",
      "ceremony-docs-007",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
        HARNESS_DISPATCH_ARTIFACT_DIR: "/tmp/pilot-artifacts",
      },
      services,
      output: (line: string) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(services.proposeAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "ceremony-docs-007",
        correlationId: "ceremony-docs-007",
      }),
    );
    const result = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(result).toMatchObject({
      operation: "propose",
      lifecycle: "proposed",
      workItemId: "ceremony-docs-007",
      taskVersion: 1,
      submissionAttemptedByCli: false,
    });
    expect(result).not.toHaveProperty("approvedTaskHash");
    expect(services.approveAgentTask).not.toHaveBeenCalled();
    expect(services.cancelAgentTask).not.toHaveBeenCalled();
  });

  it("refuses approval without the exact confirmation flag and performs no write", async () => {
    const errors: string[] = [];
    const services = pilotServices();

    const exitCode = await runPilotCli([
      "approve",
      "--work-item",
      "ceremony-docs-001",
      "--version",
      "1",
      "--operator",
      "pilot-operator",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services,
      errorOutput: (line: string) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain("exact --confirm flag");
    expect(services.approveAgentTask).not.toHaveBeenCalled();

    const typoExitCode = await runPilotCli([
      "approve",
      "--work-item",
      "ceremony-docs-001",
      "--version",
      "1",
      "--operator",
      "pilot-operator",
      "--comfirm",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services,
      errorOutput: (line: string) => errors.push(line),
    });

    expect(typoExitCode).toBe(1);
    expect(services.approveAgentTask).not.toHaveBeenCalled();
  });

  it("passes an operator actor to approval and refuses every other actor type", async () => {
    const services = pilotServices({
      approveAgentTask: vi.fn(async (input) => approvedTask(input.workItemId)),
    });

    await expect(runPilotCli([
      "approve",
      "--work-item",
      "ceremony-docs-001",
      "--version",
      "1",
      "--operator",
      "pilot-operator",
      "--confirm",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services,
      output: vi.fn(),
    })).resolves.toBe(0);

    expect(services.approveAgentTask).toHaveBeenCalledWith({
      workItemId: "ceremony-docs-001",
      taskVersion: 1,
      actor: {
        type: "operator",
        id: "pilot-operator",
      },
    });

    const write = vi.fn();
    await expect(handleApprove({
      command: "approve",
      workItemId: "ceremony-docs-001",
      taskVersion: 1,
      actorType: "hermes",
      operatorId: "not-an-operator",
      confirm: true,
    }, {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services: {
        ...services,
        approveAgentTask: write,
      },
      output: vi.fn(),
    })).rejects.toThrow("actor type must be operator");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses cancellation without confirmation", async () => {
    const services = pilotServices();
    const errors: string[] = [];

    const exitCode = await runPilotCli([
      "cancel",
      "--work-item",
      "ceremony-docs-001",
      "--version",
      "1",
      "--operator",
      "pilot-operator",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services,
      errorOutput: (line: string) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain("exact --confirm flag");
    expect(services.cancelAgentTask).not.toHaveBeenCalled();
  });

  it("keeps status read-only and redacts DSNs, tokens, and secret-looking values", async () => {
    const output: string[] = [];
    const proposed = proposedTask("ceremony-status-001");
    const services = pilotServices({
      listAgentTasks: vi.fn(async () => [proposed]),
      listHermesDecisions: vi.fn(async () => [{
        decisionId: "decision-one",
        correlationId: proposed.correlationId,
        workItemId: proposed.workItemId,
        decisionType: "dispatch_refusal",
        approval: { decision: "denied" },
        effects: { mutates: false, authorityChanged: false },
        next: {
          action:
            "inspect postgresql://pilot:dsn-password@localhost/db with token=decision-secret",
        },
        generatedAt: "2026-07-25T12:00:00.000Z",
      }]),
      readTextFile: vi.fn(async (target: string) => {
        if (target.endsWith("heartbeat.json")) {
          return JSON.stringify({
            status: "idle",
            lastOutcome: "refused",
            updatedAt: "2026-07-25T12:00:00.000Z",
            reconciledCount: 1,
            secret: "heartbeat-secret",
          });
        }
        return `${JSON.stringify({
          severity: "critical",
          code: "pilot_alert",
          message: "Bearer alert-token and password=alert-secret",
          at: "2026-07-25T12:00:00.000Z",
        })}\n`;
      }),
    });

    const exitCode = await runPilotCli([
      "status",
      "--work-item",
      proposed.workItemId,
    ], {
      environment: {
        DATABASE_URL:
          "postgresql://operator:environment-secret@localhost/reference",
        HARNESS_DISPATCH_HEARTBEAT_PATH: "/tmp/heartbeat.json",
        HARNESS_DISPATCH_ALERTS_PATH: "/tmp/alerts.jsonl",
      },
      services,
      output: (line: string) => output.push(line),
    });

    const rendered = output.join("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(rendered)).toMatchObject({
      operation: "status",
      readOnly: true,
      dispatcherHeartbeat: {
        status: "idle",
        lastOutcome: "refused",
      },
      submissionAttemptedByCli: false,
    });
    expect(rendered).not.toContain("postgresql://");
    expect(rendered).not.toContain("environment-secret");
    expect(rendered).not.toContain("decision-secret");
    expect(rendered).not.toContain("alert-token");
    expect(rendered).not.toContain("alert-secret");
    expect(rendered).not.toContain("heartbeat-secret");
    expect(services.proposeAgentTask).not.toHaveBeenCalled();
    expect(services.approveAgentTask).not.toHaveBeenCalled();
    expect(services.cancelAgentTask).not.toHaveBeenCalled();
  });

  it("reports missing database and artifact configuration without loading services", async () => {
    const errors: string[] = [];
    const services = pilotServices();
    const first = await runPilotCli([
      "propose",
      "--fixture",
      "docs-fix",
    ], {
      environment: {
        HARNESS_DISPATCH_ARTIFACT_DIR: "/tmp/pilot-artifacts",
      },
      services,
      errorOutput: (line: string) => errors.push(line),
    });
    const second = await runPilotCli([
      "propose",
      "--fixture",
      "docs-fix",
    ], {
      environment: {
        DATABASE_URL: "postgresql://pilot.invalid/reference",
      },
      services,
      errorOutput: (line: string) => errors.push(line),
    });

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(errors.join("")).toContain("DATABASE_URL is required");
    expect(errors.join("")).toContain(
      "HARNESS_DISPATCH_ARTIFACT_DIR is required",
    );
    expect(services.loadFixture).not.toHaveBeenCalled();
    expect(services.proposeAgentTask).not.toHaveBeenCalled();
  });

  it("parses a timezone-bearing deadline canonically", () => {
    expect(parsePilotArgs([
      "propose",
      "--fixture",
      "small-refactor",
      "--deadline",
      "2026-07-25T15:00:00+02:00",
    ])).toMatchObject({
      command: "propose",
      fixture: "small-refactor",
      deadline: "2026-07-25T13:00:00.000Z",
    });
  });

  it("accepts the separate deterministic green-path fixture", () => {
    expect(parsePilotArgs([
      "propose",
      "--fixture",
      "lint-format-green",
    ])).toEqual({
      command: "propose",
      fixture: "lint-format-green",
    });
  });

  it("accepts the dedicated terminal budget-overrun fixture", () => {
    expect(parsePilotArgs([
      "propose",
      "--fixture",
      "lint-format-budget-overrun",
    ])).toEqual({
      command: "propose",
      fixture: "lint-format-budget-overrun",
    });
  });
});

function pilotServices(overrides: Record<string, unknown> = {}) {
  return {
    loadFixture: vi.fn(async () => fixture()),
    proposeAgentTask: vi.fn(async (input) => proposedTask(input.workItemId)),
    approveAgentTask: vi.fn(async (input) => approvedTask(input.workItemId)),
    cancelAgentTask: vi.fn(async (input) => ({
      task: {
        ...proposedTask(input.workItemId),
        lifecycle: "cancelled",
      },
      harnessAcknowledged: true,
    })),
    listAgentTasks: vi.fn(async () => []),
    listHermesDecisions: vi.fn(async () => []),
    workspacePathForTask: vi.fn(
      (workItemId: string, taskVersion: number) =>
        `/var/lib/harness-dispatcher/workspaces/${workItemId}-v${taskVersion}`,
    ),
    deriveIntendedRunId: vi.fn(() => RUN_ID),
    readTextFile: vi.fn(async () => {
      throw new Error("file missing");
    }),
    ...overrides,
  };
}

function fixture() {
  return {
    workItemId: "ceremony-docs-001",
    correlationId: "ceremony-docs-001",
    taskKind: "docs_fix",
    title: "Fix one document",
    objective: "Fix one bounded document.",
    whyNow: "The pilot needs a documentation task.",
    requestedBy: { type: "operator", id: "pilot-operator" },
    repository: {
      nameWithOwner: "example/reference",
      baseRevision: "a".repeat(40),
      allowedPaths: ["docs/**"],
      forbiddenPaths: [".github/**"],
    },
    profile: "coding-change-pilot",
    acceptanceCriteria: [],
    budget: {
      elapsedSeconds: 60,
      modelTokens: 1_000,
      toolCalls: 10,
      estimatedUsdMicros: null,
    },
    deadline: "2027-12-31T23:59:59.000Z",
    riskTier: "low",
    selectionReason: "Bounded and reversible.",
  };
}

function proposedTask(workItemId: string) {
  return {
    workItemId,
    taskVersion: 1,
    correlationId: workItemId,
    lifecycle: "proposed",
    intent: {
      templateHash: HASH,
    },
    acceptance: {
      verifierPlanHash: VERIFIER_HASH,
    },
    approval: {
      status: "pending",
    },
  };
}

function approvedTask(workItemId: string) {
  return {
    ...proposedTask(workItemId),
    lifecycle: "approved",
    approval: {
      status: "approved",
      approvedTaskHash: HASH,
    },
  };
}
