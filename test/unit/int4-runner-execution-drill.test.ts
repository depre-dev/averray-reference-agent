import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/ceremony/drill-int4-runner-execution.mjs";
const SUITES = [
  ["INT4B", 5],
  ["INT4C", 6],
  ["INT4C_D0", 3],
  ["INT4D", 6],
] as const;

describe("INT-4 runner execution drill", () => {
  it("makes broken environment coupling red and intact coupling green", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    for (const [suite, expected] of SUITES) {
      expect(result.stdout).toContain(
        `INT4_RUNNER_EXECUTION_COUPLING_RED suite=${suite} exit=1`,
      );
      expect(result.stdout).toContain(
        `INT4_RUNNER_EXECUTION_GREEN suite=${suite} exit=0 executed=${expected}`,
      );
    }
  }, 30_000);

  it("fails for every runner when the execution guard is removed", () => {
    const result = run(["--mutation", "remove-guard"]);
    expect(result.status).not.toBe(0);
    for (const [suite] of SUITES) {
      expect(result.stdout).toContain(
        `INT4_RUNNER_EXECUTION_MUTATION_APPLIED suite=${suite} name=remove-guard`,
      );
      expect(result.stderr).toContain(
        `INT4_RUNNER_EXECUTION_DRILL_FAILED suite=${suite} `
          + "expected=nonzero actual=0 reason=all_skipped_was_accepted",
      );
    }
  }, 30_000);
});

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}
