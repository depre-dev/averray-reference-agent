import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDispatchAlertSink,
} from "../../services/harness-dispatcher/src/alerts.js";
import { describe, expect, it, vi } from "vitest";

describe("Harness dispatcher alert sink", () => {
  it("sanitizes, logs, and appends exactly one JSONL alert", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-alerts-"));
    const target = path.join(root, "nested", "alerts.jsonl");
    const logger = { warn: vi.fn() };
    try {
      const sink = createDispatchAlertSink({
        environment: {
          HARNESS_DISPATCH_ALERTS_PATH: target,
        },
        logger,
      });

      await sink({
        severity: "critical",
        code: "deadline_exceeded",
        workItemId: "work-001",
        taskVersion: 1,
        harnessRunId: "11111111-1111-4111-8111-111111111111",
        message: "Forced cancel because token=supersecret",
        at: "2026-07-25T14:00:00.000Z",
      });

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          alert: true,
          severity: "critical",
          code: "deadline_exceeded",
        }),
        "Forced cancel because token: [redacted]",
      );
      const lines = (await readFile(target, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("supersecret");
      expect(JSON.parse(lines[0]!)).toMatchObject({
        severity: "critical",
        code: "deadline_exceeded",
        message: "Forced cancel because token: [redacted]",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
