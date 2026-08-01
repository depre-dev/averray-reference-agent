#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

export const INT2_HARNESS_PIN =
  "0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2";
export const INT2_EXPECTED_PATH =
  "docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md";
export const INT2_SECTION3_CRITERION =
  "test -n \"$(git diff --numstat)\" && git diff --check";
export const INT2_PILOT_CAPABILITIES = Object.freeze([
  "fs.read_file",
  "fs.write_file",
  "fs.list_files",
  "shell.run",
  "git.status",
  "git.diff",
  "artifact.put",
  "artifact.get",
]);
export const INT2_CAPABILITY_BOUNDARY = Object.freeze({
  productionProfileCapabilities: "subset_of_dispatcher_vetted_capabilities",
  dispatcherVettedEqualsCliApproved: true,
  profileLoaderPrecedesAttenuation: true,
  productionInnerCapabilityChecksReachable: false,
  innerChecksCoveredAtTypedBoundary: Object.freeze([
    "capability_not_granted",
    "capability_effect_external",
  ]),
});

const DISPATCH_WORKSPACE_ROOT =
  "/var/lib/harness-dispatcher/workspaces";
const GREEN_TOOL_COMMAND =
  "printf '%b' '\\nINT-2 green-path proof line, cleanly formatted.\\n' >> docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md";
const NEGATIVE_TOOL_COMMAND =
  "printf '%b' '\\nINT-2 negative-path proof line with trailing whitespace.   \\n' >> docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md";
const SECTION3_CORRECT_TOOL_COMMAND =
  "printf '%b' '\\nA paid real-model ceremony requires a three-case acceptance pre-flight before credentials are exported.\\n' >> docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md";
const SECTION3_INCORRECT_TOOL_COMMAND =
  "printf '%b' '\\nA paid real-model ceremony requires a three-case acceptance pre-flight before credentials are exported.   \\n' >> docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md";
const HALT_TOOL_COMMAND = "sleep 30";
const CASE_EXPECTATIONS = Object.freeze({
  green: Object.freeze({
    lifecycle: "handoff_ready",
    runCount: 1,
    runOutcome: "completed",
    runState: "learning_processed",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 1,
      dispatch_refusal: 0,
    },
    criterion: {
      passed: true,
      reason: "exit_0",
      verdict: "completed",
    },
    requirePatch: true,
    requireManifest: true,
    requireFence: true,
    expectedToolCommand: GREEN_TOOL_COMMAND,
  }),
  negative: Object.freeze({
    lifecycle: "failed",
    runCount: 1,
    runOutcome: "failed",
    runState: "learning_processed",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 0,
      dispatch_refusal: 0,
    },
    criterion: {
      passed: false,
      reason: "exit_2",
      verdict: "failed",
    },
    requirePatch: true,
    requireManifest: true,
    requireFence: true,
    expectedToolCommand: NEGATIVE_TOOL_COMMAND,
  }),
  idle: Object.freeze({
    lifecycle: "failed",
    runCount: 1,
    runOutcome: "failed",
    runState: "learning_processed",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 0,
      dispatch_refusal: 0,
    },
    criterion: {
      passed: false,
      reason: "exit_1",
      verdict: "failed",
    },
    requirePatch: false,
    expectEmptyOrAbsentPatch: true,
    requireManifest: true,
    requireFence: true,
    expectedAcceptanceCommand: INT2_SECTION3_CRITERION,
    expectNoCapabilityEvents: true,
  }),
  restart: Object.freeze({
    lifecycle: "handoff_ready",
    runCount: 1,
    runOutcome: "completed",
    runState: "learning_processed",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 1,
      dispatch_refusal: 0,
    },
    criterion: {
      passed: true,
      reason: "exit_0",
      verdict: "completed",
    },
    requirePatch: true,
    requireManifest: true,
    requireFence: true,
    expectedToolCommand: GREEN_TOOL_COMMAND,
  }),
  halt: Object.freeze({
    lifecycle: "cancelled",
    runCount: 1,
    runState: "cancelled",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 0,
      dispatch_refusal: 0,
      escalation: 1,
    },
    requirePatch: false,
    requireManifest: false,
    requireFence: true,
    decisionReason: "halt_active_run_cancelled",
    expectedAuthorityReducingCancellation: true,
    expectedToolCommand: HALT_TOOL_COMMAND,
    expectedToolError: "command_timeout",
    minimumToolDurationSeconds: 29,
  }),
  "hash-mismatch": Object.freeze({
    lifecycle: "blocked",
    runCount: 0,
    claimCount: 0,
    outboxCount: 0,
    decisions: {
      dispatch_approval: 0,
      handoff: 0,
      dispatch_refusal: 1,
    },
    requirePatch: false,
    requireManifest: false,
    requireFence: false,
    decisionReason: "approval_hash_mismatch",
  }),
  "profile-unvetted": Object.freeze({
    lifecycle: "approved",
    runCount: 0,
    claimCount: 1,
    outboxCount: 0,
    decisions: {
      dispatch_approval: 0,
      handoff: 0,
      dispatch_refusal: 0,
    },
    requirePatch: false,
    requireManifest: false,
    requireFence: true,
    profileLoadErrorReason: "unvetted_capability",
  }),
  narrow: Object.freeze({
    lifecycle: "handoff_ready",
    runCount: 1,
    runOutcome: "completed",
    runState: "learning_processed",
    claimCount: 1,
    outboxCount: 1,
    decisions: {
      dispatch_approval: 1,
      handoff: 1,
      dispatch_refusal: 0,
    },
    criterion: {
      passed: true,
      reason: "exit_0",
      verdict: "completed",
    },
    requirePatch: true,
    requireManifest: true,
    requireFence: true,
    effectiveCapabilities: Object.freeze(
      INT2_PILOT_CAPABILITIES.filter(
        (capability) => capability !== "fs.write_file",
      ),
    ),
    expectedToolCommand: GREEN_TOOL_COMMAND,
  }),
  unapproved: Object.freeze({
    lifecycle: "proposed",
    runCount: 0,
    claimCount: 0,
    outboxCount: 0,
    decisions: {
      dispatch_approval: 0,
      handoff: 0,
      dispatch_refusal: 0,
    },
    requirePatch: false,
    requireManifest: false,
    requireFence: true,
  }),
});

export class Int2EvidenceError extends Error {
  constructor(failures) {
    super(`INT-2 evidence failed: ${failures.join("; ")}`);
    this.name = "Int2EvidenceError";
    this.failures = [...failures];
  }
}

export function expectationsForCase(caseName) {
  const value = CASE_EXPECTATIONS[caseName];
  if (!value) {
    throw new Error(`Unknown INT-2 evidence case: ${caseName}`);
  }
  return value;
}

export async function verifyScriptedPairPreflight({
  repositoryRoot,
  greenFixturePath = path.join(
    repositoryRoot,
    "test/fixtures/agent-integration/ceremony/lint-format-green.json",
  ),
  negativeFixturePath = path.join(
    repositoryRoot,
    "test/fixtures/agent-integration/ceremony/lint-format-red.json",
  ),
  greenScriptPath = path.join(
    repositoryRoot,
    "test/fixtures/agent-integration/ceremony/lint-format-green.jsonl",
  ),
  negativeScriptPath = path.join(
    repositoryRoot,
    "test/fixtures/agent-integration/ceremony/lint-format-red.jsonl",
  ),
} = {}) {
  if (!repositoryRoot) {
    throw new Error("repositoryRoot is required");
  }
  const [greenFixture, negativeFixture, greenTurns, negativeTurns] =
    await Promise.all([
      readJson(greenFixturePath),
      readJson(negativeFixturePath),
      readJsonLines(greenScriptPath),
      readJsonLines(negativeScriptPath),
    ]);

  const greenFence = fixtureFence(greenFixture);
  const negativeFence = fixtureFence(negativeFixture);
  assertEqual(
    greenFence,
    negativeFence,
    "controlled pair fence differs",
  );

  const greenAction = scriptedAppend(greenTurns);
  const negativeAction = scriptedAppend(negativeTurns);
  assertEqual(
    {
      ...greenAction,
      command: "<command>",
      appendedLine: "<content>",
    },
    {
      ...negativeAction,
      command: "<command>",
      appendedLine: "<content>",
    },
    "controlled pair differs outside appended content",
  );
  if (greenAction.appendedLine === negativeAction.appendedLine) {
    throw new Error("controlled pair appended content must differ");
  }
  if (/[ \t]+$/u.test(greenAction.appendedLine)) {
    throw new Error("green appended content contains trailing whitespace");
  }
  if (!/[ \t]+$/u.test(negativeAction.appendedLine)) {
    throw new Error("negative appended content lacks trailing whitespace");
  }

  const [green, negative] = await Promise.all([
    runFixtureCriterion({
      repositoryRoot,
      changeCommand: greenAction.command,
      expectedPath: greenAction.targetPath,
      baseRevision: greenFence.repository.baseRevision,
    }),
    runFixtureCriterion({
      repositoryRoot,
      changeCommand: negativeAction.command,
      expectedPath: negativeAction.targetPath,
      baseRevision: negativeFence.repository.baseRevision,
    }),
  ]);
  if (green.numstat.length === 0 || negative.numstat.length === 0) {
    throw new Error("controlled pair produced an empty git diff");
  }
  if (green.exitCode === 128 || negative.exitCode === 128) {
    throw new Error("controlled pair criterion produced exit_128");
  }
  if (green.exitCode !== 0) {
    throw new Error(
      `green criterion rejected a clean tracked-file diff with exit ${green.exitCode}`,
    );
  }
  if (negative.exitCode === 0) {
    throw new Error("negative criterion accepted trailing whitespace");
  }
  if (!/whitespace/iu.test(`${negative.stdout}\n${negative.stderr}`)) {
    throw new Error("negative criterion did not identify whitespace");
  }

  return {
    fence: greenFence,
    targetPath: greenAction.targetPath,
    green: {
      appendedLine: greenAction.appendedLine,
      numstat: green.numstat,
      exitCode: green.exitCode,
    },
    negative: {
      appendedLine: negativeAction.appendedLine,
      numstat: negative.numstat,
      exitCode: negative.exitCode,
    },
  };
}

export async function verifySection3Preflight({
  repositoryRoot,
  fixturePath = path.join(
    repositoryRoot,
    "test/fixtures/agent-integration/ceremony/lint-format.json",
  ),
} = {}) {
  if (!repositoryRoot) {
    throw new Error("repositoryRoot is required");
  }
  const fixture = await readJson(fixturePath);
  const criterion = fixture?.acceptanceCriteria?.[0]?.command;
  assertEqual(
    fixture?.acceptanceCriteria,
    [{
      id: "format-command",
      type: "command",
      command: INT2_SECTION3_CRITERION,
      required: true,
    }],
    "section 3 fixture does not use the discriminating criterion",
  );
  if (
    fixture?.taskKind !== "lint_format"
    || typeof fixture?.objective !== "string"
    || !fixture.objective.startsWith("Append ")
    || !fixture.objective.includes(INT2_EXPECTED_PATH)
  ) {
    throw new Error(
      "section 3 fixture objective is not a tracked-file construction",
    );
  }
  assertEqual(
    fixture?.budget,
    {
      elapsedSeconds: 60,
      modelTokens: 8000,
      toolCalls: 30,
      estimatedUsdMicros: null,
    },
    "section 3 fixture budget changed",
  );

  const baseRevision = fixture?.repository?.baseRevision;
  if (
    typeof baseRevision !== "string"
    || !/^[0-9a-f]{40}$/u.test(baseRevision)
  ) {
    throw new Error("section 3 fixture baseRevision is not a full commit SHA");
  }

  const [correct, incorrect, noChange] = await Promise.all([
    runFixtureCriterion({
      repositoryRoot,
      changeCommand: SECTION3_CORRECT_TOOL_COMMAND,
      criterionCommand: criterion,
      expectedPath: INT2_EXPECTED_PATH,
      baseRevision,
    }),
    runFixtureCriterion({
      repositoryRoot,
      changeCommand: SECTION3_INCORRECT_TOOL_COMMAND,
      criterionCommand: criterion,
      expectedPath: INT2_EXPECTED_PATH,
      baseRevision,
    }),
    runFixtureCriterion({
      repositoryRoot,
      criterionCommand: criterion,
      expectedPath: INT2_EXPECTED_PATH,
      baseRevision,
    }),
  ]);

  const cases = [correct, incorrect, noChange];
  if (cases.some((result) => result.baseRevision !== baseRevision)) {
    throw new Error("section 3 pre-flight did not run at the fixture revision");
  }
  if (cases.some((result) => result.exitCode === 128)) {
    throw new Error("section 3 criterion produced exit_128");
  }
  if (cases.some((result) => result.exitCode === 129)) {
    throw new Error("section 3 criterion produced exit_129");
  }
  if (correct.numstat.length === 0 || correct.exitCode !== 0) {
    throw new Error(
      `section 3 correct change was not accepted with exit_0; got exit_${correct.exitCode}`,
    );
  }
  if (incorrect.numstat.length === 0 || incorrect.exitCode !== 2) {
    throw new Error(
      `section 3 incorrect change was not refused with exit_2; got exit_${incorrect.exitCode}`,
    );
  }
  const incorrectDetails = `${incorrect.stdout}\n${incorrect.stderr}`.trim();
  if (!/trailing whitespace/iu.test(incorrectDetails)) {
    throw new Error(
      "section 3 incorrect change did not name trailing whitespace",
    );
  }
  if (noChange.numstat.length !== 0 || noChange.exitCode !== 1) {
    throw new Error(
      `section 3 empty diff was not refused with exit_1; got exit_${noChange.exitCode}`,
    );
  }

  return {
    fixture: "lint-format",
    baseRevision,
    targetPath: INT2_EXPECTED_PATH,
    criterion,
    correct: {
      numstat: correct.numstat,
      exitCode: correct.exitCode,
      reason: "clean_non_empty_diff",
    },
    incorrect: {
      numstat: incorrect.numstat,
      exitCode: incorrect.exitCode,
      reason: "trailing_whitespace",
      details: incorrectDetails,
    },
    noChange: {
      numstat: noChange.numstat,
      exitCode: noChange.exitCode,
      reason: "empty_diff",
    },
    exit128Present: false,
    exit129Present: false,
  };
}

export async function collectInt2Evidence({
  workItemId,
  intendedRunId,
  referenceDatabaseUrl = process.env.DATABASE_URL,
  harnessDatabaseUrl = process.env.HARNESS_DATABASE_URL,
  harnessBin = process.env.HARNESS_BIN || "harness",
  expectedPath = INT2_EXPECTED_PATH,
  evidenceDir,
  profileLoadError,
} = {}) {
  requireValue(workItemId, "workItemId");
  requireValue(intendedRunId, "intendedRunId");
  requireValue(referenceDatabaseUrl, "referenceDatabaseUrl");
  requireValue(harnessDatabaseUrl, "harnessDatabaseUrl");

  const referencePool = new Pool({ connectionString: referenceDatabaseUrl });
  const harnessPool = new Pool({ connectionString: harnessDatabaseUrl });
  let raw;
  try {
    const [
      taskRows,
      claimRows,
      outboxRows,
      decisionRows,
      runRows,
    ] = await Promise.all([
      referencePool.query(
        `select task
         from agent_tasks
         where work_item_id = $1
         order by task_version desc`,
        [workItemId],
      ),
      referencePool.query(
        `select *
         from agent_task_dispatch_claims
         where work_item_id = $1
         order by claimed_at`,
        [workItemId],
      ),
      referencePool.query(
        `select *
         from agent_task_run_outbox
         where work_item_id = $1
         order by bound_at`,
        [workItemId],
      ),
      referencePool.query(
        `select record
         from hermes_decision_records
         where work_item_id = $1
         order by generated_at`,
        [workItemId],
      ),
      harnessPool.query(
        `select run_id, state, outcome, outcome_reason, attempt, task, manifest
         from runs
         where task->'metadata'->'labels'->>'averray_work_item_id' = $1
         order by created_at, run_id`,
        [workItemId],
      ),
    ]);
    raw = {
      task: taskRows.rows[0]?.task ?? null,
      dispatchClaims: claimRows.rows,
      outbox: outboxRows.rows,
      decisions: decisionRows.rows.map((row) => row.record),
      runs: runRows.rows.map(normalizeRunRow),
    };
  } finally {
    await Promise.allSettled([
      referencePool.end(),
      harnessPool.end(),
    ]);
  }

  let statusText = "";
  let eventsText = "";
  let deliverablesText = "";
  if (raw.runs.some((run) => run.runId === intendedRunId)) {
    [statusText, eventsText, deliverablesText] = await Promise.all([
      harnessRead(harnessBin, ["run", "status", intendedRunId], {
        HARNESS_DATABASE_URL: harnessDatabaseUrl,
      }),
      harnessRead(harnessBin, ["run", "events", intendedRunId], {
        HARNESS_DATABASE_URL: harnessDatabaseUrl,
      }),
      harnessRead(harnessBin, ["run", "deliverables", intendedRunId], {
        HARNESS_DATABASE_URL: harnessDatabaseUrl,
      }),
    ]);
  }

  const events = parseHarnessEvents(eventsText);
  const deliverables = parseHarnessDeliverables(deliverablesText);
  const run = raw.runs.find((item) => item.runId === intendedRunId);
  const patchRef = deliverables.workspace_patch;
  const patch = patchRef && run
    ? await inspectWorkspacePatch({
        harnessBin,
        harnessDatabaseUrl,
        patchRef,
        workspacePath: run.workspacePath,
        baseRevision: raw.task?.repository?.baseRevision,
        expectedPath,
      })
    : null;
  const verification = verificationFromEvents(events);
  const evidence = {
    schemaVersion: 1,
    kind: "int2_automated_evidence",
    workItemId,
    intendedRunId,
    expectedPath,
    capabilityBoundary: INT2_CAPABILITY_BOUNDARY,
    profileLoadError: profileLoadError ?? null,
    task: raw.task,
    dispatchClaims: raw.dispatchClaims,
    outbox: raw.outbox,
    decisions: raw.decisions,
    runs: raw.runs,
    status: parseKeyValueLines(statusText),
    events,
    deliverables,
    verification,
    patch,
    exit128Present: /(?:exit_128|exit 128|exit_code["']?\s*:\s*128)/iu
      .test(eventsText),
    pullRequestReferences: findPullRequestReferences({
      task: raw.task,
      decisions: raw.decisions,
      outbox: raw.outbox,
    }),
  };

  if (evidenceDir) {
    await writeEvidenceBundle(evidenceDir, {
      evidence,
      statusText,
      eventsText,
      deliverablesText,
    });
  }
  return evidence;
}

export function verifyInt2Evidence(
  evidence,
  expectationsInput,
) {
  const expectations = typeof expectationsInput === "string"
    ? expectationsForCase(expectationsInput)
    : expectationsInput;
  const failures = [];
  const passed = [];
  const check = (condition, code, detail) => {
    if (condition) passed.push(code);
    else failures.push(`${code}: ${detail}`);
  };

  check(
    evidence?.task?.workItemId === evidence?.workItemId,
    "task_identity",
    "stored AgentTask does not match the evidence work item",
  );
  check(
    evidence?.task?.bindings?.pullRequest === undefined,
    "task_has_no_pull_request",
    "AgentTask contains a pullRequest binding",
  );
  check(
    evidence?.pullRequestReferences?.length === 0,
    "no_pull_request_reference",
    `found ${evidence?.pullRequestReferences?.length ?? "unknown"} PR references`,
  );
  check(
    equal(evidence?.capabilityBoundary, INT2_CAPABILITY_BOUNDARY),
    "capability_boundary_recorded",
    "the evidence does not record the production-loader/typed-boundary split",
  );
  check(
    evidence?.task?.lifecycle === expectations.lifecycle,
    "terminal_lifecycle",
    `expected ${expectations.lifecycle}, got ${evidence?.task?.lifecycle}`,
  );

  const runs = Array.isArray(evidence?.runs) ? evidence.runs : [];
  check(
    runs.length === expectations.runCount,
    "one_harness_run",
    `expected ${expectations.runCount}, got ${runs.length}`,
  );
  if (expectations.runCount === 1) {
    const run = runs[0];
    check(
      run?.runId === evidence.intendedRunId,
      "run_id_bound_to_intended",
      `expected ${evidence.intendedRunId}, got ${run?.runId}`,
    );
    check(
      run?.attempt === 1,
      "attempt_one",
      `expected attempt 1, got ${run?.attempt}`,
    );
    if (expectations.runOutcome) {
      check(
        run?.outcome === expectations.runOutcome,
        "run_outcome",
        `expected ${expectations.runOutcome}, got ${run?.outcome}`,
      );
    }
    if (expectations.runState) {
      check(
        run?.state === expectations.runState,
        "run_terminal_state",
        `expected ${expectations.runState}, got ${run?.state}`,
      );
    }
    if (expectations.effectiveCapabilities) {
      check(
        equal(
          run?.manifest?.grants?.map((grant) => grant.capability),
          expectations.effectiveCapabilities,
        ),
        "effective_authority_narrowed",
        `effective capabilities=${JSON.stringify(
          run?.manifest?.grants?.map((grant) => grant.capability),
        )}`,
      );
      check(
        !run?.manifest?.grants?.some(
          (grant) => grant.capability === "fs.write_file",
        ),
        "removed_capability_absent",
        "fs.write_file remained in the effective run manifest",
      );
    }
  }

  const claims = Array.isArray(evidence?.dispatchClaims)
    ? evidence.dispatchClaims
    : [];
  check(
    claims.length === expectations.claimCount,
    "dispatch_claim_count",
    `expected ${expectations.claimCount}, got ${claims.length}`,
  );
  const outbox = Array.isArray(evidence?.outbox) ? evidence.outbox : [];
  check(
    outbox.length === expectations.outboxCount,
    "outbox_count",
    `expected ${expectations.outboxCount}, got ${outbox.length}`,
  );
  if (expectations.outboxCount === 1) {
    check(
      outbox[0]?.harness_run_id === evidence.intendedRunId,
      "outbox_run_binding",
      `outbox is bound to ${outbox[0]?.harness_run_id}`,
    );
  }

  const decisions = Array.isArray(evidence?.decisions)
    ? evidence.decisions
    : [];
  const decisionCounts = countDecisions(decisions);
  const expectedDecisionTotal = Object.values(
    expectations.decisions ?? {},
  ).reduce((total, count) => total + count, 0);
  check(
    decisions.length === expectedDecisionTotal,
    "decision_total_count",
    `expected ${expectedDecisionTotal}, got ${decisions.length}`,
  );
  for (const [decisionType, expectedCount] of Object.entries(
    expectations.decisions ?? {},
  )) {
    check(
      (decisionCounts[decisionType] ?? 0) === expectedCount,
      `decision_${decisionType}_count`,
      `expected ${expectedCount}, got ${decisionCounts[decisionType] ?? 0}`,
    );
  }
  check(
    decisions.every((decision) => {
      if (
        expectations.expectedAuthorityReducingCancellation
        && decision?.decisionType === "escalation"
      ) {
        return decision?.effects?.mutates === true
          && equal(
            decision.effects.mutations?.map((mutation) => ({
              system: mutation.system,
              action: mutation.action,
            })),
            [
              { system: "agent-task", action: "cancelled" },
              { system: "agent-harness", action: "cancel" },
            ],
          );
      }
      return decision?.effects?.mutates === false
        && Array.isArray(decision?.effects?.mutations)
        && decision.effects.mutations.length === 0;
    }),
    "decision_records_non_mutating",
    "a decision mutates outside the exact authority-reducing HALT cancellation",
  );
  if (expectations.decisionReason) {
    check(
      decisions.some((decision) =>
        Array.isArray(decision?.proposal?.why)
        && decision.proposal.why.includes(expectations.decisionReason)),
      "decision_reason",
      `missing ${expectations.decisionReason}`,
    );
  }
  if (expectations.profileLoadErrorReason) {
    check(
      evidence?.profileLoadError?.name === "ProfileManifestError"
      && evidence.profileLoadError.reason
        === expectations.profileLoadErrorReason,
      "outer_profile_loader_refusal",
      `expected ProfileManifestError/${expectations.profileLoadErrorReason}, `
        + `got ${JSON.stringify(evidence?.profileLoadError)}`,
    );
    check(
      decisionCounts.dispatch_refusal === undefined,
      "no_attenuation_refusal_claim",
      "outer loader failure was incorrectly recorded as an attenuation refusal",
    );
  }

  if (expectations.requireFence) {
    verifyFence(
      evidence.task,
      check,
      expectations.expectedAcceptanceCommand,
    );
  }
  if (expectations.requireManifest) {
    const binding = outbox[0];
    const refHash = binding?.run_manifest_ref?.sha256;
    const manifestHash = binding?.run_manifest_hash;
    check(
      typeof refHash === "string" && typeof manifestHash === "string",
      "manifest_identity_present",
      "runManifestRef or runManifestHash is missing",
    );
    check(
      refHash === manifestHash,
      "manifest_identity_consistent",
      `${refHash} does not equal ${manifestHash}`,
    );
  }

  if (expectations.requirePatch) {
    const patch = evidence?.patch;
    check(
      typeof patch?.sha256 === "string" && patch?.byteLength > 0,
      "patch_non_empty",
      "workspace patch is empty or missing",
    );
    check(
      patch?.appliesAtBase === true,
      "patch_applies_at_base",
      "workspace patch does not apply at the approved base",
    );
    check(
      patch?.baseRevision === evidence?.task?.repository?.baseRevision,
      "patch_base_revision",
      "patch checkout HEAD does not equal AgentTask baseRevision",
    );
    check(
      patch?.trackedTarget === true,
      "criterion_target_tracked",
      "expected path is not tracked at the prepared base",
    );
    check(
      Array.isArray(patch?.touchedPaths)
      && patch.touchedPaths.length === 1
      && patch.touchedPaths[0] === evidence.expectedPath,
      "patch_exact_path",
      `touched ${JSON.stringify(patch?.touchedPaths)}`,
    );
    check(
      typeof patch?.numstat === "string" && patch.numstat.trim().length > 0,
      "criterion_inspected_non_empty_diff",
      "git diff --numstat was empty",
    );
    check(
      patch?.criterionExitCode !== 128,
      "criterion_not_exit_128",
      "reconstructed criterion returned exit 128",
    );
  }
  if (expectations.expectEmptyOrAbsentPatch) {
    const patch = evidence?.patch;
    const patchAbsent = patch === null
      && evidence?.deliverables?.workspace_patch === undefined;
    const patchEmpty = patch?.byteLength === 0
      && (patch?.numstat ?? "").trim().length === 0
      && Array.isArray(patch?.touchedPaths)
      && patch.touchedPaths.length === 0;
    check(
      patchAbsent || patchEmpty,
      "workspace_patch_empty_or_absent",
      `workspace patch=${JSON.stringify(patch)}`,
    );
  }

  if (expectations.criterion) {
    const verification = evidence?.verification;
    const format = verification?.details?.find(
      (detail) => detail?.id === "format-command" && detail?.required === true,
    );
    check(
      verification?.verdict === expectations.criterion.verdict,
      "verification_verdict",
      `expected ${expectations.criterion.verdict}, got ${verification?.verdict}`,
    );
    check(
      format?.passed === expectations.criterion.passed,
      "required_criterion_result",
      `expected passed=${expectations.criterion.passed}, got ${format?.passed}`,
    );
    check(
      format?.reason === expectations.criterion.reason,
      "required_criterion_reason",
      `expected ${expectations.criterion.reason}, got ${format?.reason}`,
    );
    check(
      evidence?.exit128Present === false,
      "events_have_no_exit_128",
      "exit_128 appears in Harness events",
    );
    if (expectations.criterion.passed) {
      check(
        evidence?.patch?.criterionExitCode === 0,
        "criterion_reconstruction_green",
        `reconstructed exit ${evidence?.patch?.criterionExitCode}`,
      );
      check(
        Array.isArray(verification?.requiredFailed)
        && verification.requiredFailed.length === 0,
        "required_failed_empty",
        `required_failed=${JSON.stringify(verification?.requiredFailed)}`,
      );
    } else {
      if (!expectations.expectEmptyOrAbsentPatch) {
        check(
          evidence?.patch?.criterionExitCode !== 0
          && evidence?.patch?.criterionExitCode !== 128,
          "criterion_reconstruction_red",
          `reconstructed exit ${evidence?.patch?.criterionExitCode}`,
        );
        check(
          /whitespace/iu.test(
            `${evidence?.patch?.criterionStdout ?? ""}\n`
            + `${evidence?.patch?.criterionStderr ?? ""}`,
          ),
          "criterion_rejected_whitespace",
          "reconstructed rejection did not name whitespace",
        );
      }
      check(
        Array.isArray(verification?.requiredFailed)
        && verification.requiredFailed.includes("format-command"),
        "required_failed_names_format",
        `required_failed=${JSON.stringify(verification?.requiredFailed)}`,
      );
    }
  }

  if (expectations.expectNoCapabilityEvents) {
    const capabilityEvents = (evidence?.events ?? []).filter(
      (event) => /^Capability/u.test(event?.type ?? ""),
    );
    check(
      capabilityEvents.length === 0,
      "idle_model_no_tool_calls",
      `found ${capabilityEvents.length} capability events`,
    );
  }

  if (expectations.expectedToolCommand) {
    const proposed = evidence?.events?.find(
      (event) =>
        event?.type === "CapabilityProposed"
        && event?.payload?.capability_id === "shell.run"
        && event?.payload?.arguments?.command
          === expectations.expectedToolCommand,
    );
    const dispatched = proposed
      ? evidence?.events?.find(
          (event) =>
            event?.type === "CapabilityDispatched"
            && event?.payload?.capability_id === "shell.run"
            && event?.payload?.args_hash === proposed.payload?.args_hash,
        )
      : undefined;
    const completed = dispatched
      ? evidence?.events?.find(
          (event) =>
            event?.type === "CapabilityCompleted"
            && event?.payload?.capability_id === "shell.run"
            && event?.payload?.invocation_id
              === dispatched.payload?.invocation_id,
        )
      : undefined;
    check(
      proposed !== undefined,
      "scripted_tool_proposed",
      `the exact ${JSON.stringify(expectations.expectedToolCommand)} command was not proposed`,
    );
    check(
      dispatched !== undefined,
      "scripted_tool_dispatched",
      "the exact scripted shell command was not dispatched",
    );
    check(
      completed !== undefined,
      "scripted_tool_completed",
      "the exact scripted shell command has no completion evidence",
    );
    if (expectations.minimumToolDurationSeconds !== undefined) {
      check(
        completed?.payload?.outcome?.duration_seconds
          >= expectations.minimumToolDurationSeconds,
        "scripted_tool_duration",
        `expected at least ${expectations.minimumToolDurationSeconds}s, got ${
          completed?.payload?.outcome?.duration_seconds ?? "missing"
        }`,
      );
      check(
        completed?.payload?.outcome?.error?.code
          === expectations.expectedToolError,
        "scripted_tool_terminal_error",
        `expected ${expectations.expectedToolError}, got ${
          completed?.payload?.outcome?.error?.code ?? "missing"
        }`,
      );
    } else {
      check(
        completed?.payload?.outcome?.ok === true,
        "scripted_tool_succeeded",
        "the exact scripted shell command did not complete successfully",
      );
      check(
        completed?.payload?.outcome?.output_inline?.exit_code === 0
          && completed?.payload?.action?.exit_code === 0,
        "scripted_tool_exit_zero",
        `expected the exact scripted shell command to exit 0, got ${
          completed?.payload?.outcome?.output_inline?.exit_code ?? "missing"
        }`,
      );
    }
  }

  const handoffs = decisions.filter(
    (decision) => decision?.decisionType === "handoff",
  );
  if ((expectations.decisions?.handoff ?? 0) === 1) {
    const handoff = handoffs[0];
    check(
      Array.isArray(handoff?.proposal?.evidenceRefs)
      && handoff.proposal.evidenceRefs.length > 0,
      "handoff_evidence_refs",
      "handoff evidenceRefs are empty",
    );
    check(
      handoff?.proposal?.why?.includes("eligible_for_pr_open=true")
      && handoff?.proposal?.why?.includes(
        "eligible_for_pr_open_reason=completed_outcome_verified_acceptance_all_checks_passed",
      ),
      "handoff_eligibility_evidence",
      "handoff lacks the eligibility value or reason",
    );
  }

  if (failures.length > 0) {
    throw new Int2EvidenceError(failures);
  }
  return {
    workItemId: evidence.workItemId,
    intendedRunId: evidence.intendedRunId,
    invariants: passed,
  };
}

async function inspectWorkspacePatch({
  harnessBin,
  harnessDatabaseUrl,
  patchRef,
  workspacePath,
  baseRevision,
  expectedPath,
}) {
  if (
    typeof workspacePath !== "string"
    || !workspacePath.startsWith(`${DISPATCH_WORKSPACE_ROOT}/`)
  ) {
    throw new Error("Harness run workspace escaped the dispatch root");
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "int2-patch-"));
  const patchPath = path.join(temporary, "workspace.patch");
  const checkout = path.join(temporary, "checkout");
  try {
    await harnessRead(
      harnessBin,
      ["artifacts", "get", patchRef, "--out", patchPath],
      { HARNESS_DATABASE_URL: harnessDatabaseUrl },
    );
    const patchBytes = await readFile(patchPath);
    await command("git", [
      "clone",
      "--quiet",
      "--local",
      "--no-hardlinks",
      workspacePath,
      checkout,
    ]);
    const head = (await command("git", [
      "-C",
      checkout,
      "rev-parse",
      "HEAD",
    ])).stdout.trim();
    const tracked = await command("git", [
      "-C",
      checkout,
      "ls-files",
      "--error-unmatch",
      expectedPath,
    ], { allowFailure: true });
    const applyCheck = await command("git", [
      "-C",
      checkout,
      "apply",
      "--check",
      patchPath,
    ], { allowFailure: true });
    const patchNumstat = await command("git", [
      "-C",
      checkout,
      "apply",
      "--numstat",
      patchPath,
    ], { allowFailure: true });
    if (applyCheck.code === 0) {
      await command("git", [
        "-C",
        checkout,
        "apply",
        patchPath,
      ]);
    }
    const numstat = applyCheck.code === 0
      ? (await command("git", [
          "-C",
          checkout,
          "diff",
          "--numstat",
        ])).stdout.trim()
      : "";
    const criterion = applyCheck.code === 0
      ? await command("git", [
          "-C",
          checkout,
          "diff",
          "--check",
        ], { allowFailure: true })
      : { code: -1, stdout: "", stderr: "patch did not apply" };
    return {
      ref: patchRef,
      sha256:
        `sha256:${createHash("sha256").update(patchBytes).digest("hex")}`,
      byteLength: patchBytes.byteLength,
      baseRevision: head,
      expectedBaseRevision: baseRevision,
      appliesAtBase: applyCheck.code === 0 && head === baseRevision,
      trackedTarget: tracked.code === 0,
      touchedPaths: numstatPaths(patchNumstat.stdout),
      numstat,
      criterionExitCode: criterion.code,
      criterionStdout: criterion.stdout,
      criterionStderr: criterion.stderr,
      bytes: patchBytes.toString("utf8"),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runFixtureCriterion({
  repositoryRoot,
  changeCommand,
  criterionCommand = "git diff --check",
  expectedPath,
  baseRevision,
}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "int2-preflight-"));
  const checkout = path.join(temporary, "checkout");
  try {
    await command("git", [
      "clone",
      "--quiet",
      "--local",
      "--no-hardlinks",
      repositoryRoot,
      checkout,
    ]);
    await command("git", [
      "-C",
      checkout,
      "checkout",
      "--quiet",
      "--detach",
      baseRevision,
    ]);
    const tracked = await command("git", [
      "-C",
      checkout,
      "ls-files",
      "--error-unmatch",
      expectedPath,
    ], { allowFailure: true });
    if (tracked.code !== 0) {
      throw new Error(
        `append target is not tracked in the checkout: ${expectedPath}`,
      );
    }
    const head = (await command("git", [
      "-C",
      checkout,
      "rev-parse",
      "HEAD",
    ])).stdout.trim();
    if (changeCommand) {
      await command("sh", ["-c", changeCommand], { cwd: checkout });
    }
    const numstat = (await command("git", [
      "-C",
      checkout,
      "diff",
      "--numstat",
    ])).stdout.trim();
    const criterion = await command(
      "sh",
      ["-c", criterionCommand],
      { cwd: checkout, allowFailure: true },
    );
    return {
      baseRevision: head,
      numstat,
      exitCode: criterion.code,
      stdout: criterion.stdout,
      stderr: criterion.stderr,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function verifyFence(
  task,
  check,
  expectedAcceptanceCommand = "git diff --check",
) {
  check(
    task?.repository?.nameWithOwner ===
      "depre-dev/averray-reference-agent",
    "fence_repository",
    `unexpected repository ${task?.repository?.nameWithOwner}`,
  );
  check(
    equal(task?.repository?.allowedPaths, ["docs/**", "test/**"]),
    "fence_allowed_paths",
    `unexpected allowed paths ${JSON.stringify(task?.repository?.allowedPaths)}`,
  );
  check(
    task?.intent?.profile === "coding-change-pilot",
    "fence_profile",
    `unexpected profile ${task?.intent?.profile}`,
  );
  check(
    task?.requestedAuthority?.network === "deny"
    && task?.requestedAuthority?.delegable === false
    && task?.requestedAuthority?.maxChildren === 0
    && task?.requestedAuthority?.maxConcurrentChildren === 0,
    "fence_non_delegating_deny_network",
    "authority is not deny/non-delegating/zero-child",
  );
  const grants = task?.requestedAuthority?.grants;
  check(
    Array.isArray(grants)
    && grants.length === INT2_PILOT_CAPABILITIES.length
    && equal(
      grants.map((grant) => grant.capabilityId),
      INT2_PILOT_CAPABILITIES,
    )
    && grants.every((grant) =>
      equal(grant.constraints, {})
      && grant.resource === "depre-dev/averray-reference-agent"),
    "fence_eight_grants",
    `unexpected grants ${JSON.stringify(grants)}`,
  );
  check(
    equal(task?.acceptance?.criteria, [{
      id: "format-command",
      type: "command",
      command: expectedAcceptanceCommand,
      required: true,
    }]),
    "fence_acceptance",
    `unexpected acceptance ${JSON.stringify(task?.acceptance?.criteria)}`,
  );
  check(
    equal(task?.budget, {
      elapsedSeconds: 60,
      modelTokens: 8000,
      toolCalls: 30,
      estimatedUsdMicros: null,
    }),
    "fence_budget",
    `unexpected budget ${JSON.stringify(task?.budget)}`,
  );
}

function fixtureFence(fixture) {
  return {
    repository: fixture.repository,
    profile: fixture.profile,
    acceptanceCriteria: fixture.acceptanceCriteria,
    budget: fixture.budget,
    deadline: fixture.deadline,
    riskTier: fixture.riskTier,
  };
}

function scriptedAppend(turns) {
  if (!Array.isArray(turns) || turns.length !== 2) {
    throw new Error("scripted pair must contain exactly two turns");
  }
  const first = turns[0];
  const second = turns[1];
  const calls = first?.tool_calls;
  if (
    !Array.isArray(calls)
    || calls.length !== 1
    || calls[0]?.name !== "shell_run"
    || first?.finish_reason !== "tool_call"
    || second?.finish_reason !== "stop"
  ) {
    throw new Error("scripted pair has an unexpected turn shape");
  }
  const commandText = calls[0]?.arguments?.command;
  if (typeof commandText !== "string") {
    throw new Error("scripted pair shell command is missing");
  }
  const match =
    /^printf '%b' '\\n(.*)\\n' >> ([A-Za-z0-9_./-]+)$/u.exec(commandText);
  if (!match) {
    throw new Error("scripted pair must append exactly one newline-bounded line");
  }
  return {
    command: commandText,
    targetPath: match[2],
    appendedLine: match[1],
    firstUsage: first.usage,
    firstFinishReason: first.finish_reason,
    secondUsage: second.usage,
    secondFinishReason: second.finish_reason,
  };
}

function verificationFromEvents(events) {
  const event = [...events].reverse().find(
    (item) => item.type === "VerificationCompleted",
  );
  if (!event) return null;
  return {
    verdict: event.payload?.verdict,
    passed: event.payload?.passed,
    details: event.payload?.details,
    requiredFailed: event.payload?.required_failed,
    optionalFailed: event.payload?.optional_failed,
  };
}

function parseHarnessEvents(text) {
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^(\d+)(?::(\d+))?\s+([A-Za-z0-9_]+)\s+payload=(.*)$/u
      .exec(line);
    if (!match) {
      return { raw: line, type: "Unparsed", payload: null };
    }
    let payload = null;
    try {
      payload = JSON.parse(match[4]);
    } catch {
      payload = null;
    }
    return {
      sequence: Number(match[1]),
      ...(match[2] ? { attempt: Number(match[2]) } : {}),
      type: match[3],
      payload,
      raw: line,
    };
  });
}

function parseHarnessDeliverables(text) {
  return Object.fromEntries(
    text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      const match = /^([a-z_]+)\s+(artifact:\/\/sha256\/[a-f0-9]{64})$/u
        .exec(line.trim());
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}

function parseKeyValueLines(text) {
  return Object.fromEntries(
    text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0
        ? [[line.slice(0, index), line.slice(index + 1)]]
        : [];
    }),
  );
}

function normalizeRunRow(row) {
  return {
    runId: row.run_id,
    state: row.state,
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    attempt: Number(row.attempt),
    task: row.task,
    manifest: row.manifest,
    workspacePath: row.task?.spec?.context?.workspace?.path,
  };
}

function countDecisions(decisions) {
  const counts = {};
  for (const decision of decisions) {
    const key = decision?.decisionType;
    if (typeof key === "string") counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function findPullRequestReferences(value) {
  const references = [];
  const visit = (candidate, location) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate)) {
        if (/^(?:pullRequest|pull_request)$/u.test(key)) {
          references.push(`${location}.${key}`);
        }
        visit(item, `${location}.${key}`);
      }
      return;
    }
    if (
      typeof candidate === "string"
      && /github\.com\/[^\s]+\/pull\/\d+/iu.test(candidate)
    ) {
      references.push(location);
    }
  };
  visit(value, "$");
  return references;
}

function numstatPaths(text) {
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    return fields.at(-1);
  }).filter((value) => typeof value === "string");
}

async function writeEvidenceBundle(directory, {
  evidence,
  statusText,
  eventsText,
  deliverablesText,
}) {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    ),
    writeFile(path.join(directory, "harness-status.txt"), statusText, "utf8"),
    writeFile(path.join(directory, "harness-events.txt"), eventsText, "utf8"),
    writeFile(
      path.join(directory, "harness-deliverables.txt"),
      deliverablesText,
      "utf8",
    ),
  ]);
  if (evidence.patch?.bytes) {
    await writeFile(
      path.join(directory, "workspace.patch"),
      evidence.patch.bytes,
      "utf8",
    );
  }
}

async function harnessRead(harnessBin, args, environment) {
  return (await command(harnessBin, args, {
    env: { ...process.env, ...environment },
  })).stdout;
}

async function command(executable, args, {
  cwd,
  env,
  allowFailure = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(
          `${path.basename(executable)} failed with exit ${result.code}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function readJsonLines(target) {
  return (await readFile(target, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function requireValue(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

function assertEqual(actual, expected, message) {
  if (!equal(actual, expected)) {
    throw new Error(message);
  }
}

function equal(left, right) {
  return JSON.stringify(canonicalValue(left))
    === JSON.stringify(canonicalValue(right));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalValue(value[key]),
      ]),
    );
  }
  return value;
}

function parseCliArgs(argv) {
  const commandName = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("INT-2 evidence CLI expects --name value arguments");
    }
    values[key.slice(2)] = value;
  }
  return { commandName, values };
}

async function runCli(argv) {
  const { commandName, values } = parseCliArgs(argv);
  if (commandName === "preflight-pair") {
    const result = await verifyScriptedPairPreflight({
      repositoryRoot: values["repository-root"] ?? process.cwd(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (commandName === "preflight-section3") {
    const result = await verifySection3Preflight({
      repositoryRoot: values["repository-root"] ?? process.cwd(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (commandName === "verify") {
    const caseName = values.case;
    const evidence = await collectInt2Evidence({
      workItemId: values["work-item"],
      intendedRunId: values["run-id"],
      expectedPath: values["expected-path"] ?? INT2_EXPECTED_PATH,
      evidenceDir: values["evidence-dir"],
    });
    const result = verifyInt2Evidence(evidence, caseName);
    if (values["evidence-dir"]) {
      await writeFile(
        path.join(values["evidence-dir"], "evidence-index.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(
    "Usage: int2-evidence.mjs preflight-pair --repository-root <path>\n"
    + "   or: int2-evidence.mjs preflight-section3 "
    + "--repository-root <path>\n"
    + "   or: int2-evidence.mjs verify --case <name> --work-item <id> "
    + "--run-id <id> [--evidence-dir <path>]",
  );
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Int2EvidenceError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(`int2-evidence: ${message}\n`);
    process.exitCode = 1;
  });
}
