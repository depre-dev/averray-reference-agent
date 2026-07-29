import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  INT2_EXPECTED_PATH,
  expectationsForCase,
  verifyScriptedPairPreflight,
} from "../../scripts/ceremony/int2-evidence.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT_ROOT = path.join(ROOT, "scripts/ceremony");
const OPERATOR_SCRIPTS = [
  "int2-bringup.sh",
  "int2-green-setup.sh",
  "int2-negative-setup.sh",
  "int2-green-verify.sh",
  "int2-negative-verify.sh",
  "int2-teardown.sh",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((value) =>
      rm(value, { recursive: true, force: true })),
  );
});

describe("committed INT-2 ceremony mechanics", () => {
  it("keeps all six operator scripts parseable and on the shared evidence definition", async () => {
    const contents = await Promise.all(
      OPERATOR_SCRIPTS.map(async (name) => {
        const target = path.join(SCRIPT_ROOT, name);
        execFileSync("bash", ["-n", target]);
        return [name, await readFile(target, "utf8")] as const;
      }),
    );
    const byName = Object.fromEntries(contents);

    expect(byName["int2-bringup.sh"]).toContain("ATTACH mode");
    expect(byName["int2-bringup.sh"]).toContain(
      "refusing destructive re-creation",
    );
    expect(byName["int2-bringup.sh"]).not.toContain(
      "docker rm -f int2-harness-postgres",
    );
    expect(byName["int2-bringup.sh"]).toContain('"$HARNESS_BIN" --help');
    expect(byName["int2-green-setup.sh"]).not.toContain("${!");
    expect(byName["int2-negative-setup.sh"]).not.toContain("${!");
    expect(byName["int2-green-setup.sh"]).toContain('pgrep -f "harness worker"');
    expect(byName["int2-green-setup.sh"]).toContain("preflight-pair");
    expect(byName["int2-negative-setup.sh"]).toContain("preflight-pair");
    expect(byName["int2-green-verify.sh"]).toContain("int2-evidence.mjs");
    expect(byName["int2-negative-verify.sh"]).toContain("int2-evidence.mjs");
  });

  it("proves the controlled pair passes and a non-discriminating mutation fails", async () => {
    const result = await verifyScriptedPairPreflight({
      repositoryRoot: ROOT,
    });
    expect(result.targetPath).toBe(INT2_EXPECTED_PATH);
    expect(result.green.exitCode).toBe(0);
    expect(result.negative.exitCode).not.toBe(0);
    expect(result.negative.exitCode).not.toBe(128);

    const temporary = await mkdtemp(path.join(tmpdir(), "int2-pair-mutation-"));
    temporaryRoots.push(temporary);
    const green = path.join(
      ROOT,
      "test/fixtures/agent-integration/ceremony/lint-format-green.jsonl",
    );
    const mutatedNegative = path.join(temporary, "mutated-red.jsonl");
    await writeFile(mutatedNegative, await readFile(green));

    await expect(
      verifyScriptedPairPreflight({
        repositoryRoot: ROOT,
        negativeScriptPath: mutatedNegative,
      }),
    ).rejects.toThrow("controlled pair appended content must differ");
  });

  it("records the production-loader and typed-attenuation split", () => {
    expect(expectationsForCase("profile-unvetted")).toMatchObject({
      profileLoadErrorReason: "unvetted_capability",
      runCount: 0,
      outboxCount: 0,
    });
    expect(expectationsForCase("narrow")).toMatchObject({
      runCount: 1,
      effectiveCapabilities: expect.not.arrayContaining(["fs.write_file"]),
    });
  });
});
