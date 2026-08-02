import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  INT2_EXPECTED_PATH,
  INT2_SECTION3_CRITERION,
  expectationsForCase,
  verifySection3Preflight,
  verifyScriptedPairPreflight,
} from "../../scripts/ceremony/int2-evidence.mjs";
import {
  createInt2WorkerEnvironment,
} from "../../scripts/ceremony/int2-worker-environment.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT_ROOT = path.join(ROOT, "scripts/ceremony");
const CHECKOUT_HELPER = path.join(
  SCRIPT_ROOT,
  "lib/int2-harness-checkout.sh",
);
const AUTOMATED_SUITE = path.join(
  SCRIPT_ROOT,
  "run-int2-automated-suite.sh",
);
const REAP_HELPER = path.join(SCRIPT_ROOT, "lib/int2-reap.sh");
const PILOT_DOCKERFILE = path.join(ROOT, "ops/Dockerfile.pilot");
const OPERATOR_SCRIPTS = [
  "int2-bringup.sh",
  "int2-green-setup.sh",
  "int2-negative-setup.sh",
  "int2-green-verify.sh",
  "int2-negative-verify.sh",
  "int2-teardown.sh",
] as const;
const temporaryRoots: string[] = [];
const strayProcesses: ChildProcess[] = [];

afterEach(async () => {
  // A test about not leaking processes must not leak processes.
  for (const stray of strayProcesses.splice(0)) {
    if (stray.exitCode === null && stray.signalCode === null) {
      try {
        process.kill(-stray.pid!, "SIGKILL");
      } catch {
        stray.kill("SIGKILL");
      }
    }
  }
  await Promise.all(
    temporaryRoots.splice(0).map((value) =>
      rm(value, { recursive: true, force: true })),
  );
});

// A stand-in for `<checkout>/.venv/bin/harness`, laid out at the real path so
// the identifying fragment the suite passes has the real shape. Extensionless,
// like the console script it imitates, so Node loads it as CommonJS whatever
// this package declares.
const FAKE_WORKER = [
  'if (process.argv[2] !== "worker") process.exit(2);',
  "if (process.env.FAKE_WORKER_GRANDCHILD) {",
  '  import("node:child_process").then(({ spawn }) => {',
  "    const child = spawn(",
  '      process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"],',
  '      { stdio: "ignore" },',
  "    );",
  '    import("node:fs").then((fs) => fs.writeFileSync(',
  "      process.env.FAKE_WORKER_GRANDCHILD, `${child.pid}\\n`,",
  "    ));",
  "  });",
  "}",
  "setInterval(() => {}, 1 << 30);",
].join("\n");

async function fakeHarnessBin(root: string, name: string): Promise<string> {
  const directory = path.join(root, name, "agent-harness/.venv/bin");
  await mkdir(directory, { recursive: true });
  const bin = path.join(directory, "harness");
  await writeFile(bin, `${FAKE_WORKER}\n`, "utf8");
  return bin;
}

// Spawned exactly the way the suite spawns a real worker: detached, so it
// leads its own process group. `node <bin> worker` puts "<bin> worker" in the
// command line, which is the fragment the reaper matches on — the same
// substring the kernel leaves behind after resolving the real shim's shebang.
function startFakeWorker(
  bin: string,
  environment: NodeJS.ProcessEnv = {},
): ChildProcess {
  const child = spawn(process.execPath, [bin, "worker"], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, ...environment },
  });
  child.unref();
  strayProcesses.push(child);
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) await delay(50);
}

// Drive one reaper function out of the committed library, in bash, exactly as
// the suite's cleanup trap does.
function runReaper(call: string, environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    "bash",
    ["-euo", "pipefail", "-c", `source "${REAP_HELPER}"\n${call}`],
    { encoding: "utf8", env: { ...process.env, ...environment } },
  );
}

describe("committed INT-2 ceremony mechanics", () => {
  it("keeps all six operator scripts parseable and on the shared evidence definition", async () => {
    const contents = await Promise.all(
      OPERATOR_SCRIPTS.map(async (name) => {
        const target = path.join(SCRIPT_ROOT, name);
        execFileSync("bash", ["-n", target]);
        execFileSync("zsh", ["-n", target]);
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

  it("gives every automated-suite failure a distinct, self-naming exit code", async () => {
    const suite = await readFile(AUTOMATED_SUITE, "utf8");

    // Two unrelated failures sharing an exit code make the code useless for
    // telling them apart. This caught a real collision: a new database
    // failure was assigned 26, already held by the pilot Git ownership probe.
    const codes = [...suite.matchAll(/^\s+exit (\d+)$/gm)]
      .map((match) => Number(match[1]))
      .filter((code) => code !== 1);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);

    // The bring-up region once failed in CI having printed nothing at all,
    // because pg_isready reports on stdout and stdout was sent to /dev/null.
    // Each of these must survive as a named marker, and readiness must be
    // probed over TCP — the transport the suite itself uses — rather than the
    // unix socket, which answers during initdb's temporary server.
    for (const marker of [
      "INT2_DB_START_FAILED",
      "INT2_DB_NEVER_READY",
      "INT2_DB_PORT_UNMAPPED",
      "INT2_DB_DIAGNOSTICS",
    ]) {
      expect(suite).toContain(marker);
    }
    expect(suite).toContain("psql -h 127.0.0.1");
    expect(suite).not.toMatch(/pg_isready -U postgres -d \S+ >\/dev\/null$/m);
  });

  it("keeps the idle model text-only and all three suite counts at ten", async () => {
    const [idleScript, integrationSuite, shellSuite, workflow] =
      await Promise.all([
        readFile(
          path.join(
            ROOT,
            "test/fixtures/agent-integration/ceremony/lint-format-idle.jsonl",
          ),
          "utf8",
        ),
        readFile(
          path.join(ROOT, "test/integration/int2-automated-suite.test.ts"),
          "utf8",
        ),
        readFile(AUTOMATED_SUITE, "utf8"),
        readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
      ]);
    const turns = idleScript.trimEnd().split("\n").map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );

    expect(turns).toEqual([expect.objectContaining({
      text: expect.any(String),
      finish_reason: "stop",
    })]);
    expect(turns[0]).not.toHaveProperty("tool_calls");
    expect(expectationsForCase("idle")).toMatchObject({
      lifecycle: "failed",
      criterion: { passed: false, reason: "exit_1", verdict: "failed" },
      decisions: { dispatch_approval: 1, handoff: 0 },
      expectEmptyOrAbsentPatch: true,
      expectedAcceptanceCommand: INT2_SECTION3_CRITERION,
      expectNoCapabilityEvents: true,
    });

    expect(integrationSuite).toContain("const EXPECTED_CASE_COUNT = 10;");
    expect(shellSuite).toContain("INT2_CASES_STARTED expected=10");
    expect(shellSuite).toContain('test "$_int2_executed" = "10"');
    expect(workflow).toContain("executed-count.txt')\" = \"10\"");
  });

  // verifyScriptedPairPreflight runs two full `git clone --local
  // --no-hardlinks` of this repository concurrently, so this test's wall time
  // tracks whole-suite disk and CPU contention rather than its own logic. It
  // was landed on vitest's 5000ms default and outgrew it: on main it failed 1
  // of 4 back-to-back full-suite runs at 5025ms — the timeout firing, not a
  // wrong assertion.
  //
  // Measured over 24 full-suite runs on a 12-core host, part of them with the
  // timeout lifted to 120s so the true cost was observable: 2628-4108ms, idle
  // and under eight competing CPU burners alike. Every run finished inside
  // that bounded window and passed, which is what rules out a race — a
  // deadlock would not have a ceiling. The worst case was 82% of the 5000ms
  // budget — no useful margin.
  //
  // The failures show up on high-core development hosts rather than in CI,
  // which reads backwards until you account for vitest sizing its worker pool
  // from CPU count: a 12-core box runs more test FILES concurrently, so more
  // clones overlap and contend for disk than on a 4-core runner. CI has stayed
  // green throughout and the 10-iteration flake-stress job passed 10/10 — both
  // consistent with that explanation, and neither consistent with CI being the
  // host nearest the cliff.
  //
  // 30_000 is not arbitrary: the section-3 test below does strictly MORE clone
  // work (three fixture criteria, measured 3379-4530ms against this one's
  // 2628-4108ms), has carried 30_000 since #594, and is green nightly. Same
  // workload class, same budget.
  //
  // Raising the ceiling is the whole fix — the cost itself is irreducible
  // here. Cloning with --no-checkout, so the tree is materialised once at
  // baseRevision instead of at HEAD and again on detach, was measured at only
  // ~100ms of ~850ms per clone, which does not justify editing a production
  // evidence script. Dropping --no-hardlinks was measured too and is a
  // REGRESSION, not a saving: hardlinked local cloning of this repository ran
  // 484ms against 288ms for --no-hardlinks over three runs each. Both obvious
  // avenues are therefore closed, and the ceiling is the fix.
  //
  // These two are also the only tests in the suite anywhere near the default:
  // across all 24 runs every other test topped out at 412ms.
  it("keeps the HALT fixture clear of the kernel's shell.run ceiling", async () => {
    const evidence = await readFile(
      path.join(ROOT, "scripts/ceremony/int2-evidence.mjs"),
      "utf8",
    );
    const suite = await readFile(
      path.join(ROOT, "test/integration/int2-automated-suite.test.ts"),
      "utf8",
    );

    // The kernel caps shell.run at `min(timeout_seconds or 30, 30)`. A fixture
    // that sleeps exactly 30 ties with that ceiling, and the tie decides
    // whether the capability completes or times out — two different run paths
    // from a ~10ms race. Strictly greater keeps the outcome deterministic.
    const match = evidence.match(
      /export const HALT_TOOL_COMMAND = "sleep (\d+)";/u,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(30);

    // And there must be exactly one definition. The verifier asserts the
    // proposed command against HALT_TOOL_COMMAND while the suite spawns
    // HALT_COMMAND; when those were separate literals, widening one and not
    // the other turned a one-line fixture change into a red INT-2 job.
    expect(suite).toContain("const HALT_COMMAND = HALT_TOOL_COMMAND;");
    expect(suite).not.toMatch(/const HALT_COMMAND = "sleep/u);
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
  }, 30_000);

  it("preflights all three paid-task criterion outcomes at the pinned revision", async () => {
    const result = await verifySection3Preflight({
      repositoryRoot: ROOT,
    });

    expect(result).toMatchObject({
      fixture: "lint-format",
      targetPath: INT2_EXPECTED_PATH,
      criterion: INT2_SECTION3_CRITERION,
      correct: {
        exitCode: 0,
        reason: "clean_non_empty_diff",
      },
      incorrect: {
        exitCode: 2,
        reason: "trailing_whitespace",
        details: expect.stringMatching(/trailing whitespace/iu),
      },
      noChange: {
        exitCode: 1,
        reason: "empty_diff",
      },
      exit128Present: false,
      exit129Present: false,
    });
    expect(result.correct.numstat).not.toBe("");
    expect(result.incorrect.numstat).not.toBe("");
    expect(result.noChange.numstat).toBe("");

    const temporary = await mkdtemp(
      path.join(tmpdir(), "int2-section3-mutation-"),
    );
    temporaryRoots.push(temporary);
    const fixture = JSON.parse(
      await readFile(
        path.join(
          ROOT,
          "test/fixtures/agent-integration/ceremony/lint-format.json",
        ),
        "utf8",
      ),
    ) as {
      acceptanceCriteria: Array<{ command: string }>;
    };
    fixture.acceptanceCriteria[0]!.command = "git diff --check";
    const mutatedFixture = path.join(temporary, "lint-format.json");
    await writeFile(mutatedFixture, `${JSON.stringify(fixture, null, 2)}\n`);

    await expect(
      verifySection3Preflight({
        repositoryRoot: ROOT,
        fixturePath: mutatedFixture,
      }),
    ).rejects.toThrow("does not use the discriminating criterion");
  }, 30_000);

  it("keeps the paid run behind pre-flight, container-path, and spend gates", async () => {
    const runbook = await readFile(
      path.join(ROOT, "docs/HARNESS_INT2_CEREMONY_RUNBOOK.md"),
      "utf8",
    );
    const sectionStart = runbook.indexOf(
      "## 3. One budget-capped real-model task",
    );
    const sectionEnd = runbook.indexOf(
      "## 4. Evidence mapped to the INT-2 gate",
    );
    const section = runbook.slice(sectionStart, sectionEnd);
    const preflight = section.indexOf("preflight-section3");
    const credential = section.indexOf(
      'export HARNESS_MODEL_API_KEY="<secret-kept-out-of-evidence>"',
    );

    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(credential).toBeGreaterThan(preflight);
    expect(section).toContain("actual containerized ceremony path");
    expect(section).toContain("exit_129");
    expect(section).toContain(
      "`modelTokens: 8000` is the operative spend limit",
    );
    expect(section).toContain(
      "`estimatedUsdMicros` is `null` and is **not** a monetary enforcement",
    );
    expect(section).toContain("Propose exactly one `lint-format` task");
    expect(section).not.toContain(
      "Propose exactly one `lint-format` or `docs-fix` task",
    );
    expect(section).toContain(
      "Do not run a second real-model task to improve the result. A failure is",
    );
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

  it("fails CI with a named error when the private Harness key is absent", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "int2-checkout-missing-"));
    temporaryRoots.push(temporary);
    const log = path.join(temporary, "bootstrap.log");
    let stderr = "";
    let exitCode: number | undefined;
    try {
      execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; int2_checkout_harness "$2" "$3" "$4"',
          "int2-checkout-test",
          CHECKOUT_HELPER,
          path.join(temporary, "agent-harness"),
          "f010c993b0adfe55899b84a60777b0a4331fd972",
          log,
        ],
        {
          env: {
            ...process.env,
            CI: "true",
            INT2_HARNESS_DEPLOY_KEY: "",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (error) {
      exitCode = (error as { status?: number }).status;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(exitCode).toBe(20);
    expect(stderr).toContain("INT2_HARNESS_DEPLOY_KEY_MISSING");
    expect(await readFile(log, "utf8")).toContain(
      "INT2_HARNESS_DEPLOY_KEY_MISSING",
    );
  });

  it("uses the deploy key only for a strict authenticated Harness checkout", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "int2-checkout-key-"));
    temporaryRoots.push(temporary);
    const fakeBin = path.join(temporary, "bin");
    const fakeGit = path.join(fakeBin, "git");
    const fakeGitLog = path.join(temporary, "git.log");
    const bootstrapLog = path.join(temporary, "bootstrap.log");
    const checkout = path.join(temporary, "agent-harness");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      fakeGit,
      [
        "#!/bin/sh",
        'printf "key=%s\\nssh=%s\\nargs=%s\\n" \\',
        '  "${INT2_HARNESS_DEPLOY_KEY:-absent}" \\',
        '  "${GIT_SSH_COMMAND:-missing}" "$*" >> "$INT2_FAKE_GIT_LOG"',
        'for value in "$@"; do destination="$value"; done',
        'mkdir -p "$destination/.git"',
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeGit, 0o755);

    execFileSync(
      "bash",
      [
        "-c",
        'source "$1"; int2_checkout_harness "$2" "$3" "$4"',
        "int2-checkout-test",
        CHECKOUT_HELPER,
        checkout,
        "f010c993b0adfe55899b84a60777b0a4331fd972",
        bootstrapLog,
      ],
      {
        env: {
          ...process.env,
          CI: "true",
          INT2_FAKE_GIT_LOG: fakeGitLog,
          INT2_HARNESS_DEPLOY_KEY: "test-only-private-key",
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );

    const invocation = await readFile(fakeGitLog, "utf8");
    expect(invocation).toContain("key=absent");
    expect(invocation).toContain(
      "args=clone --quiet git@github.com:averray-agent/agent-harness.git",
    );
    expect(invocation).toContain("IdentitiesOnly=yes");
    expect(invocation).toContain("BatchMode=yes");
    expect(invocation).toContain("StrictHostKeyChecking=yes");
    expect(await readFile(bootstrapLog, "utf8")).toContain(
      "INT2_HARNESS_CHECKOUT_AUTHENTICATED method=read-only-deploy-key",
    );
  });

  it("removes inherited live-model and script-precedence ambiguity", () => {
    const controlled = createInt2WorkerEnvironment(
      {
        PATH: "/test/bin",
        HARNESS_APP_VERSION: "foreign-version",
        HARNESS_BASELINE_MODEL: "live-model",
        HARNESS_MODEL_ADAPTER: "gemini",
        HARNESS_MODEL_API_KEY: "secret",
        HARNESS_TEST_EXECUTOR_MODEL_SCRIPT_OPENAI_COMPATIBLE:
          "/wrong/highest-precedence.jsonl",
        HARNESS_TEST_MODEL_SCRIPT: "/wrong/generic.jsonl",
        HARNESS_TEST_MODEL_FACTORY_COUNTER: "/wrong/counter",
      },
      {
        databaseUrl: "postgresql://test",
        profilesRoot: "/profiles",
        modelScriptPath: "/controlled/model.jsonl",
        artifactRoot: "/artifacts",
      },
    );

    expect(controlled).toMatchObject({
      PATH: "/test/bin",
      HARNESS_APP_VERSION: "pkt-003",
      HARNESS_DATABASE_URL: "postgresql://test",
      HARNESS_MODEL_ADAPTER: "openai-compatible",
      HARNESS_MODEL_BASE_URL: "http://127.0.0.1",
      HARNESS_MODEL_REF: "int2-scripted-model",
      HARNESS_TEST_EXECUTOR_MODEL_SCRIPT_OPENAI_COMPATIBLE:
        "/controlled/model.jsonl",
      HARNESS_TEST_EXECUTOR_MODEL_SCRIPT: "/controlled/model.jsonl",
      HARNESS_TEST_MODEL_SCRIPT_OPENAI_COMPATIBLE:
        "/controlled/model.jsonl",
      HARNESS_TEST_MODEL_SCRIPT: "/controlled/model.jsonl",
    });
    expect(controlled).not.toHaveProperty("HARNESS_BASELINE_MODEL");
    expect(controlled).not.toHaveProperty("HARNESS_MODEL_API_KEY");
    expect(controlled).not.toHaveProperty(
      "HARNESS_TEST_MODEL_FACTORY_COUNTER",
    );
  });

  it("trusts only the fixed sandbox workspace and probes Git before running cases", async () => {
    const [dockerfile, suite] = await Promise.all([
      readFile(PILOT_DOCKERFILE, "utf8"),
      readFile(AUTOMATED_SUITE, "utf8"),
    ]);

    expect(dockerfile).toContain(
      "git config --system --add safe.directory /workspace",
    );
    expect(dockerfile).not.toMatch(
      /safe\.directory\s+(?:"|')?\*(?:"|')?/u,
    );
    expect(suite).toContain("INT2_PILOT_GIT_OWNERSHIP_FAILED");
    expect(suite).toContain("INT2_PILOT_GIT_OWNERSHIP_VERIFIED");
    expect(suite).toContain(
      'git config --system --get-all safe.directory',
    );
    expect(suite).toContain("git diff --check");
  });
});

describe("INT-2 suite reaping", () => {
  it("kills the worker it recorded and spares an operator's worker at a recorded pid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-workers-"));
    temporaryRoots.push(root);
    const [mine, operator] = await Promise.all([
      fakeHarnessBin(root, "suite-run"),
      fakeHarnessBin(root, "operator-ceremony"),
    ]);

    const suiteWorker = startFakeWorker(mine);
    const operatorWorker = startFakeWorker(operator);
    await delay(500);
    expect(isAlive(suiteWorker.pid!)).toBe(true);
    expect(isAlive(operatorWorker.pid!)).toBe(true);

    // The pidfile is DELIBERATELY poisoned with the operator's pid, which is
    // the worst case the design has to survive: a pid recorded by an earlier
    // run, whose worker has since exited and whose number the OS has recycled
    // onto somebody else's process. Tracking pids is not on its own enough —
    // it is tracking plus re-identification that makes this safe. A reaper
    // built on `pkill -f "harness worker"` fails this test on the first line,
    // and that is the failure that blocked a live paid run.
    const pidfile = path.join(root, "worker-pids.txt");
    const log = path.join(root, "bootstrap.log");
    await writeFile(
      pidfile,
      `${suiteWorker.pid}\n${operatorWorker.pid}\n`,
      "utf8",
    );

    runReaper(
      `int2_reap_workers "${pidfile}" "${mine} worker" "${log}"`,
    );

    await waitUntilDead(suiteWorker.pid!);
    expect(isAlive(suiteWorker.pid!)).toBe(false);
    expect(isAlive(operatorWorker.pid!)).toBe(true);

    const reaped = await readFile(log, "utf8");
    expect(reaped).toContain(`INT2_WORKER_REAPED pid=${suiteWorker.pid}`);
    expect(reaped).not.toContain(`pid=${operatorWorker.pid}`);
  }, 30_000);

  it("refuses a non-discriminating identity rather than killing everything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-blank-"));
    temporaryRoots.push(root);
    const bin = await fakeHarnessBin(root, "suite-run");
    const worker = startFakeWorker(bin);
    await delay(500);

    const pidfile = path.join(root, "worker-pids.txt");
    await writeFile(pidfile, `${worker.pid}\n`, "utf8");

    // What an unset HARNESS_BIN composes: " worker", which as a substring
    // matches every Harness worker on the machine. A reaper that accepted it
    // would be `pkill -f "harness worker"` wearing a pidfile.
    runReaper(`int2_reap_workers "${pidfile}" " worker" /dev/null`);
    await delay(500);
    expect(isAlive(worker.pid!)).toBe(true);

    runReaper(`int2_reap_workers "${pidfile}" "${bin} worker" /dev/null`);
    await waitUntilDead(worker.pid!);
    expect(isAlive(worker.pid!)).toBe(false);
  }, 30_000);

  it("takes what the worker spawned with it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-group-"));
    temporaryRoots.push(root);
    const bin = await fakeHarnessBin(root, "suite-run");
    const grandchildPidfile = path.join(root, "grandchild.pid");

    const worker = startFakeWorker(bin, {
      FAKE_WORKER_GRANDCHILD: grandchildPidfile,
    });
    const deadline = Date.now() + 10_000;
    let grandchild = 0;
    while (Date.now() < deadline && grandchild === 0) {
      grandchild = Number(
        await readFile(grandchildPidfile, "utf8").catch(() => ""),
      );
      if (grandchild === 0) await delay(50);
    }
    expect(grandchild).toBeGreaterThan(0);
    expect(isAlive(grandchild)).toBe(true);

    const pidfile = path.join(root, "worker-pids.txt");
    await writeFile(pidfile, `${worker.pid}\n`, "utf8");
    runReaper(`int2_reap_workers "${pidfile}" "${bin} worker" /dev/null`);

    // Signalling -pid rather than pid is the whole point of spawning workers
    // detached: a worker reaped alone leaves its own children orphaned, which
    // is the leak one level down.
    await Promise.all([
      waitUntilDead(worker.pid!),
      waitUntilDead(grandchild),
    ]);
    expect(isAlive(worker.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  }, 30_000);

  it("removes only the run containers that appeared during the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-containers-"));
    temporaryRoots.push(root);
    const removals = path.join(root, "removed.txt");
    const listing = path.join(root, "listing.txt");
    const before = path.join(root, "before.txt");
    const log = path.join(root, "bootstrap.log");
    const fakeBin = path.join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "ps" ]; then cat "$INT2_FAKE_DOCKER_LISTING"; exit 0; fi',
        'if [ "$1" = "rm" ]; then',
        '  printf "%s\\n" "$3" >> "$INT2_FAKE_DOCKER_REMOVALS"; exit 0',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(path.join(fakeBin, "docker"), 0o755);

    // Two leaks predating the run — the days-old ones this fix does not
    // retroactively own — plus a container an operator's concurrent ceremony
    // owns. All three are in the snapshot, so all three survive.
    const preexisting = [
      "harness-run-docker-lifecycle-17e77683d9934e4b84604c100d938777",
      "harness-run-cd16137f-4a63-49f0-8820-40550904afa9",
      "harness-run-0aa6914b-b9b2-4f32-bc09-45894222107b",
    ];
    await writeFile(before, `${preexisting.join("\n")}\n`, "utf8");
    await writeFile(
      listing,
      `${[
        ...preexisting,
        "harness-run-63882cbb-0aa3-5b3b-8459-f11fdb09717b",
        "harness-run-11111111-2222-3333-4444-555555555555-check-1",
      ].join("\n")}\n`,
      "utf8",
    );
    await writeFile(removals, "", "utf8");

    runReaper(`int2_reap_run_containers "${before}" "${log}"`, {
      PATH: `${fakeBin}:${process.env.PATH}`,
      INT2_FAKE_DOCKER_LISTING: listing,
      INT2_FAKE_DOCKER_REMOVALS: removals,
    });

    // The `-check-1` name is why this is a snapshot diff and not a list of run
    // ids read out of the runs table: verification runs derive ids that no
    // table holds, so a query-driven reaper would leak exactly that container.
    expect((await readFile(removals, "utf8")).trim().split("\n")).toEqual([
      "harness-run-63882cbb-0aa3-5b3b-8459-f11fdb09717b",
      "harness-run-11111111-2222-3333-4444-555555555555-check-1",
    ]);
    expect(await readFile(log, "utf8")).not.toContain("docker-lifecycle");
  });

  it("removes nothing at all when it never got to take a snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-nosnapshot-"));
    temporaryRoots.push(root);
    const removals = path.join(root, "removed.txt");
    const listing = path.join(root, "listing.txt");
    const fakeBin = path.join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "ps" ]; then cat "$INT2_FAKE_DOCKER_LISTING"; exit 0; fi',
        'if [ "$1" = "rm" ]; then',
        '  printf "%s\\n" "$3" >> "$INT2_FAKE_DOCKER_REMOVALS"; exit 0',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(path.join(fakeBin, "docker"), 0o755);
    await writeFile(
      listing,
      "harness-run-cd16137f-4a63-49f0-8820-40550904afa9\n",
      "utf8",
    );
    await writeFile(removals, "", "utf8");

    // Wiping every harness-run-* container because the suite died before it
    // could look is strictly worse than leaking, so a missing snapshot is
    // inaction, not licence.
    runReaper(
      `int2_reap_run_containers "${path.join(root, "absent.txt")}" /dev/null`,
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        INT2_FAKE_DOCKER_LISTING: listing,
        INT2_FAKE_DOCKER_REMOVALS: removals,
      },
    );

    expect(await readFile(removals, "utf8")).toBe("");
  });

  it("wires the suite to hand its workers and its snapshot to the trap", async () => {
    const [suite, reaper, integration] = await Promise.all([
      readFile(AUTOMATED_SUITE, "utf8"),
      readFile(REAP_HELPER, "utf8"),
      readFile(
        path.join(ROOT, "test/integration/int2-automated-suite.test.ts"),
        "utf8",
      ),
    ]);
    execFileSync("bash", ["-n", REAP_HELPER]);

    // Pattern-killing is the fix that looks right and is not: an operator's
    // ceremony worker matches "harness worker" just as well as the suite's.
    // Comments are stripped first — both files discuss `pkill` at length, and
    // an assertion that forbids naming the trap is an assertion that will be
    // deleted rather than satisfied.
    const withoutComments = (source: string): string =>
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    for (const source of [suite, reaper]) {
      expect(withoutComments(source)).not.toContain("pkill");
      expect(withoutComments(source)).not.toMatch(
        /pgrep -f ["']?harness worker/u,
      );
    }

    expect(suite).toContain("lib/int2-reap.sh");
    expect(suite).toContain("int2_reap_workers");
    expect(suite).toContain("int2_reap_run_containers");
    expect(suite).toContain("export INT2_SUITE_WORKER_PIDFILE=");

    // The snapshot has to be the last thing before the cases: it defines
    // "during the run", and every container born after it is the suite's.
    const snapshotAt = suite.indexOf("int2_reap_snapshot_run_containers ");
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(suite.indexOf("INT2_CASES_STARTED"));
    expect(snapshotAt).toBeGreaterThan(suite.indexOf("npx vitest run") === -1
      ? -1
      : suite.indexOf("INT2_PILOT_GIT_OWNERSHIP_VERIFIED"));

    // A worker whose pid never reached the pidfile is a worker the trap cannot
    // reap, so recording must not be able to slip behind an await.
    expect(integration).toContain("detached: true");
    expect(integration).toContain("recordWorkerPid(child.pid)");
    expect(integration).toContain("appendFileSync(pidfile");
    expect(integration).toContain('"SIGKILL"');

    // #625: the workspace half rides the same snapshot boundary and the same
    // trap, after the container reap (bind mounts released first), with its
    // own self-naming failure code.
    expect(suite).toContain("int2_reap_snapshot_workspaces ");
    expect(suite).toContain("int2_reap_workspaces ");
    expect(suite).toContain("INT2_WORKSPACE_SNAPSHOT_FAILED");
    expect(suite).toContain("exit 35");
    expect(suite).toContain('INT2_WORKSPACE_ROOT:-$HOME/.agent-runtime/environments');
    expect(suite.indexOf("int2_reap_workspaces ")).toBeGreaterThan(
      suite.indexOf("int2_reap_run_containers "),
    );
  });

  it("removes only the workspaces born during the run and spares the snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-workspaces-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "environments");
    const before = path.join(root, "before.txt");
    const log = path.join(root, "reap.log");
    // An operator's pre-existing workspace and a days-old leak this run does
    // not own: both are in the snapshot, both must survive.
    await mkdir(path.join(workspaceRoot, "agent-runtime-operator-live"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "agent-runtime-old-leak"), { recursive: true });
    runReaper(`int2_reap_snapshot_workspaces "${before}" "${workspaceRoot}"`);

    // Born during the run: a top-level run and a derived verification run —
    // the unknowable-up-front name shape that makes this a snapshot diff.
    await mkdir(path.join(workspaceRoot, "agent-runtime-suite-run", "repo"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "agent-runtime-suite-run", "repo", "file.txt"),
      "contents",
    );
    await mkdir(path.join(workspaceRoot, "agent-runtime-suite-run-check-1"), { recursive: true });
    // Not the reap's shape at all — spared regardless of the snapshot.
    await mkdir(path.join(workspaceRoot, "unrelated-dir"), { recursive: true });

    runReaper(`int2_reap_workspaces "${before}" "${workspaceRoot}" "${log}"`);

    const survivors = (await readdir(workspaceRoot)).sort();
    expect(survivors).toEqual([
      "agent-runtime-old-leak",
      "agent-runtime-operator-live",
      "unrelated-dir",
    ]);
    const logged = await readFile(log, "utf8");
    expect(logged).toContain("INT2_WORKSPACE_REAPED name=agent-runtime-suite-run");
    expect(logged).toContain("INT2_WORKSPACE_REAPED name=agent-runtime-suite-run-check-1");
  });

  it("treats a root that does not exist yet as an empty snapshot, not a failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-ws-fresh-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "environments");
    const before = path.join(root, "before.txt");
    // Root absent: snapshot succeeds and is empty — nothing existed to spare.
    runReaper(`int2_reap_snapshot_workspaces "${before}" "${workspaceRoot}"`);
    // The run then creates the root and a workspace; both are the suite's.
    await mkdir(path.join(workspaceRoot, "agent-runtime-first"), { recursive: true });
    runReaper(`int2_reap_workspaces "${before}" "${workspaceRoot}" /dev/null`);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it("removes no workspace at all when it never got to take a snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "int2-reap-ws-nosnap-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "environments");
    await mkdir(path.join(workspaceRoot, "agent-runtime-unattributed"), { recursive: true });
    // Same fail-safe as containers: deleting somebody's workspace because the
    // suite failed before it could look is strictly worse than leaking.
    runReaper(
      `int2_reap_workspaces "${path.join(root, "absent.txt")}" "${workspaceRoot}" /dev/null`,
    );
    expect(await readdir(workspaceRoot)).toEqual(["agent-runtime-unattributed"]);
  });
});
