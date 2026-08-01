import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
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
          "0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2",
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
        "0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2",
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
