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
import type { CloudflareAccessServiceToken } from "./testbed-session.js";

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
  /** Real elapsed time for this step, when the live driver captured it. */
  latencyMs?: number;
  /** True if this observation involved a (testbed-only) mutation. */
  mutating?: boolean;
}

export interface GoldPathFinding {
  head: string;
  body?: string;
  evidence?: string[];
}

export interface GoldPathObservation {
  steps: GoldPathStepResult[];
  notes: string[];
  /** Evidence artifacts from the live browser driver: screenshots, traces, console/network notes. */
  evidence?: Array<{ type: string; value: string }>;
  /** Structured blockers with body text for the monitor drawer. */
  blockers?: GoldPathFinding[];
  /** Structured confusing moments with body text for the monitor drawer. */
  confusingMoments?: GoldPathFinding[];
  /** Attempt count and elapsed time captured by the live driver. */
  runs?: number;
  latencyMs?: number;
  /** Optional 0..5 score overrides from the self-judge. */
  scores?: Partial<Record<"success" | "clarity" | "latency", number>>;
  /** Provider usage captured by the live driver, when the Claude SDK exposes it. */
  usage?: Record<string, unknown>;
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
  /** Edge auth for Cloudflare-Access-gated app routes. Values are never report content. */
  cloudflareAccess?: CloudflareAccessServiceToken;
  /** True ⇒ Caddy HTTP Basic Auth is configured (the real gate on app.averray.com).
   *  The credential reaches the browser subprocess via env; only this flag drives
   *  the driver's prompt guidance — never the credential value. */
  basicAuth?: boolean;
  /** Local T3 signer sidecar URL. The driver may request sessions; wallet keys never leave the sidecar. */
  signerBaseUrl?: string;
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
  for (const blocker of observation.blockers ?? []) {
    if (blocker.head.trim()) blockers.push(blocker.body ? `${blocker.head}: ${blocker.body}` : blocker.head);
  }
  for (const moment of observation.confusingMoments ?? []) {
    if (moment.head.trim()) confusingMoments.push(moment.body ? `${moment.head}: ${moment.body}` : moment.head);
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
  freshMemory?: boolean;
  model: GoldPathModel;
  binding: TestbedMutationBinding;
  observation: GoldPathObservation;
  judgement: GoldPathJudgement;
}

export function buildGoldPathReport(input: GoldPathReportInput): Record<string, unknown> {
  const { missionId, goal, targetUrl, freshMemory, model, binding, observation, judgement } = input;
  const completedPath = observation.steps.map(
    (s) => `${s.step} → ${s.status}${s.detail ? ` (${s.detail})` : ""}`,
  );
  const path = observation.steps.map((s, index) => ({
    n: index + 1,
    status: stepStatusForDrawer(s.status),
    desc: `${s.step}: ${s.detail}`,
    ...(Number.isFinite(s.latencyMs) ? { latencyMs: s.latencyMs } : {}),
  }));
  const evidence: Array<{ type: string; value: string }> = [
    { type: "executor", value: "gold_path" },
    { type: "model", value: model },
    { type: "environment", value: binding.environment },
    { type: "mutation_mode", value: binding.mutationMode },
  ];
  for (const s of observation.steps) {
    if (s.evidence) evidence.push({ type: `step:${s.step}`, value: s.evidence });
  }
  if (observation.evidence?.length) evidence.push(...observation.evidence);

  const mutationBoundaryNotes = [
    `Mutation profile: ${binding.environment} / ${binding.mutationMode}. ${binding.reason}`,
    binding.allowTestMutations
      ? `Testbed mutations were permitted (${binding.mutationScope}).`
      : "Read-only run: the agent stopped before every mutation boundary.",
  ];

  const scores = {
    ...judgement.scores,
    ...(observation.scores?.success !== undefined ? { success: observation.scores.success } : {}),
    ...(observation.scores?.clarity !== undefined ? { clarity: observation.scores.clarity } : {}),
    ...(observation.scores?.latency !== undefined ? { latency: observation.scores.latency } : {}),
  };
  const blockers = observation.blockers?.length ? observation.blockers : judgement.blockers;
  const confusingMoments = observation.confusingMoments?.length ? observation.confusingMoments : judgement.confusingMoments;

  return {
    missionId,
    verdict: judgement.verdict,
    verdictTone: judgement.verdict === "pass" ? "ok" : judgement.verdict === "partial" ? "warn" : "fail",
    confidence: judgement.confidence,
    executor: "gold_path",
    runnerMode: "gold_path",
    mode: "gold_path",
    goal,
    targetUrl,
    target: targetUrl,
    seed: freshMemory === false ? "memory" : "fresh",
    environment: binding.environment,
    model,
    runs: observation.runs ?? 1,
    ...(Number.isFinite(observation.latencyMs) ? { latencyMs: observation.latencyMs } : {}),
    stoppedBeforeMutation: observation.stoppedBeforeMutation,
    mutationMode: binding.mutationMode,
    mutationScope: binding.mutationScope,
    mutationBindingReason: binding.reason,
    mutationsAttempted: observation.mutationsAttempted,
    completedPath,
    path,
    blockers,
    confusingMoments,
    mutationBoundaryNotes,
    recommendations: judgement.recommendations,
    evidence,
    scores,
    successScore: observation.scores?.success,
    clarityScore: observation.scores?.clarity,
    latencyScore: observation.scores?.latency,
    ...(observation.usage ? { usage: observation.usage } : {}),
    steps: observation.steps,
    notes: observation.notes,
    summary: `gold_path ${judgement.verdict}: ${observation.steps.filter((s) => s.status === "ok").length}/${observation.steps.length} steps clean on ${binding.environment} (${binding.mutationMode}), ${judgement.blockers.length} blocker(s)`,
  };
}

function stepStatusForDrawer(status: GoldPathStepStatus): "ok" | "warn" | "err" {
  if (status === "ok" || status === "skipped") return "ok";
  if (status === "degraded" || status === "empty") return "warn";
  return "err";
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
  cloudflareAccess?: CloudflareAccessServiceToken;
  /** Caddy HTTP Basic Auth configured for the gated host (flag only). */
  basicAuth?: boolean;
  signerBaseUrl?: string;
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
    ...(deps.cloudflareAccess ? { cloudflareAccess: deps.cloudflareAccess } : {}),
    ...(deps.basicAuth ? { basicAuth: true } : {}),
    ...(deps.signerBaseUrl ? { signerBaseUrl: deps.signerBaseUrl } : {}),
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
    freshMemory: deps.mission.freshMemory,
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
