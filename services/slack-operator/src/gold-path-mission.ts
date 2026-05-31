// T4 — Tier-2 LLM gold-path tester (core).
//
// Drives the platform product's AGENT GOLD PATH as a customer would:
//   onboard → discover → claim → submit → verify → payout + reputation-SBT → receipt
// and judges "could an outside agent succeed, and was the product HONEST about
// its state?". The verdict + structured report feed the existing testbed mission
// store (same shape Tier-1 emits).
//
// This module is the SAFE, deterministic core: the model pick (A4 policy), the
// honest judge, the report builder, and an effect-injected orchestrator. The
// actual product-driving "driver" is INJECTED (`GoldPathDriver`) — so CI runs a
// scripted fake and NEVER calls a live LLM. The live driver (Claude Agent SDK +
// Playwright-MCP) plugs into the same seam.
//
// Safety invariants enforced here:
//   - Mutation profile is resolved via the T5 env→mutation binding. On mainnet
//     (and any non-mutating env) the binding is read-only, so the driver is told
//     `allowMutations: false` — a mutating gold-path against mainnet is
//     STRUCTURALLY impossible (it never receives permission to mutate).
//   - Truth-boundary honesty: the judge reports real / degraded / empty / blocked
//     exactly as observed and NEVER fakes a pass (a blocked/errored required step
//     can't be a pass; a degraded/empty surface is at best "partial").
//   - Read-mostly: a mutating step skipped because mutations aren't allowed is
//     expected (stoppedBeforeMutation), not a failure.

import type { TestbedMutationBinding } from "./testbed-mutation-binding.js";

export type GoldPathStep =
  | "onboard"
  | "discover"
  | "claim"
  | "submit"
  | "verify"
  | "payout_sbt"
  | "receipt";

/** The canonical gold path, in order. */
export const GOLD_PATH_STEPS: readonly GoldPathStep[] = [
  "onboard",
  "discover",
  "claim",
  "submit",
  "verify",
  "payout_sbt",
  "receipt",
] as const;

/** Steps that MUTATE product state — only attempted when the binding allows it. */
export const GOLD_PATH_MUTATING_STEPS: ReadonlySet<GoldPathStep> = new Set<GoldPathStep>([
  "claim",
  "submit",
  "payout_sbt",
]);

/** What the agent observed at a step. Honest by construction — `degraded`/`empty`
 *  are first-class, distinct from a clean `ok`. */
export type GoldPathStepStatus = "ok" | "degraded" | "empty" | "blocked" | "skipped" | "error";

export interface GoldPathStepResult {
  step: GoldPathStep;
  status: GoldPathStepStatus;
  detail: string;
  /** A page-visible evidence pointer (url / selector text / receipt id). Never secrets. */
  evidence?: string;
  /** True if this observation involved a (testbed-only) mutation. */
  mutating?: boolean;
}

export interface GoldPathObservation {
  steps: GoldPathStepResult[];
  notes: string[];
  /** Mutations the agent actually attempted (must be empty in read-only mode). */
  mutationsAttempted: string[];
  /** Whether the agent stopped at every mutation boundary it wasn't allowed to cross. */
  stoppedBeforeMutation: boolean;
}

export type GoldPathModel = "sonnet" | "opus";

export interface GoldPathDriverInput {
  targetUrl: string;
  goal: string;
  steps: readonly GoldPathStep[];
  /** From the T5 binding. The driver MUST NOT mutate when false. */
  allowMutations: boolean;
  mutationScope: string;
  model: GoldPathModel;
  freshMemory: boolean;
  /** T3 session (Bearer for the API gold path, storageState for browser). Opaque here. */
  session?: { role?: string; token?: string; storageState?: unknown };
}

/** The injected product driver. Real impl = Claude Agent SDK + Playwright-MCP;
 *  CI/tests inject a scripted fake. NEVER call a live LLM from the core. */
export interface GoldPathDriver {
  run(input: GoldPathDriverInput): Promise<GoldPathObservation>;
}

// ── A4 model policy ─────────────────────────────────────────────────

/**
 * Sonnet for routine runs; Opus for deep/critical (per A4 §2). riskTier `high`
 * or an explicit `deep` flag → Opus; an operator override wins. Read-mostly
 * gold-path runs are low/medium → Sonnet by default.
 */
export function pickGoldPathModel(input: { riskTier?: "high" | "low"; deep?: boolean; override?: string } = {}): GoldPathModel {
  const override = (input.override ?? "").trim().toLowerCase();
  if (override === "opus" || override === "sonnet") return override;
  if (input.deep || input.riskTier === "high") return "opus";
  return "sonnet";
}

// ── honest judge ────────────────────────────────────────────────────

export type GoldPathVerdict = "pass" | "partial" | "fail";

export interface GoldPathJudgement {
  verdict: GoldPathVerdict;
  confidence: number;
  scores: {
    goalCompletion: number;
    honesty: number;
    recoverability: number;
  };
  blockers: string[];
  confusingMoments: string[];
  recommendations: string[];
}

const TERMINAL_STEP_LABEL: Record<GoldPathStep, string> = {
  onboard: "onboarding",
  discover: "job discovery",
  claim: "claim",
  submit: "submit",
  verify: "verification",
  payout_sbt: "payout + reputation SBT",
  receipt: "receipt",
};

/**
 * Pure, deterministic verdict from the observed outcomes. Truth-boundary:
 *  - any required step `error`/`blocked` → FAIL (the path could not be walked);
 *  - any `degraded`/`empty` surface, or an UNEXPECTED skip → at best PARTIAL
 *    (the product was honest about a degraded state, but the journey wasn't clean);
 *  - a mutating step `skipped` because mutations aren't allowed is EXPECTED in a
 *    read-mostly run — it does not lower the verdict;
 *  - all clean → PASS.
 * Never returns PASS while any blocker/error exists — it cannot fake a pass.
 */
export function judgeGoldPath(
  observation: GoldPathObservation,
  opts: { allowMutations: boolean } = { allowMutations: false },
): GoldPathJudgement {
  const blockers: string[] = [];
  const confusingMoments: string[] = [];
  const recommendations: string[] = [];

  for (const s of observation.steps) {
    const label = TERMINAL_STEP_LABEL[s.step] ?? s.step;
    if (s.status === "error" || s.status === "blocked") {
      blockers.push(`${label}: ${s.detail}`);
    } else if (s.status === "degraded") {
      confusingMoments.push(`${label} rendered a degraded state: ${s.detail}`);
    } else if (s.status === "empty") {
      confusingMoments.push(`${label} was empty: ${s.detail}`);
    } else if (s.status === "skipped") {
      // A read-only run is EXPECTED to skip mutating steps. Only an unexpected
      // skip (a mutating step skipped while mutations WERE allowed, or a
      // non-mutating step skipped) is noteworthy.
      const expectedReadOnlySkip = !opts.allowMutations && GOLD_PATH_MUTATING_STEPS.has(s.step);
      if (!expectedReadOnlySkip) {
        confusingMoments.push(`${label} was skipped: ${s.detail}`);
      }
    }
  }

  if (!observation.stoppedBeforeMutation && !opts.allowMutations) {
    // The driver crossed a mutation boundary it was NOT allowed to — a hard fault.
    blockers.push("Agent attempted a mutation while the mission was read-only.");
  }

  const verdict: GoldPathVerdict = blockers.length > 0
    ? "fail"
    : confusingMoments.length > 0
      ? "partial"
      : "pass";

  if (blockers.length > 0) recommendations.push("Fix the blocked gold-path step(s) so an outside agent can complete the journey.");
  if (confusingMoments.some((m) => /degraded|empty/.test(m))) {
    recommendations.push("Surface a clearer state (or honest empty/degraded label) on the affected step(s).");
  }

  const cleanSteps = observation.steps.filter((s) => s.status === "ok").length;
  const total = observation.steps.length || 1;
  const score = (n: number) => Math.max(0, Math.min(5, Math.round(n)));
  return {
    verdict,
    confidence: verdict === "pass" ? 0.85 : verdict === "fail" ? 0.8 : 0.6,
    scores: {
      goalCompletion: score((cleanSteps / total) * 5),
      honesty: blockers.length === 0 ? 5 : confusingMoments.length === 0 ? 2 : 3,
      recoverability: blockers.length === 0 ? 4 : 2,
    },
    blockers,
    confusingMoments,
    recommendations,
  };
}

// ── report (matches normalizeTestbedMissionStructuredReport) ────────

export interface GoldPathReportInput {
  missionId: string;
  goal: string;
  targetUrl: string;
  model: GoldPathModel;
  binding: TestbedMutationBinding;
  observation: GoldPathObservation;
  judgement: GoldPathJudgement;
}

export function buildGoldPathReport(input: GoldPathReportInput): Record<string, unknown> {
  const { missionId, goal, targetUrl, model, binding, observation, judgement } = input;
  const completedPath = observation.steps.map(
    (s) => `${s.step} → ${s.status}${s.detail ? ` (${s.detail})` : ""}`,
  );
  const evidence: Array<{ type: string; value: string }> = [
    { type: "executor", value: "gold_path" },
    { type: "model", value: model },
    { type: "environment", value: binding.environment },
    { type: "mutation_mode", value: binding.mutationMode },
  ];
  for (const s of observation.steps) {
    if (s.evidence) evidence.push({ type: `step:${s.step}`, value: s.evidence });
  }

  const mutationBoundaryNotes = [
    `Mutation profile: ${binding.environment} / ${binding.mutationMode}. ${binding.reason}`,
    binding.allowTestMutations
      ? `Testbed mutations were permitted (${binding.mutationScope}).`
      : "Read-only run: the agent stopped before every mutation boundary.",
  ];

  return {
    missionId,
    verdict: judgement.verdict,
    confidence: judgement.confidence,
    executor: "gold_path",
    runnerMode: "gold_path",
    mode: "gold_path",
    goal,
    targetUrl,
    environment: binding.environment,
    model,
    stoppedBeforeMutation: observation.stoppedBeforeMutation,
    mutationMode: binding.mutationMode,
    mutationScope: binding.mutationScope,
    mutationBindingReason: binding.reason,
    mutationsAttempted: observation.mutationsAttempted,
    completedPath,
    blockers: judgement.blockers,
    confusingMoments: judgement.confusingMoments,
    mutationBoundaryNotes,
    recommendations: judgement.recommendations,
    evidence,
    scores: judgement.scores,
    steps: observation.steps,
    notes: observation.notes,
    summary: `gold_path ${judgement.verdict}: ${observation.steps.filter((s) => s.status === "ok").length}/${observation.steps.length} steps clean on ${binding.environment} (${binding.mutationMode}), ${judgement.blockers.length} blocker(s)`,
  };
}

// ── orchestrator (effect-injected; never calls a live LLM directly) ──

export interface GoldPathMissionDeps {
  mission: {
    id: string;
    targetUrl: string;
    goal: string;
    freshMemory?: boolean;
  };
  binding: TestbedMutationBinding;
  driver: GoldPathDriver;
  model: GoldPathModel;
  resolveSession?: () => Promise<GoldPathDriverInput["session"] | undefined> | GoldPathDriverInput["session"] | undefined;
  steps?: readonly GoldPathStep[];
}

export interface GoldPathMissionResult {
  report: Record<string, unknown>;
  reportText: string;
  verdict: GoldPathVerdict;
}

export async function runGoldPathMissionOnce(deps: GoldPathMissionDeps): Promise<GoldPathMissionResult> {
  const session = deps.resolveSession ? await deps.resolveSession() : undefined;
  const steps = deps.steps ?? GOLD_PATH_STEPS;
  const allowMutations = deps.binding.allowTestMutations === true;

  const observation = await deps.driver.run({
    targetUrl: deps.mission.targetUrl,
    goal: deps.mission.goal,
    steps,
    allowMutations,
    mutationScope: deps.binding.mutationScope,
    model: deps.model,
    freshMemory: deps.mission.freshMemory !== false,
    ...(session ? { session } : {}),
  });

  // Defense in depth: if a read-only run somehow returned attempted mutations,
  // surface it as a hard fault (the judge will fail it) rather than trusting the
  // driver's own `stoppedBeforeMutation` flag.
  const stoppedBeforeMutation = allowMutations
    ? observation.stoppedBeforeMutation
    : observation.mutationsAttempted.length === 0 && observation.stoppedBeforeMutation;
  const safeObservation: GoldPathObservation = { ...observation, stoppedBeforeMutation };

  const judgement = judgeGoldPath(safeObservation, { allowMutations });
  const report = buildGoldPathReport({
    missionId: deps.mission.id,
    goal: deps.mission.goal,
    targetUrl: deps.mission.targetUrl,
    model: deps.model,
    binding: deps.binding,
    observation: safeObservation,
    judgement,
  });
  return { report, reportText: `${JSON.stringify(report, null, 2)}\n`, verdict: judgement.verdict };
}

// ── scripted fake driver (the CI / default-safe driver) ─────────────

/**
 * An HONEST non-run driver: marks every step `error` with `reason`, so a deploy
 * that enabled the gold-path runner WITHOUT wiring the live LLM driver reports a
 * truthful "not executed" FAIL — never a fake pass. (Truth-boundary: absence of
 * a real run must never read as a passing run.)
 */
export function createUnavailableGoldPathDriver(reason: string): GoldPathDriver {
  return {
    async run(input: GoldPathDriverInput): Promise<GoldPathObservation> {
      return {
        steps: input.steps.map((step) => ({ step, status: "error" as const, detail: reason })),
        notes: [reason],
        mutationsAttempted: [],
        stoppedBeforeMutation: true,
      };
    },
  };
}

export interface ScriptedGoldPathStep {
  step: GoldPathStep;
  status: GoldPathStepStatus;
  detail?: string;
  evidence?: string;
}

/**
 * A deterministic, no-network driver. The default for CI and for any run that
 * hasn't opted into the live LLM driver. Honors read-only mode: mutating steps
 * become `skipped` (read-only) unless `allowMutations`, and it never records an
 * attempted mutation it wasn't allowed to make.
 */
export function createScriptedGoldPathDriver(script?: ScriptedGoldPathStep[]): GoldPathDriver {
  return {
    async run(input: GoldPathDriverInput): Promise<GoldPathObservation> {
      const byStep = new Map((script ?? []).map((s) => [s.step, s]));
      const steps: GoldPathStepResult[] = [];
      const mutationsAttempted: string[] = [];
      for (const step of input.steps) {
        const scripted = byStep.get(step);
        const mutating = GOLD_PATH_MUTATING_STEPS.has(step);
        if (mutating && !input.allowMutations) {
          steps.push({ step, status: "skipped", detail: "read-only run — stopped before mutation", mutating: true });
          continue;
        }
        const status: GoldPathStepStatus = scripted?.status ?? "ok";
        steps.push({
          step,
          status,
          detail: scripted?.detail ?? `${TERMINAL_STEP_LABEL[step]} observed (${status})`,
          ...(scripted?.evidence ? { evidence: scripted.evidence } : {}),
          ...(mutating ? { mutating: true } : {}),
        });
        if (mutating && input.allowMutations && status === "ok") {
          mutationsAttempted.push(`${step}: testbed mutation (${input.mutationScope})`);
        }
      }
      return {
        steps,
        notes: [`scripted gold-path driver (no live LLM); model=${input.model}, allowMutations=${input.allowMutations}`],
        mutationsAttempted,
        stoppedBeforeMutation: true,
      };
    },
  };
}
