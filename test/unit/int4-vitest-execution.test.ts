import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertVitestExecution,
} from "../../scripts/ceremony/lib/int4-vitest-execution.mjs";

describe("INT-4 Vitest execution accounting", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a successful, fully executed suite", () => {
    const fixture = report({ passed: 6, failed: 0, skipped: 0, total: 6 });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(assertVitestExecution({
      suite: "INT4C",
      childStatus: 0,
      ...fixture,
    })).toEqual({ passed: 6, failed: 0, skipped: 0, executed: 6, total: 6 });
    expect(readFileSync(path.join(fixture.evidenceDir, "executed-count.txt"), "utf8"))
      .toBe("6\n");
    expect(info).toHaveBeenCalledWith(
      "INT4C_DRILLS_EXECUTED passed=6 skipped=0 failed=0 total=6",
    );
  });

  it("refuses a successful Vitest process that skipped any test", () => {
    const fixture = report({ passed: 0, failed: 0, skipped: 6, total: 6 });

    expect(() => assertVitestExecution({
      suite: "INT4C",
      childStatus: 0,
      ...fixture,
    })).toThrow("INT4C_DRILLS_SKIPPED passed=0 skipped=6 total=6");
  });

  it("refuses a successful Vitest process that passed no test", () => {
    const fixture = report({ passed: 0, failed: 0, skipped: 0, total: 0 });

    expect(() => assertVitestExecution({
      suite: "INT4D",
      childStatus: 0,
      ...fixture,
    })).toThrow("INT4D_DRILLS_NOT_EXECUTED passed=0 skipped=0 total=0");
  });

  it("preserves a genuine Vitest failure and still records its accounting", () => {
    const fixture = report({ passed: 4, failed: 1, skipped: 0, total: 5 });

    expect(assertVitestExecution({
      suite: "INT4B",
      childStatus: 1,
      ...fixture,
    })).toEqual({ passed: 4, failed: 1, skipped: 0, executed: 5, total: 5 });
    expect(readFileSync(path.join(fixture.evidenceDir, "executed-count.txt"), "utf8"))
      .toBe("5\n");
  });

  it("does not replace a genuine child failure with a malformed-report error", () => {
    const evidenceDir = directory();
    const reportPath = path.join(evidenceDir, "vitest-report.json");
    writeFileSync(reportPath, "not-json", "utf8");

    expect(assertVitestExecution({
      suite: "INT4B",
      childStatus: 1,
      reportPath,
      evidenceDir,
    })).toBeUndefined();
  });

  function report(counts: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  }) {
    const evidenceDir = directory();
    const reportPath = path.join(evidenceDir, "vitest-report.json");
    writeFileSync(reportPath, JSON.stringify({
      numPassedTests: counts.passed,
      numFailedTests: counts.failed,
      numPendingTests: counts.skipped,
      numTotalTests: counts.total,
    }), "utf8");
    return { evidenceDir, reportPath };
  }

  function directory() {
    const value = mkdtempSync(path.join(tmpdir(), "int4-vitest-test-"));
    directories.push(value);
    return value;
  }
});
