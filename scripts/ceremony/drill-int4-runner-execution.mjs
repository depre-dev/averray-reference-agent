#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mutation = argument("--mutation");
if (mutation && mutation !== "remove-guard") {
  throw new Error(
    `INT4_RUNNER_EXECUTION_UNKNOWN_MUTATION name=${mutation} valid=remove-guard`,
  );
}

const cases = [
  {
    suite: "INT4B",
    runner: "run-int4b-drills.mjs",
    testFile: "int4b-quarantine.test.ts",
    coupling: "INT4B_REFERENCE_DATABASE_URL",
    expected: 5,
  },
  {
    suite: "INT4C",
    runner: "run-int4c-drills.mjs",
    testFile: "int4c-lease-takeover.test.ts",
    coupling: "INT4C_REFERENCE_DATABASE_URL",
    expected: 6,
  },
  {
    suite: "INT4C_D0",
    runner: "run-int4c-d0.mjs",
    testFile: "int4c-d0-baseline.test.ts",
    coupling: "INT4C_REFERENCE_DATABASE_URL",
    expected: 3,
  },
  {
    suite: "INT4D",
    runner: "run-int4d-drills.mjs",
    testFile: "int4d-drill-matrix.test.ts",
    coupling: "INT4D_REFERENCE_DATABASE_URL",
    expected: 6,
  },
];

let failed = false;
for (const drill of cases) {
  const broken = runRunner(drill, { breakCoupling: true, removeGuard: mutation });
  if (mutation) {
    console.info(
      `INT4_RUNNER_EXECUTION_MUTATION_APPLIED suite=${drill.suite} name=${mutation}`,
    );
    if (broken.status === 0) {
      failed = true;
      console.error(
        `INT4_RUNNER_EXECUTION_DRILL_FAILED suite=${drill.suite} `
          + "expected=nonzero actual=0 reason=all_skipped_was_accepted",
      );
    } else {
      console.info(
        `INT4_RUNNER_EXECUTION_MUTATION_SURVIVED suite=${drill.suite} `
          + `exit=${broken.status}`,
      );
    }
    continue;
  }

  const expectedReason = `${drill.suite}_DRILLS_SKIPPED passed=0 `
    + `skipped=${drill.expected} total=${drill.expected}`;
  if (broken.status === 0 || !combinedOutput(broken).includes(expectedReason)) {
    failed = true;
    console.error(
      `INT4_RUNNER_EXECUTION_COUPLING_CHECK_FAILED suite=${drill.suite} `
        + `exit=${broken.status ?? "null"} expected_reason=${expectedReason} `
        + `detail=${oneLine(combinedOutput(broken))}`,
    );
  } else {
    console.info(
      `INT4_RUNNER_EXECUTION_COUPLING_RED suite=${drill.suite} `
        + `exit=${broken.status} reason=${expectedReason}`,
    );
  }

  const intact = runRunner(drill, { breakCoupling: false, removeGuard: false });
  const expectedGreen = `${drill.suite}_DRILLS_EXECUTED passed=${drill.expected} `
    + `skipped=0 failed=0 total=${drill.expected}`;
  if (intact.status !== 0 || !combinedOutput(intact).includes(expectedGreen)) {
    failed = true;
    console.error(
      `INT4_RUNNER_EXECUTION_INTACT_CHECK_FAILED suite=${drill.suite} `
        + `exit=${intact.status ?? "null"} expected=${expectedGreen} `
        + `detail=${oneLine(combinedOutput(intact))}`,
    );
  } else {
    console.info(
      `INT4_RUNNER_EXECUTION_GREEN suite=${drill.suite} exit=0 `
        + `executed=${drill.expected}`,
    );
  }
}

if (failed) process.exitCode = 1;

function runRunner(drill, options) {
  const scratch = mkdtempSync(path.join(tmpdir(), "int4-runner-drill-"));
  try {
    const ceremony = path.join(scratch, "scripts/ceremony");
    const library = path.join(ceremony, "lib");
    const fakeBin = path.join(scratch, "fake-bin");
    const evidence = path.join(scratch, "evidence");
    const harnessCheckout = path.join(scratch, "agent-harness");
    const probeTest = path.join(scratch, "test/integration/runner-probe.test.mjs");
    mkdirSync(library, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    mkdirSync(harnessCheckout, { recursive: true });
    mkdirSync(path.dirname(probeTest), { recursive: true });
    symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
    writeFileSync(probeTest, `
import { describe, expect, it } from "vitest";
const RUN = process.env.${drill.coupling} ? describe : describe.skip;
RUN("${drill.suite} coupling probe", () => {
  for (let index = 1; index <= ${drill.expected}; index += 1) {
    it("executes drill " + index, () => expect(index).toBeGreaterThan(0));
  }
});
`, "utf8");

    copyFileSync(
      path.join(root, "scripts/ceremony/lib/int4-mutation-contract.mjs"),
      path.join(library, "int4-mutation-contract.mjs"),
    );
    copyFileSync(
      path.join(root, "scripts/ceremony/lib/int4-vitest-execution.mjs"),
      path.join(library, "int4-vitest-execution.mjs"),
    );

    const runnerSource = path.join(root, "scripts/ceremony", drill.runner);
    let source = readFileSync(runnerSource, "utf8");
    if (options.breakCoupling) {
      source = replaceExactlyOnce(
        source,
        `${drill.coupling}:`,
        `${drill.coupling}_BROKEN:`,
        `${drill.suite} coupling`,
      );
    }
    if (options.removeGuard) {
      source = replaceExactlyOnce(
        source,
        "  vitestExecution.assert(result.status);\n",
        "",
        `${drill.suite} guard`,
      );
    }
    const runnerPath = path.join(ceremony, drill.runner);
    writeFileSync(runnerPath, source, "utf8");

    writeFakeCommands(fakeBin);
    return spawnSync(process.execPath, [runnerPath], {
      cwd: scratch,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        HARNESS_CHECKOUT: harnessCheckout,
        INT4_DRILL_EVIDENCE_DIR: evidence,
        INT4_RUNNER_DRILL_TEST_FILE: drill.testFile,
        INT4_RUNNER_DRILL_PROBE_TEST: path.relative(scratch, probeTest),
        INT4_RUNNER_DRILL_VITEST:
          path.join(root, "node_modules/vitest/vitest.mjs"),
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeFakeCommands(directory) {
  writeExecutable(directory, "docker", `
const args = process.argv.slice(2);
if (args[0] === "exec") process.stdout.write("1\\n");
if (args[0] === "port") process.stdout.write("127.0.0.1:54321\\n");
`);
  writeExecutable(directory, "git", `
const args = process.argv.slice(2);
if (args.includes("rev-parse")) {
  process.stdout.write(args.includes("-C")
    ? "3355f4906864b0f0e0fe5fd5eb5220172e174206\\n"
    : "bd6133220d0e9991a5700e7313ec7dd5da3b7434\\n");
} else if (args.includes("merge-base")) {
  process.stdout.write("bd6133220d0e9991a5700e7313ec7dd5da3b7434\\n");
}
`);
  writeExecutable(directory, "uv", "");
  writeExecutable(directory, "npx", `
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const expectedFile = process.env.INT4_RUNNER_DRILL_TEST_FILE;
const testIndex = args.findIndex((value) => value.endsWith(expectedFile));
if (testIndex === -1) process.exit(90);
const result = spawnSync(
  process.execPath,
  [
    process.env.INT4_RUNNER_DRILL_VITEST,
    "run",
    process.env.INT4_RUNNER_DRILL_PROBE_TEST,
    ...args.slice(testIndex + 1),
  ],
  { cwd: process.cwd(), env: process.env, encoding: "utf8" },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 92);
`);
}

function writeExecutable(directory, name, body) {
  const target = path.join(directory, name);
  writeFileSync(target, `#!/usr/bin/env node\n${body.trimStart()}`, "utf8");
  chmodSync(target, 0o755);
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`INT4_RUNNER_EXECUTION_PROBE_INVALID label=${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function oneLine(value) {
  return value.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
