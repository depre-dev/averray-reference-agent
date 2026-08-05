import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregateBurninLedger,
  BurninLedgerError,
  readBurninLedger,
  renderBurninSummary,
} from "../../scripts/ceremony/burnin-ledger.mjs";
import { runBurninBatch } from "../../scripts/ceremony/run-burnin-batch.mjs";
import { runBurninStatus } from "../../scripts/ceremony/burnin-status.mjs";

describe("Harness §9.1 burn-in battery", () => {
  it("counts four green families and excludes the red sentinel", () => {
    const aggregation = aggregateBurninLedger(validLedger());

    expect(aggregation.items).toBe(4);
    expect(aggregation.families).toBe(4);
    expect(aggregation.sentinelCount).toBe(1);
    expect(aggregation.correctSentinelCount).toBe(1);
    expect(aggregation.correlationPassed).toBe(4);
    expect(aggregation.violations).toEqual([]);
    expect(renderBurninSummary(aggregation)).toContain(
      "thresholds: not yet approved",
    );
  });

  it("reports a PR opening as an incident and resets the span", () => {
    const baseline = aggregateBurninLedger(validLedger());
    const mutated = structuredClone(validLedger());
    mutated[3].prOpened = true;

    const aggregation = aggregateBurninLedger(mutated);

    expect(aggregation.incidentFree).toBe(false);
    expect(aggregation.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "pr_opened", seqs: [4] }),
    ]));
    expect(aggregation.spanResetAt).toBe("2026-08-04T00:00:00.000Z");
    expect(aggregation.spanDays).toBeLessThan(baseline.spanDays);
  });

  it("reports duplicate dispatch when two lines share one bound run", () => {
    const mutated = structuredClone(validLedger());
    mutated[1].boundRunId = mutated[0].boundRunId;

    const aggregation = aggregateBurninLedger(mutated);

    expect(aggregation.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate_dispatch",
        seqs: [1, 2],
      }),
    ]));
    expect(aggregation.items).toBe(2);
  });

  it("counts a missing verification verdict as a violation, never progress", () => {
    const mutated = structuredClone(validLedger());
    delete mutated[0].verificationVerdict;

    const aggregation = aggregateBurninLedger(mutated);

    expect(aggregation.items).toBe(3);
    expect(aggregation.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_evidence",
        seqs: [1],
        detail: "field=verificationVerdict",
      }),
    ]));
  });

  it("refuses the summary when a line is deleted from the middle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burnin-gap-"));
    const mutated = validLedger().filter((line) => line.seq !== 2);
    await writeFile(
      path.join(directory, "LEDGER.jsonl"),
      `${mutated.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    await expect(readBurninLedger(directory)).rejects.toEqual(
      expect.objectContaining({
        name: "BurninLedgerError",
        message: expect.stringContaining("seq_gap expected=2 actual=3"),
      }),
    );
    await expect(readBurninLedger(directory)).rejects.toBeInstanceOf(
      BurninLedgerError,
    );
  });

  it("requires an explicit evidence directory before starting machinery", async () => {
    let stderr = "";
    let invoked = false;
    const code = await runBurninBatch([], {
      errorOutput: (text: string) => {
        stderr += text;
      },
      executeSuite: async () => {
        invoked = true;
      },
    });

    expect(code).toBe(2);
    expect(invoked).toBe(false);
    expect(stderr).toBe(
      "run-burnin-batch: --evidence <dir> is required; no default evidence path exists\n",
    );
  });

  it("builds one append-only batch from the selected cases' evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burnin-batch-"));
    let stdout = "";
    const code = await runBurninBatch(["--evidence", directory], {
      now: () => new Date("2026-08-05T12:00:00.000Z"),
      output: (text: string) => {
        stdout += text;
      },
      verifyEvidence: () => undefined,
      executeSuite: async ({
        evidenceDirectory,
        batchPrefix,
      }: {
        evidenceDirectory: string;
        batchPrefix: string;
      }) => {
        const cases = [
          ["green", "lint-format", false],
          ["docs-fix", "docs-fix", false],
          ["add-unit-test", "add-unit-test", false],
          ["small-refactor", "small-refactor", false],
          ["negative", "lint-format-red", true],
        ] as const;
        for (const [caseName, family, sentinel] of cases) {
          const target = path.join(evidenceDirectory, caseName);
          await mkdir(target, { recursive: true });
          await writeFile(
            path.join(target, "evidence.json"),
            JSON.stringify(evidenceForLine({
              workItemId: `${batchPrefix}-${family}`,
              sentinel,
            })),
            "utf8",
          );
        }
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("items: 4/20");
    expect(stdout).toContain(
      "red sentinels: 1 recorded, 1 correctly refused, 0 counted",
    );
    const ledger = await readBurninLedger(directory);
    expect(ledger).toHaveLength(5);
    expect(ledger.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ledger.map((line) => line.workItemId)).toEqual([
      "burnin-20260805-000001-lint-format",
      "burnin-20260805-000001-docs-fix",
      "burnin-20260805-000001-add-unit-test",
      "burnin-20260805-000001-small-refactor",
      "burnin-20260805-000001-lint-format-red",
    ]);
  });

  it("writes an honest status for an empty, explicitly selected ledger", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burnin-empty-"));
    let stdout = "";
    const code = await runBurninStatus(["--evidence", directory], {
      generatedAt: "2026-08-05T00:00:00.000Z",
      output: (text: string) => {
        stdout += text;
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("items: 0/20");
    expect(stdout).toContain("thresholds: not yet approved");
    expect(await readFile(path.join(directory, "SUMMARY.md"), "utf8"))
      .toBe(stdout);
  });
});

function validLedger(): Array<Record<string, any>> {
  const families = [
    "lint-format",
    "docs-fix",
    "add-unit-test",
    "small-refactor",
    "lint-format-red",
  ];
  return families.map((family, index) => {
    const sentinel = family === "lint-format-red";
    const seq = index + 1;
    const runId = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
    return {
      seq,
      ts: `2026-08-0${seq}T00:00:00.000Z`,
      workItemId: `burnin-20260805-000001-${family}`,
      family,
      taskVersion: 1,
      intendedRunId: runId,
      boundRunId: runId,
      lifecycle: sentinel ? "failed" : "handoff_ready",
      harnessOutcome: sentinel ? "failed" : "completed",
      verificationVerdict: sentinel ? "failed" : "completed",
      criteria: [{
        id: "criterion",
        passed: !sentinel,
        reason: sentinel ? "exit_2" : "exit_0",
        detail: sentinel ? "trailing whitespace" : "accepted",
      }],
      handoffDecisions: sentinel ? 0 : 1,
      prOpened: false,
      effectsMutates: false,
      elapsedSeconds: 10 + index,
      verificationSeconds: 2 + index,
      modelTokens: 7,
      alerts: [],
    };
  });
}

function evidenceForLine({
  workItemId,
  sentinel,
}: {
  workItemId: string;
  sentinel: boolean;
}): Record<string, any> {
  const runId = `00000000-0000-4000-8000-${workItemId.length
    .toString().padStart(12, "0")}`;
  return {
    workItemId,
    intendedRunId: runId,
    task: {
      workItemId,
      taskVersion: 1,
      lifecycle: sentinel ? "failed" : "handoff_ready",
    },
    outbox: [{ harness_run_id: runId }],
    runs: [{
      runId,
      outcome: sentinel ? "failed" : "completed",
      updatedAt: "2026-08-05T12:00:00.000Z",
    }],
    verification: {
      verdict: sentinel ? "failed" : "completed",
      details: [{
        id: "criterion",
        passed: !sentinel,
        reason: sentinel ? "exit_2" : "exit_0",
        detail: sentinel ? "refused" : "accepted",
      }],
    },
    decisions: sentinel
      ? []
      : [{ decisionType: "handoff", effects: { mutates: false } }],
    pullRequestReferences: [],
    metrics: {
      observedAt: "2026-08-05T12:00:00.000Z",
      elapsedSeconds: 10,
      verificationSeconds: 2,
      modelTokens: 7,
    },
    alerts: [],
  };
}
