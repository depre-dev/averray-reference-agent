import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertControlArgs,
  createHarnessControlPort,
  harnessDispatchEnabled,
  HarnessControlError,
  type HarnessCommandExecutor,
} from "../../services/harness-dispatcher/src/harness-control-port.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_PATH = path.resolve(
  "test/fixtures/agent-integration/task-intent-v1alpha1.json",
);

describe("INT-2d Harness control port", () => {
  it("keeps submit disabled while allowing authority-reducing cancel", async () => {
    const prior = process.env.HARNESS_DISPATCH_ENABLED;
    delete process.env.HARNESS_DISPATCH_ENABLED;
    try {
      const execute = vi.fn<HarnessCommandExecutor>(async () => ({
        code: 0,
        stdout: RUN_ID,
        stderr: "",
      }));
      const port = createHarnessControlPort({ execute });

      await expect(port.submit(RUN_ID, INTENT_PATH)).rejects.toMatchObject({
        code: "dispatch_disabled",
        retryable: false,
      });
      expect(execute).not.toHaveBeenCalled();

      await expect(port.cancel(RUN_ID)).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        "harness",
        ["run", "cancel", RUN_ID],
        { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
      );
    } finally {
      if (prior === undefined) delete process.env.HARNESS_DISPATCH_ENABLED;
      else process.env.HARNESS_DISPATCH_ENABLED = prior;
    }
  });

  it("enables only the explicit 1 and true flag values", () => {
    for (const value of [undefined, "", "0", "false", "no"]) {
      expect(harnessDispatchEnabled({ HARNESS_DISPATCH_ENABLED: value })).toBe(false);
    }
    for (const value of ["1", "true", " TRUE ", " 1 "]) {
      expect(harnessDispatchEnabled({ HARNESS_DISPATCH_ENABLED: value })).toBe(true);
    }
  });

  it("submits and cancels with exact fixed argv and bounded defaults", async () => {
    const execute = vi.fn<HarnessCommandExecutor>(async (_command, args) => ({
      code: 0,
      stdout: args[1] === "submit" ? `${RUN_ID}\n` : "",
      stderr: "",
    }));
    const port = createHarnessControlPort({ enabled: true, execute });

    await expect(port.submit(RUN_ID, INTENT_PATH)).resolves.toBe(RUN_ID);
    await expect(port.cancel(RUN_ID)).resolves.toBeUndefined();

    expect(execute).toHaveBeenNthCalledWith(
      1,
      "harness",
      ["run", "submit", "--run-id", RUN_ID, INTENT_PATH],
      { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "harness",
      ["run", "cancel", RUN_ID],
      { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
    );
  });

  it("rejects non-allowlisted control argv", () => {
    const refused = [
      ["run", "approve", RUN_ID],
      ["run", "deny", RUN_ID],
      ["run", "release", RUN_ID, "--to", "failed"],
      ["run", "status", RUN_ID],
      ["skill", "promote", "x"],
    ];
    for (const args of refused) {
      expect(() => assertControlArgs(args)).toThrow(
        expect.objectContaining({
          code: "refused_command",
          retryable: false,
        }),
      );
    }
  });

  it("rejects a binary whose basename is not harness", () => {
    expect(() => createHarnessControlPort({ command: "/usr/bin/bash" })).toThrow(
      expect.objectContaining({
        code: "cli_failed",
        retryable: false,
      }),
    );
  });

  it("rejects non-canonical run ids without executing", async () => {
    const execute = vi.fn<HarnessCommandExecutor>();
    const port = createHarnessControlPort({ enabled: true, execute });

    await expect(port.cancel("NOT-A-UUID")).rejects.toMatchObject({
      code: "invalid_run_id",
      retryable: false,
    });
    await expect(
      port.submit("11111111-1111-4111-8111-11111111111A", INTENT_PATH),
    ).rejects.toMatchObject({
      code: "invalid_run_id",
      retryable: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects relative and missing intent paths without executing", async () => {
    const execute = vi.fn<HarnessCommandExecutor>();
    const port = createHarnessControlPort({ enabled: true, execute });

    await expect(port.submit(RUN_ID, "task.yaml")).rejects.toMatchObject({
      code: "invalid_intent_path",
      retryable: false,
    });
    await expect(
      port.submit(RUN_ID, path.resolve("test/fixtures/missing-task.yaml")),
    ).rejects.toMatchObject({
      code: "invalid_intent_path",
      retryable: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["multiple", `${RUN_ID}\n${RUN_ID}\n`],
  ])("rejects %s submit stdout", async (_name, stdout) => {
    const port = createHarnessControlPort({
      enabled: true,
      execute: async () => ({ code: 0, stdout, stderr: "" }),
    });
    await expect(port.submit(RUN_ID, INTENT_PATH)).rejects.toMatchObject({
      code: "submit_malformed",
      retryable: false,
    });
  });

  it("rejects a submit identity mismatch", async () => {
    const port = createHarnessControlPort({
      enabled: true,
      execute: async () => ({ code: 0, stdout: OTHER_RUN_ID, stderr: "" }),
    });
    await expect(port.submit(RUN_ID, INTENT_PATH)).rejects.toMatchObject({
      code: "submit_identity_mismatch",
      retryable: false,
    });
  });

  it("maps non-zero exits without surfacing raw stderr credentials", async () => {
    const port = createHarnessControlPort({
      enabled: true,
      execute: async () => ({
        code: 2,
        stdout: "",
        stderr: "connection failed for postgresql://user:supersecret@host/db",
      }),
    });

    const failure = await port.cancel(RUN_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessControlError);
    expect(failure).toMatchObject({ code: "cli_failed", retryable: true });
    expect((failure as Error).message).toContain("Harness data source is unavailable");
    expect((failure as Error).message).not.toContain("supersecret");
  });

  it("preserves retryable timeout failures", async () => {
    const port = createHarnessControlPort({
      enabled: true,
      execute: async () => {
        throw new HarnessControlError(
          "cli_timeout",
          "Harness control command timed out",
          true,
        );
      },
    });
    await expect(port.cancel(RUN_ID)).rejects.toMatchObject({
      code: "cli_timeout",
      retryable: true,
    });
  });

  it("rejects oversized combined command output", async () => {
    const port = createHarnessControlPort({
      enabled: true,
      maxOutputBytes: 8,
      execute: async () => ({
        code: 0,
        stdout: RUN_ID,
        stderr: "",
      }),
    });
    await expect(port.submit(RUN_ID, INTENT_PATH)).rejects.toMatchObject({
      code: "cli_output_too_large",
      retryable: false,
    });
  });
});
