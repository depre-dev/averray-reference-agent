import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  assertMutationApplied,
} from "../../scripts/ceremony/lib/int4-mutation-contract.mjs";

const CASES = [
  {
    suite: "INT4B",
    runner: "scripts/ceremony/run-int4b-drills.mjs",
    valid:
      "timestamp-fingerprint,skip-marker-write,count-transient,drop-orphan-class",
  },
  {
    suite: "INT4C",
    runner: "scripts/ceremony/run-int4c-drills.mjs",
    valid: "disable-renewal,remove-retry-bound,alert-dedup",
  },
  {
    suite: "INT4D",
    runner: "scripts/ceremony/run-int4d-drills.mjs",
    valid:
      "non-idempotent-projection,duplicate-worker-effect,board-replay-write,skip-policy-recheck,disable-size-gate",
  },
] as const;

describe("INT-4 drill mutation contracts", () => {
  it("refuses a recognized mutation that never reports reaching its seam", () => {
    expect(() => assertMutationApplied(
      "INT4C",
      "remove-retry-bound",
      "six green drills with no mutation marker",
    )).toThrow(
      "INT4C_MUTATION_NOT_APPLIED name=remove-retry-bound expected=INT4C_MUTATION_APPLIED=remove-retry-bound",
    );
  });

  it.each(CASES)(
    "$suite refuses an unknown mutation before starting its drill",
    ({ suite, runner, valid }) => {
      const result = spawnSync(process.execPath, [
        runner,
        "--mutation",
        "not-a-real-name",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `${suite}_UNKNOWN_MUTATION name=not-a-real-name valid=${valid}`,
      );
    },
  );
});
