import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("INT-4d matrix runner", () => {
  it("validates all 22 records with the corrected 13/7/2 census resolution", () => {
    const result = run(["--validate-only"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "INT4D_MATRIX_VALID executed=5 cited_ci=13 deferred=4 total=22",
    );
  });

  it.each([
    ["citation-drift", "INT4D_CITATION_DRIFT"],
    ["delete-deferral-reason", "INT4D_DEFERRED_FIELD_MISSING"],
    ["drop-owner", "INT4D_MATRIX_FIELD_MISSING"],
    ["fake-proven", "INT4D_EVIDENCE_MISSING"],
  ])("rejects %s after proving the requested mutation applied", (mutation, reason) => {
    const result = run(["--validate-only", "--mutation", mutation]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`INT4D_MATRIX_MUTATION_APPLIED=${mutation}`);
    expect(result.stderr).toContain(reason);
  });

  it("refuses an unknown mutation name instead of silently no-oping", () => {
    const result = run(["--validate-only", "--mutation", "unknown-name"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INT4D_UNKNOWN_MUTATION name=unknown-name");
  });
});

function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/ceremony/run-int4d-matrix.mjs", ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}
