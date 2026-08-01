import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { runPilotCli } from "../../scripts/ops/harness-pilot.mjs";
import {
  collectInt2Evidence,
  INT2_EXPECTED_PATH,
  INT2_HARNESS_PIN,
  INT2_PILOT_CAPABILITIES,
  Int2EvidenceError,
  verifyInt2Evidence,
  verifyScriptedPairPreflight,
} from "../../scripts/ceremony/int2-evidence.mjs";
import {
  createInt2WorkerEnvironment,
} from "../../scripts/ceremony/int2-worker-environment.mjs";
import {
  createProductionDispatcher,
  type DispatcherLogger,
  type DispatcherProcess,
} from "../../services/harness-dispatcher/src/index.js";
import {
  loadProfileManifest,
  ProfileManifestError,
} from "../../services/harness-dispatcher/src/profile-manifest.js";

const execFileAsync = promisify(execFile);
const REQUIRED_ENVIRONMENT = [
  "DISPATCH_TEST_DATABASE_URL",
  "HARNESS_TEST_DATABASE_URL",
  "HARNESS_BIN",
  "HARNESS_CHECKOUT",
  "INT2_PILOT_IMAGE",
] as const;
const missingEnvironment = REQUIRED_ENVIRONMENT.filter(
  (name) => !process.env[name]?.trim(),
);
const required = process.env.INT2_SUITE_REQUIRED === "1";
if (required && missingEnvironment.length > 0) {
  throw new Error(
    `INT-2 suite is required but missing: ${missingEnvironment.join(", ")}`,
  );
}
const ready = missingEnvironment.length === 0;
const REPOSITORY_ROOT = path.resolve(
  process.env.INT2_REPOSITORY_ROOT ?? path.join(import.meta.dirname, "../.."),
);
const FIXTURE_ROOT = path.join(
  REPOSITORY_ROOT,
  "test/fixtures/agent-integration/ceremony",
);
const EXPECTED_CASE_COUNT = 10;
const TEST_TIMEOUT_MS = 240_000;
const TERMINAL_WAIT_MS = 180_000;
const HARNESS_STATE_WAIT_MS = 90_000;
// Must exceed the kernel's shell.run ceiling, not equal it. That ceiling is
// `min(timeout_seconds or 30, 30)` in capabilities/native.py, so `sleep 30` is
// a literal tie: whichever side wins by milliseconds decides whether the
// capability COMPLETES or TIMES OUT, and those are different run paths. One
// observed run recorded duration 30.0099 with ok:true where the reference
// record has 30.0585 with command_timeout — a ~10ms coin flip that failed this
// case on code identical to two runs that passed.
//
// 45 always loses to the ceiling, so the command always times out at 30s and
// the run reliably sits in `executing` for the whole window the HALT drill
// needs. Do not lower this to 30. See the guard in int2-ceremony-scripts.test.
const HALT_COMMAND = "sleep 45";
const SENTINEL_RUN_ID = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!ready)("INT-2 automated supervised-dispatch suite", () => {
  let root: string;
  let profilesRoot: string;
  let modelScriptPath: string;
  let haltFile: string;
  let evidenceRoot: string;
  let workerHome: string;
  let referencePool: Pool;
  let harnessPool: Pool;
  let suitePrefix: string;
  let executedCases = 0;
  const d3Results: Array<{
    case: string;
    mutation: string;
    observedFailure: string;
  }> = [];
  const workers = new Set<HarnessWorker>();
  const workItemIds = new Set<string>();
  const loggerRecords: Array<{
    level: "info" | "warn";
    fields: Record<string, unknown>;
    message: string;
  }> = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "int2-suite-"));
    profilesRoot = path.join(root, "profiles");
    modelScriptPath = path.join(root, "model-script.jsonl");
    haltFile = path.join(root, "HALT");
    evidenceRoot = process.env.INT2_SUITE_EVIDENCE_DIR
      ? path.resolve(process.env.INT2_SUITE_EVIDENCE_DIR)
      : path.join(root, "evidence");
    workerHome = path.join(root, "worker-home");
    suitePrefix = `int2-ci-${process.pid}-${Date.now()}`;
    await Promise.all([
      mkdir(profilesRoot, { recursive: true }),
      mkdir(evidenceRoot, { recursive: true }),
      mkdir(path.join(root, "dispatch-artifacts"), { recursive: true }),
      mkdir(path.join(root, "dispatch-intents"), { recursive: true }),
      mkdir(workerHome, { recursive: true }),
    ]);

    await assertHarnessPin();
    await prepareLocalGitRemote();
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
    installProcessEnvironment();

    referencePool = new Pool({
      connectionString: process.env.DISPATCH_TEST_DATABASE_URL,
    });
    harnessPool = new Pool({
      connectionString: process.env.HARNESS_TEST_DATABASE_URL,
    });
    await applyReferenceMigrations();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    // Every worker gets stopped even when an earlier one refuses to. The
    // sequential `await` this replaces abandoned the rest of the set on the
    // first throw, so one stuck worker leaked all the others behind it.
    // Failures are re-raised below, after the evidence is written.
    const stops = await Promise.allSettled(
      [...workers].map((worker) => worker.stop()),
    );
    await referencePool?.end();
    await harnessPool?.end();
    await Promise.all(
      [...workItemIds].map((workItemId) =>
        rm(
          `/var/lib/harness-dispatcher/workspaces/${workItemId}-v1`,
          { recursive: true, force: true },
        )),
    );
    await writeFile(
      path.join(evidenceRoot, "suite-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        harnessPin: INT2_HARNESS_PIN,
        executedCases,
        expectedCases: EXPECTED_CASE_COUNT,
        attenuationBoundary: {
          production: [
            "profile_loader_unvetted_capability",
            "narrower_profile_accepted",
          ],
          typedOnly: [
            "capability_not_granted",
            "capability_effect_external",
          ],
          typedChecksReachableThroughProductionProfileLoading: false,
        },
        d3: d3Results,
      }, null, 2)}\n`,
      "utf8",
    );
    if (process.env.INT2_SUITE_EXECUTION_MARKER) {
      await writeFile(
        process.env.INT2_SUITE_EXECUTION_MARKER,
        `${executedCases}\n`,
        "utf8",
      );
    }
    await rm(root, { recursive: true, force: true });
    const stuck = stops.filter((stop) => stop.status === "rejected");
    if (stuck.length > 0) {
      throw new Error(
        `${stuck.length} Harness worker(s) could not be stopped: `
          + stuck.map((stop) => String(stop.reason)).join("; "),
      );
    }
  }, TEST_TIMEOUT_MS);

  it("preflights the controlled red/green pair against a real tracked diff", async () => {
    executedCases += 1;
    const result = await verifyScriptedPairPreflight({
      repositoryRoot: REPOSITORY_ROOT,
    });

    expect(result.targetPath).toBe(INT2_EXPECTED_PATH);
    expect(result.green.exitCode).toBe(0);
    expect(result.negative.exitCode).not.toBe(0);
    expect(result.negative.exitCode).not.toBe(128);
    expect(result.green.numstat).not.toBe("");
    expect(result.negative.numstat).not.toBe("");
    d3Results.push({
      case: "controlled-pair",
      mutation: "the red fixture adds trailing whitespace to the same append",
      observedFailure: `git diff --check exit ${result.negative.exitCode}`,
    });
  }, TEST_TIMEOUT_MS);

  it("keeps an unapproved task outside the production dispatchable set", async () => {
    executedCases += 1;
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
    const workItemId = nextWorkItem("unapproved");
    await propose("lint-format-green", workItemId);

    const dispatcher = createDispatcher();
    await expect(dispatcher.tick()).resolves.toMatchObject({ outcome: "idle" });
    await dispatcher.shutdown();

    const evidence = await collectEvidence(
      "unapproved",
      workItemId,
      SENTINEL_RUN_ID,
    );
    assertD3Mutation(
      "unapproved",
      evidence,
      (mutated) => {
        mutated.task.lifecycle = "approved";
      },
      "terminal_lifecycle",
      "change the stored lifecycle from proposed to approved",
    );
  }, TEST_TIMEOUT_MS);

  it("refuses an approval-hash mismatch before claim or submit", async () => {
    executedCases += 1;
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
    const workItemId = nextWorkItem("hash-mismatch");
    const approval = await proposeAndApprove("lint-format-green", workItemId);
    await referencePool.query(
      `update agent_tasks
       set task = jsonb_set(task, '{proposal,title}', '"tampered after approval"')
       where work_item_id = $1 and task_version = 1`,
      [workItemId],
    );

    const dispatcher = createDispatcher();
    await expect(dispatcher.tick()).resolves.toMatchObject({
      outcome: "refused",
      reason: "approval_hash_mismatch",
    });
    await dispatcher.shutdown();

    const evidence = await collectEvidence(
      "hash-mismatch",
      workItemId,
      approval.intendedRunId,
    );
    assertD3Mutation(
      "hash-mismatch",
      evidence,
      (mutated) => {
        mutated.decisions[0].proposal.why = ["wrong_reason"];
      },
      "decision_reason",
      "replace the recorded refusal reason",
    );
  }, TEST_TIMEOUT_MS);

  it("rejects the negative fixture on its merits with no handoff", async () => {
    executedCases += 1;
    const evidence = await runScriptedTerminalCase({
      caseName: "negative",
      fixture: "lint-format-red",
      script: "lint-format-red.jsonl",
      lifecycle: "failed",
    });
    assertD3Mutation(
      "negative",
      evidence,
      (mutated) => {
        mutated.exit128Present = true;
      },
      "events_have_no_exit_128",
      "inject exit_128 into the recorded verifier evidence",
    );
  }, TEST_TIMEOUT_MS);

  it("refuses an idle model on the exact paid-task criterion", async () => {
    executedCases += 1;
    const evidence = await runScriptedTerminalCase({
      caseName: "idle",
      fixture: "lint-format",
      script: "lint-format-idle.jsonl",
      lifecycle: "failed",
    });
    assertD3Mutation(
      "idle",
      evidence,
      (mutated) => {
        const format = mutated.verification.details.find(
          (detail: any) => detail.id === "format-command",
        );
        format.reason = "exit_0";
      },
      "required_criterion_reason",
      "change the recorded criterion reason from exit_1 to exit_0",
    );
  }, TEST_TIMEOUT_MS);

  it("produces one verified, unactuated green handoff", async () => {
    executedCases += 1;
    const evidence = await runScriptedTerminalCase({
      caseName: "green",
      fixture: "lint-format-green",
      script: "lint-format-green.jsonl",
      lifecycle: "handoff_ready",
    });
    assertD3Mutation(
      "green",
      evidence,
      (mutated) => {
        mutated.patch.numstat = "";
      },
      "criterion_inspected_non_empty_diff",
      "erase the reconstructed git diff --numstat",
    );
  }, TEST_TIMEOUT_MS);

  it("restarts between submit and reconcile without duplicating the run", async () => {
    executedCases += 1;
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
    await stageModelScript("lint-format-green.jsonl");
    const workItemId = nextWorkItem("restart");
    const approval = await proposeAndApprove("lint-format-green", workItemId);
    const worker = await startWorker();
    const first = createDispatcher();
    await expect(first.tick()).resolves.toMatchObject({
      outcome: "dispatched",
      intendedRunId: approval.intendedRunId,
    });
    await first.shutdown();

    const replay = await execFileAsync(
      process.env.HARNESS_BIN!,
      [
        "run",
        "submit",
        "--run-id",
        approval.intendedRunId,
        path.join(root, "dispatch-intents", `${workItemId}-v1.json`),
      ],
      {
        cwd: process.env.HARNESS_CHECKOUT,
        env: process.env,
      },
    );
    expect(replay.stdout.trim()).toBe(approval.intendedRunId);

    const restarted = createDispatcher();
    await waitForLifecycle(
      restarted,
      workItemId,
      "handoff_ready",
      approval.intendedRunId,
      worker,
    );
    await restarted.shutdown();
    await stopWorker(worker);

    const evidence = await collectEvidence(
      "restart",
      workItemId,
      approval.intendedRunId,
    );
    assertD3Mutation(
      "restart",
      evidence,
      (mutated) => {
        mutated.runs.push(structuredClone(mutated.runs[0]));
      },
      "one_harness_run",
      "duplicate the Harness run projection",
    );
  }, TEST_TIMEOUT_MS);

  it("HALT cancels a bound live run and never creates a handoff", async () => {
    executedCases += 1;
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
    await stageHaltModelScript();
    const workItemId = nextWorkItem("halt");
    const approval = await proposeAndApprove("lint-format-green", workItemId);
    const worker = await startWorker();
    const dispatcher = createDispatcher();
    try {
      await expect(dispatcher.tick()).resolves.toMatchObject({
        outcome: "dispatched",
        intendedRunId: approval.intendedRunId,
      });
      await waitForHarnessToolDispatch(
        approval.intendedRunId,
        HALT_COMMAND,
      );
      await writeFile(haltFile, "INT-2 automated HALT drill\n", "utf8");
      await expect(dispatcher.tick()).resolves.toMatchObject({ outcome: "halted" });
      await waitForHarnessState(approval.intendedRunId, "cancelled");
    } finally {
      await dispatcher.shutdown();
      await unlink(haltFile).catch(() => undefined);
      await stopWorker(worker);
    }

    const evidence = await collectEvidence(
      "halt",
      workItemId,
      approval.intendedRunId,
    );
    assertD3Mutation(
      "halt",
      evidence,
      (mutated) => {
        mutated.decisions = mutated.decisions.filter(
          (decision) => decision.decisionType !== "escalation",
        );
      },
      "decision_escalation_count",
      "remove the HALT escalation decision",
    );
  }, TEST_TIMEOUT_MS);

  it("accepts a seven-capability profile with strictly narrower authority", async () => {
    executedCases += 1;
    const narrowed = INT2_PILOT_CAPABILITIES.filter(
      (capability) => capability !== "fs.write_file",
    );
    await writePilotProfile(narrowed);
    const evidence = await runScriptedTerminalCase({
      caseName: "narrow",
      fixture: "lint-format-green",
      script: "lint-format-green.jsonl",
      lifecycle: "handoff_ready",
      preserveProfile: true,
    });
    assertD3Mutation(
      "narrow",
      evidence,
      (mutated) => {
        mutated.runs[0].manifest.grants.splice(1, 0, {
          capability: "fs.write_file",
        });
      },
      "effective_authority_narrowed",
      "restore fs.write_file to the effective run manifest",
    );
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
  }, TEST_TIMEOUT_MS);

  it("rejects memory.propose in the outer production profile loader", async () => {
    executedCases += 1;
    await writePilotProfile([...INT2_PILOT_CAPABILITIES, "memory.propose"]);
    let observedProfileFailure:
      { name: string; reason: string } | undefined;
    try {
      await loadProfileManifest("coding-change-pilot", process.env);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileManifestError);
      const profileError = error as ProfileManifestError;
      observedProfileFailure = {
        name: profileError.name,
        reason: profileError.reason,
      };
    }
    expect(observedProfileFailure).toEqual({
      name: "ProfileManifestError",
      reason: "unvetted_capability",
    });
    if (!observedProfileFailure) {
      throw new Error("profile loader did not reject the unvetted capability");
    }
    const workItemId = nextWorkItem("profile-unvetted");
    const approval = await proposeAndApprove("lint-format-green", workItemId);
    const loggerStart = loggerRecords.length;
    const dispatcher = createDispatcher();
    await expect(dispatcher.tick()).resolves.toEqual({
      outcome: "error",
      reason: "attempt_failed",
    });
    await dispatcher.shutdown();
    const profileFailure = loggerRecords.slice(loggerStart).find(
      (record) =>
        record.level === "warn"
        && record.fields.errorName === "ProfileManifestError",
    );
    expect(profileFailure).toBeDefined();

    const evidence = await collectEvidence(
      "profile-unvetted",
      workItemId,
      approval.intendedRunId,
      {
        profileLoadError: observedProfileFailure,
      },
    );
    assertD3Mutation(
      "profile-unvetted",
      evidence,
      (mutated) => {
        mutated.profileLoadError.reason = "capability_not_granted";
      },
      "outer_profile_loader_refusal",
      "mislabel the outer loader failure as the unreachable inner guard",
    );
    await writePilotProfile(INT2_PILOT_CAPABILITIES);
  }, TEST_TIMEOUT_MS);

  async function runScriptedTerminalCase({
    caseName,
    fixture,
    script,
    lifecycle,
    preserveProfile = false,
  }: {
    caseName: "green" | "idle" | "negative" | "narrow";
    fixture: "lint-format" | "lint-format-green" | "lint-format-red";
    script:
      | "lint-format-green.jsonl"
      | "lint-format-idle.jsonl"
      | "lint-format-red.jsonl";
    lifecycle: "handoff_ready" | "failed";
    preserveProfile?: boolean;
  }): Promise<any> {
    if (!preserveProfile) {
      await writePilotProfile(INT2_PILOT_CAPABILITIES);
    }
    await stageModelScript(script);
    const workItemId = nextWorkItem(caseName);
    const approval = await proposeAndApprove(fixture, workItemId);
    const worker = await startWorker();
    const dispatcher = createDispatcher();
    try {
      await waitForLifecycle(
        dispatcher,
        workItemId,
        lifecycle,
        approval.intendedRunId,
        worker,
      );
    } finally {
      await dispatcher.shutdown();
      await stopWorker(worker);
    }
    return collectEvidence(caseName, workItemId, approval.intendedRunId);
  }

  async function collectEvidence(
    caseName: string,
    workItemId: string,
    intendedRunId: string,
    extras: {
      profileLoadError?: { name: string; reason: string };
    } = {},
  ): Promise<any> {
    const evidence = await collectInt2Evidence({
      workItemId,
      intendedRunId,
      referenceDatabaseUrl: process.env.DISPATCH_TEST_DATABASE_URL,
      harnessDatabaseUrl: process.env.HARNESS_TEST_DATABASE_URL,
      harnessBin: process.env.HARNESS_BIN,
      expectedPath: INT2_EXPECTED_PATH,
      evidenceDir: path.join(evidenceRoot, caseName),
      ...extras,
    });
    expect(() => verifyInt2Evidence(evidence, caseName)).not.toThrow();
    return evidence;
  }

  function assertD3Mutation(
    caseName: string,
    evidence: any,
    mutate: (value: any) => void,
    expectedFailure: string,
    mutation: string,
  ): void {
    const mutated = structuredClone(evidence);
    mutate(mutated);
    let observed = "";
    try {
      verifyInt2Evidence(mutated, caseName);
    } catch (error) {
      expect(error).toBeInstanceOf(Int2EvidenceError);
      observed = (error as Error).message;
    }
    expect(observed).toContain(expectedFailure);
    d3Results.push({
      case: caseName,
      mutation,
      observedFailure: expectedFailure,
    });
  }

  async function propose(
    fixture: string,
    workItemId: string,
  ): Promise<Record<string, any>> {
    return pilotCommand([
      "propose",
      "--fixture",
      fixture,
      "--work-item",
      workItemId,
    ]);
  }

  async function proposeAndApprove(
    fixture: string,
    workItemId: string,
  ): Promise<{ intendedRunId: string }> {
    await propose(fixture, workItemId);
    const result = await pilotCommand([
      "approve",
      "--work-item",
      workItemId,
      "--version",
      "1",
      "--operator",
      "int2-ci-operator",
      "--confirm",
    ]);
    expect(result.submissionAttemptedByCli).toBe(false);
    expect(result.approvedTaskHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.intendedRunId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
    );
    return { intendedRunId: result.intendedRunId };
  }

  async function pilotCommand(
    args: string[],
  ): Promise<Record<string, any>> {
    let stdout = "";
    let stderr = "";
    const code = await runPilotCli(args, {
      environment: process.env,
      output: (line: string) => {
        stdout += line;
      },
      errorOutput: (line: string) => {
        stderr += line;
      },
    });
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as Record<string, any>;
  }

  function nextWorkItem(caseName: string): string {
    const value = `${suitePrefix}-${caseName}`;
    workItemIds.add(value);
    return value;
  }

  function createDispatcher(): DispatcherProcess {
    return createProductionDispatcher(
      { ...process.env },
      suiteLogger,
    );
  }

  async function waitForLifecycle(
    dispatcher: DispatcherProcess,
    workItemId: string,
    expected: string,
    intendedRunId: string,
    worker: HarnessWorker,
  ): Promise<void> {
    const deadline = Date.now() + TERMINAL_WAIT_MS;
    let lastLifecycle = "<missing>";
    while (Date.now() < deadline) {
      await dispatcher.tick();
      const result = await referencePool.query<{
        lifecycle: string;
      }>(
        `select lifecycle from agent_tasks
         where work_item_id = $1 and task_version = 1`,
        [workItemId],
      );
      lastLifecycle = result.rows[0]?.lifecycle ?? "<missing>";
      if (lastLifecycle === expected) return;
      if (["blocked", "cancelled", "failed", "handoff_ready"].includes(
        lastLifecycle,
      )) {
        const diagnostics = await writeLifecycleDiagnostics({
          workItemId,
          intendedRunId,
          expectedLifecycle: expected,
          lastLifecycle,
          worker,
        });
        throw new Error(
          `${workItemId} reached unexpected terminal lifecycle `
            + `${lastLifecycle}; expected ${expected}; harness=${
              diagnostics.harnessRun?.state ?? "<missing>"
            }; diagnostics=${diagnostics.path}`,
        );
      }
      await delay(500);
    }
    const diagnostics = await writeLifecycleDiagnostics({
      workItemId,
      intendedRunId,
      expectedLifecycle: expected,
      lastLifecycle,
      worker,
    });
    throw new Error(
      `Timed out waiting for ${workItemId} lifecycle ${expected}; `
        + `last=${lastLifecycle}; harness=${diagnostics.harnessRun?.state
          ?? "<missing>"}; diagnostics=${diagnostics.path}`,
    );
  }

  async function writePilotProfile(
    capabilities: readonly string[],
  ): Promise<void> {
    const directory = path.join(profilesRoot, "coding-change-pilot");
    await mkdir(directory, { recursive: true });
    const bytes = [
      "name: coding-change-pilot",
      'version: "1"',
      "environment:",
      "  provider: docker",
      `  image: "${process.env.INT2_PILOT_IMAGE}"`,
      "egress:",
      "  mode: deny_all",
      "  allowed_destinations: []",
      "model:",
      "  executor:",
      "    adapter: openai-compatible",
      "    model_ref: null",
      "capabilities:",
      ...capabilities.map((capability) => `  - ${capability}`),
      "verification:",
      "  baseline_command: null",
      "  protected_paths: []",
      "strategies:",
      "  - direct_execution",
      "retention_policy: standard",
      "",
    ].join("\n");
    await writeFile(path.join(directory, "profile.yaml"), bytes, "utf8");
    process.env.HARNESS_PROFILE_SHA256 = createHash("sha256")
      .update(bytes, "utf8")
      .digest("hex");
  }

  async function stageModelScript(file: string): Promise<void> {
    await copyFile(path.join(FIXTURE_ROOT, file), modelScriptPath);
  }

  async function stageHaltModelScript(): Promise<void> {
    await writeFile(
      modelScriptPath,
      [
        JSON.stringify({
          tool_calls: [{
            id: "int2-halt-sleep",
            name: "shell_run",
            arguments: { command: HALT_COMMAND },
          }],
          usage: { input_tokens: 2, output_tokens: 1, requests: 1 },
          finish_reason: "tool_call",
        }),
        JSON.stringify({
          text: "The bounded HALT probe was interrupted.",
          usage: { input_tokens: 2, output_tokens: 2, requests: 1 },
          finish_reason: "stop",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async function startWorker(): Promise<HarnessWorker> {
    const output: string[] = [];
    const child = spawn(process.env.HARNESS_BIN!, ["worker"], {
      cwd: process.env.HARNESS_CHECKOUT,
      env: createInt2WorkerEnvironment(process.env, {
        databaseUrl: process.env.HARNESS_TEST_DATABASE_URL!,
        profilesRoot,
        modelScriptPath,
        artifactRoot: process.env.HARNESS_ARTIFACT_ROOT!,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      // Leads its own process group, so the suite script's cleanup trap can
      // take the worker and everything it spawned with one signal to -pid.
      detached: true,
    });
    recordWorkerPid(child.pid);
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline
      && child.exitCode === null
      && !output.join("").includes("worker ready")
    ) {
      await delay(100);
    }
    if (
      child.exitCode !== null
      || !output.join("").includes("worker ready")
    ) {
      child.kill("SIGTERM");
      throw new Error(
        `Harness worker did not become ready (${child.exitCode}): `
          + output.join("").slice(-4_000),
      );
    }
    const worker = new HarnessWorker(child, output);
    workers.add(worker);
    return worker;
  }

  async function stopWorker(worker: HarnessWorker): Promise<void> {
    await worker.stop();
    workers.delete(worker);
  }

  async function assertHarnessPin(): Promise<void> {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", process.env.HARNESS_CHECKOUT!, "rev-parse", "HEAD"],
    );
    expect(stdout.trim()).toBe(INT2_HARNESS_PIN);
    await execFileAsync(process.env.HARNESS_BIN!, ["--help"], {
      cwd: process.env.HARNESS_CHECKOUT,
    });
  }

  async function prepareLocalGitRemote(): Promise<void> {
    const fixture = JSON.parse(
      await readFile(path.join(FIXTURE_ROOT, "lint-format-green.json"), "utf8"),
    ) as { repository: { baseRevision: string } };
    await execFileAsync(
      "git",
      ["-C", REPOSITORY_ROOT, "cat-file", "-e", `${fixture.repository.baseRevision}^{commit}`],
    );
    const bare = path.join(root, "reference-agent.git");
    await execFileAsync("git", [
      "clone",
      "--bare",
      "--local",
      "--no-hardlinks",
      REPOSITORY_ROOT,
      bare,
    ]);
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${bare}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 =
      "https://github.com/depre-dev/averray-reference-agent.git";
    process.env.GIT_CONFIG_KEY_1 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_1 = "always";
  }

  function installProcessEnvironment(): void {
    // The worker, dispatcher CLI reads, and evidence collector must share one
    // isolated artifact root. Do not override HOME: Docker CLI contexts are
    // home-scoped, and the Docker provider's workspace must remain beneath a
    // host path shared with the desktop VM.
    process.env.HARNESS_ARTIFACT_ROOT =
      path.join(workerHome, ".agent-runtime/artifacts");
    process.env.DATABASE_URL = process.env.DISPATCH_TEST_DATABASE_URL;
    process.env.HARNESS_DATABASE_URL = process.env.HARNESS_TEST_DATABASE_URL;
    process.env.HARNESS_PROFILES_ROOT = profilesRoot;
    process.env.HARNESS_DISPATCH_ARTIFACT_DIR =
      path.join(root, "dispatch-artifacts");
    process.env.HARNESS_DISPATCH_INTENT_DIR =
      path.join(root, "dispatch-intents");
    process.env.HARNESS_DISPATCH_HEARTBEAT_PATH =
      path.join(root, "dispatcher-heartbeat.json");
    process.env.HARNESS_DISPATCH_ALERTS_PATH =
      path.join(root, "dispatcher-alerts.jsonl");
    process.env.HARNESS_DISPATCH_READ_TIMEOUT_MS = "30000";
    process.env.HARNESS_DISPATCH_ENABLED = "true";
    process.env.HARNESS_DISPATCHER_ID = `int2-suite-${process.pid}`;
    process.env.HALT_FILE = haltFile;
    process.env.POLICY_CONFIG_PATH =
      path.join(REPOSITORY_ROOT, "hermes/config/policy.yaml");
    process.env.HERMES_DISPATCH_ALLOWED_REPOS =
      "depre-dev/averray-reference-agent";
    delete process.env.HARNESS_DISPATCH_DEP_CACHE_DIR;
  }

  async function applyReferenceMigrations(): Promise<void> {
    const migrationRoot = path.join(REPOSITORY_ROOT, "ops/migrations");
    for (const name of (await readdir(migrationRoot))
      .filter((value) => value.endsWith(".sql"))
      .sort()) {
      await referencePool.query(
        await readFile(path.join(migrationRoot, name), "utf8"),
      );
    }
  }

  async function waitForHarnessState(
    runId: string,
    expected: string,
  ): Promise<void> {
    const deadline = Date.now() + HARNESS_STATE_WAIT_MS;
    let lastState = "<missing>";
    while (Date.now() < deadline) {
      const result = await harnessPool.query<{ state: string }>(
        "select state from runs where run_id = $1",
        [runId],
      );
      lastState = result.rows[0]?.state ?? "<missing>";
      if (lastState === expected) return;
      if (
        expected === "executing"
        && ["cancelled", "failed", "learning_processed"].includes(lastState)
      ) {
        break;
      }
      await delay(100);
    }
    throw new Error(
      `Timed out waiting for Harness run ${runId} state ${expected}; `
        + `last=${lastState}`,
    );
  }

  async function waitForHarnessToolDispatch(
    runId: string,
    command: string,
  ): Promise<void> {
    const deadline = Date.now() + HARNESS_STATE_WAIT_MS;
    let lastState = "<missing>";
    while (Date.now() < deadline) {
      const [runResult, eventResult] = await Promise.all([
        harnessPool.query<{ state: string }>(
          "select state from runs where run_id = $1",
          [runId],
        ),
        harnessPool.query<{
          event_type: string;
          payload: Record<string, any>;
        }>(
          `select event_type, payload
           from domain_events
           where run_id = $1
             and event_type in ('CapabilityProposed', 'CapabilityDispatched')
           order by seq`,
          [runId],
        ),
      ]);
      lastState = runResult.rows[0]?.state ?? "<missing>";
      const proposed = eventResult.rows.find(
        (event) =>
          event.event_type === "CapabilityProposed"
          && event.payload?.capability_id === "shell.run"
          && event.payload?.arguments?.command === command,
      );
      const dispatched = proposed
        ? eventResult.rows.find(
            (event) =>
              event.event_type === "CapabilityDispatched"
              && event.payload?.capability_id === "shell.run"
              && event.payload?.args_hash === proposed.payload?.args_hash,
          )
        : undefined;
      if (dispatched) return;
      if (["cancelled", "failed", "learning_processed"].includes(lastState)) {
        throw new Error(
          `Harness run ${runId} reached ${lastState} before dispatching `
            + `the exact ${JSON.stringify(command)} shell command`,
        );
      }
      await delay(100);
    }
    throw new Error(
      `Timed out waiting for Harness run ${runId} to dispatch `
        + `${JSON.stringify(command)}; last=${lastState}`,
    );
  }

  async function writeLifecycleDiagnostics({
    workItemId,
    intendedRunId,
    expectedLifecycle,
    lastLifecycle,
    worker,
  }: {
    workItemId: string;
    intendedRunId: string;
    expectedLifecycle: string;
    lastLifecycle: string;
    worker: HarnessWorker;
  }): Promise<{
    path: string;
    harnessRun: { state: string; outcome: string | null } | undefined;
  }> {
    const [runResult, eventResult] = await Promise.all([
      harnessPool.query<{
        state: string;
        outcome: string | null;
        outcome_reason: string | null;
      }>(
        "select state, outcome, outcome_reason from runs where run_id = $1",
        [intendedRunId],
      ),
      harnessPool.query<{
        seq: number;
        event_type: string;
        payload: Record<string, any>;
      }>(
        `select seq, event_type, payload
         from domain_events
         where run_id = $1
           and event_type in (
             'EnvironmentPrepared',
             'ModelResponded',
             'CapabilityProposed',
             'PolicyDecisionMade',
             'CapabilityDispatched',
             'CapabilityCompleted',
             'VerificationCompleted',
             'RunCompleted'
           )
         order by seq desc
         limit 25`,
        [intendedRunId],
      ),
    ]);
    const target = path.join(
      evidenceRoot,
      "diagnostics",
      `${workItemId}.json`,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "int2_lifecycle_failure",
        workItemId,
        intendedRunId,
        expectedLifecycle,
        lastLifecycle,
        harnessRun: runResult.rows[0] ?? null,
        latestEvents: eventResult.rows.reverse(),
        workerOutputTail: worker.outputTail(),
        dispatcherLogTail: loggerRecords.slice(-50),
      }, null, 2)}\n`,
      "utf8",
    );
    return {
      path: target,
      harnessRun: runResult.rows[0],
    };
  }

  const suiteLogger: DispatcherLogger = {
    info(fields, message) {
      loggerRecords.push({ level: "info", fields, message });
    },
    warn(fields, message) {
      loggerRecords.push({ level: "warn", fields, message });
    },
  };
});

// Hand the pid to the suite script's cleanup trap, which is the only reaper
// that still runs when this process dies without reaching afterAll.
//
// Synchronous and appended the instant the child exists — before it is known
// healthy, and before anything can await. A worker that never reports ready
// still has to be reaped, and a crash one line later must still leave the trap
// something to act on. The file is the trap's whole picture of what to kill:
// what is not written here leaks.
function recordWorkerPid(pid: number | undefined): void {
  const pidfile = process.env.INT2_SUITE_WORKER_PIDFILE;
  if (pidfile === undefined || pid === undefined) return;
  appendFileSync(pidfile, `${pid}\n`, "utf8");
}

class HarnessWorker {
  private stopped = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly output: string[],
  ) {}

  outputTail(): string {
    return this.output.join("").slice(-8_000);
  }

  // Two SIGINTs then SIGTERM is the Harness worker's own documented shutdown
  // ladder. SIGKILL is the addition: without it this threw and left the
  // process running, which is one of the two ways a worker used to outlive the
  // suite. A process that survives SIGKILL is genuinely stuck rather than
  // merely slow, and the suite script's trap has no better move either, so
  // that alone is worth failing the run over.
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const signal of ["SIGINT", "SIGINT", "SIGTERM", "SIGKILL"] as const) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.kill(signal);
      if (await waitForExit(this.child, 2_000)) return;
    }
    throw new Error(
      `Harness worker survived SIGKILL (pid ${this.child.pid}): `
        + this.output.join("").slice(-4_000),
    );
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    delay(timeoutMs).then(() => false),
  ]);
}
