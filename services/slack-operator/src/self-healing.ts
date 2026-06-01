// B2 — self-healing / incident response.
//
// A server-side routine: when a failure signal trips, Hermes either
//   - auto-PROPOSES a routed fix task (non-high-risk), which lands `proposed`
//     and flows through the EXISTING approval/autopilot gate — B2 NEVER
//     auto-approves or auto-runs, or
//   - ESCALATES to the operator (high-risk surface, or any rollback) via a D4
//     alert. Rollback is ALWAYS operator-confirmed — "deploy is human."
//
// Depends on D3 (anomaly auto-pause) as the loop fail-safe: while autopilot is
// suspended (D3) or HALT is set, B2 does NOT propose — it only escalates. That
// interlock is what makes self-healing safe to build (no fix-fail-fix spiral).
//
// Storm control: dedup (at most one OPEN fix task per failing target signature
// — checked against the queue, so it survives a restart) + same-tick de-dupe +
// a cooldown (a flapping check can't spawn a swarm) + per-tick/open-fix/daily
// proposal backstops. Read-only except the proposal itself, which is just a
// `proposed` queue entry. Never logs secrets.
//
// Pure decision (decideHealingAction) + effect-injected orchestrator
// (runSelfHealingOnce) so the matrix is unit-tested with no fs/network.

import type { AlertPayload } from "./alert-bridge.js";
import type { TaskAgent } from "./codex-task-queue.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HealingRiskTier = "high" | "low";
export type HealingSource = "testbed_mission" | "post_deploy_verification" | "ci_main" | "ops_health";

export interface FailureSignal {
  /** Stable per-surface key for dedup + cooldown, e.g. "testbed:sweep-7". */
  surface: string;
  source: HealingSource;
  /** Human summary of the failure — feeds the fix prompt + the escalation. */
  summary: string;
  /** A link/id the operator (or the fix agent) can follow. */
  evidence?: string;
  /** The repo a fix would target. Absent ⇒ can't route a build → escalate. */
  repo?: string;
  /** Routing hint passed to the classifier (surface/area). */
  area?: string;
  /** A rollback is ALWAYS operator-confirmed — escalate, never propose. */
  isRollback?: boolean;
  /** False when the signal needs human diagnosis instead of a code-agent fix. */
  autoFixable?: boolean;
  /** Operator-facing explanation for why B2 must not dispatch a code task. */
  nonAutoFixableReason?: string;
  /** Source-specific prompt with enough context for a code agent to act. */
  fixPrompt?: string;
}

export interface HealingClassification {
  agent: TaskAgent;
  riskTier: HealingRiskTier;
  reason: string;
}

export type HealingAction = "propose" | "escalate" | "skip";

export type HealingReason =
  | "autopilot_suspended"
  | "halt_present"
  | "rollback_operator_confirmed"
  | "not_auto_fixable"
  | "no_target_repo"
  | "unclassified"
  | "high_risk_surface"
  | "dispatch_budget_exhausted"
  | "open_fix_cap_reached"
  | "tick_budget_exhausted"
  | "operator_dismissed"
  | "routed_fix";

/**
 * Stable per-surface key for a testbed-mission failure. Keys on the TARGET
 * (host + path), NOT the per-run mission id — testbed missions get a fresh id
 * every run, so keying on the id makes every failed re-run look like a new
 * surface and defeats dedup/cooldown (a recurring failure swarms the queue).
 * Keying on the target collapses all re-runs of the same failing surface to one
 * open fix + one cooldown window.
 */
export function testbedSurfaceKey(targetUrl: string): string {
  let key = (targetUrl ?? "").trim().toLowerCase();
  try {
    const u = new URL(key);
    key = `${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    key = key.replace(/^https?:\/\//, "").split(/[?#]/)[0]!.replace(/\/+$/, "");
  }
  return `testbed:${key || "unknown"}`;
}

/**
 * Operator-facing label for a surface key. Surface keys are namespaced for
 * dedup (e.g. "testbed:testbed-mission-7", "deploy-verify:abc123"); the
 * leading "<namespace>:" is internal plumbing and only confuses operators
 * (it produces titles like "testbed:testbed-mission-7"). Strip the first
 * namespace segment for display, keeping the meaningful remainder.
 */
export function surfaceLabel(surface: string): string {
  const value = (surface ?? "").trim();
  const stripped = value.replace(/^[a-z0-9_-]+:/i, "");
  return stripped || value;
}

export interface HealingDecision {
  action: HealingAction;
  reason: HealingReason;
  riskTier?: HealingRiskTier;
  agent?: TaskAgent;
}

/**
 * Pure: decide what to do with one failure signal. Fail-safe ordering — the D3
 * interlock and rollback win first, then risk, then route. The ONLY path that
 * proposes a build task is a non-high-risk, non-rollback signal with a target
 * repo while autopilot is neither suspended nor halted.
 */
export function decideHealingAction(
  signal: FailureSignal,
  classification: HealingClassification | undefined,
  gates: { suspended: boolean; halt: boolean },
): HealingDecision {
  // D3 interlock: never propose while paused/halted — escalate only.
  if (gates.halt) return { action: "escalate", reason: "halt_present" };
  if (gates.suspended) return { action: "escalate", reason: "autopilot_suspended" };
  // Rollback is always operator-confirmed.
  if (signal.isRollback) return { action: "escalate", reason: "rollback_operator_confirmed" };
  // Some signals are real alerts but not code-agent-fixable.
  if (signal.autoFixable === false) return { action: "escalate", reason: "not_auto_fixable" };
  // Can't route a build without a repo.
  if (!signal.repo) return { action: "escalate", reason: "no_target_repo" };
  if (!classification) return { action: "escalate", reason: "unclassified" };
  // High-risk surfaces (deploy/settlement/contract/secrets/migration) escalate.
  if (classification.riskTier === "high") {
    return { action: "escalate", reason: "high_risk_surface", riskTier: "high" };
  }
  return { action: "propose", reason: "routed_fix", riskTier: classification.riskTier, agent: classification.agent };
}

/** A clear, bounded fix-task prompt describing the failure + an evidence link. */
export function buildFixPrompt(signal: FailureSignal): string {
  const specificPrompt = signal.fixPrompt?.trim();
  if (specificPrompt) return specificPrompt;
  const lines = [
    `A ${humanSource(signal.source)} failed and Hermes self-healing is proposing a fix.`,
    "",
    `Surface: ${signal.surface}`,
    `What failed: ${signal.summary}`,
    ...(signal.evidence ? [`Evidence: ${signal.evidence}`] : []),
    "",
    "Diagnose the root cause and open a minimal, reviewable fix. Read-only investigation first; keep the change narrow. Do not merge or deploy — a human owns that.",
  ];
  return lines.join("\n");
}

/**
 * Stable per-target signature for B2 storm control. Keep this tied to the
 * failing task/mission identity, not volatile failure text, so refreshed error
 * wording does not re-open the same fix every interval.
 */
export function selfHealingTargetSignature(signal: FailureSignal): string {
  return `${signal.source}:${signal.surface}`;
}

export function buildHealingEscalationAlert(
  signal: FailureSignal,
  decision: HealingDecision,
  boardUrl: string,
): AlertPayload {
  const why = escalationHeadline(decision.reason);
  const text =
    `🚑 Hermes self-healing needs you — ${why}\n` +
    `Surface: ${signal.surface} (${humanSource(signal.source)})\n` +
    `What failed: ${signal.summary}\n` +
    (signal.evidence ? `Evidence: ${signal.evidence}\n` : "") +
    (decision.reason === "rollback_operator_confirmed"
      ? "A rollback is always operator-confirmed — Hermes will not auto-act.\n"
      : decision.reason === "high_risk_surface"
        ? "High-risk surface — Hermes escalates instead of auto-proposing a fix.\n"
        : decision.reason === "not_auto_fixable"
          ? `Needs human diagnosis — B2 will not dispatch a code-agent fix${signal.nonAutoFixableReason ? ` (${signal.nonAutoFixableReason})` : ""}.\n`
        : "") +
    `Board: ${boardUrl}`;
  return { count: 1, items: [{ id: signal.surface, title: `self-healing: ${signal.surface}` }], boardUrl, text };
}

function escalationHeadline(reason: HealingReason): string {
  switch (reason) {
    case "rollback_operator_confirmed": return "a rollback needs your confirmation";
    case "not_auto_fixable": return "a failure is not code-agent-fixable";
    case "high_risk_surface": return "a high-risk surface failed";
    case "halt_present": return "a failure tripped while HALT is set";
    case "autopilot_suspended": return "a failure tripped while autopilot is suspended (D3)";
    case "no_target_repo": return "a failure with no routable fix target";
    case "dispatch_budget_exhausted": return "a failure, but the dispatch budget is exhausted";
    case "open_fix_cap_reached": return "a failure, but too many self-healing fixes are already open";
    case "tick_budget_exhausted": return "a failure, but this tick's proposal cap is exhausted";
    default: return "a failure needs your attention";
  }
}

function humanSource(source: HealingSource): string {
  switch (source) {
    case "testbed_mission": return "testbed mission";
    case "post_deploy_verification": return "post-deploy verification";
    case "ci_main": return "CI on main";
    case "ops_health": return "ops-health check";
  }
}

// ── Orchestrator (effect-injected) ──────────────────────────────────

export interface HealingAuditRecord {
  surface: string;
  targetSignature?: string;
  source: HealingSource;
  action: "propose" | "escalate" | "skip";
  reason: HealingReason | "cooldown" | "duplicate_signal" | "open_fix_exists";
  riskTier?: HealingRiskTier;
  agent?: TaskAgent;
  taskId?: string;
  evidence?: string;
}

export interface SelfHealingDeps {
  getSignals: () => Promise<FailureSignal[]> | FailureSignal[];
  isSuspended: () => boolean;
  isHalt: () => boolean;
  /** Classify a signal's surface → agent + riskTier (the routing taxonomy). */
  classify: (signal: FailureSignal) => HealingClassification;
  /** Durable dedup: is there already a non-terminal fix task for this target? */
  hasOpenFixTask: (targetSignature: string) => Promise<boolean> | boolean;
  /** Durable suppression: operator dismissed this target, so B2 must not recreate it. */
  isSuppressedTarget?: (targetSignature: string) => Promise<boolean> | boolean;
  /** B2 fix tasks already proposed today (for the daily budget backstop). */
  proposalsToday: () => Promise<number> | number;
  maxProposalsPerDay: number;
  /** Currently-OPEN (non-terminal) B2 fix tasks across all surfaces — the
   *  concurrent-work cap that stops a batch of distinct failures from swarming
   *  even within the daily budget. */
  openFixCount: () => Promise<number> | number;
  maxOpenFixTasks: number;
  /** Per-tick cap: prevents a noisy batch from proposing a burst of fixes. */
  maxProposalsPerTick: number;
  /** In-memory cooldown: has this target been handled within the window? */
  inCooldown: (targetSignature: string, nowMs: number) => boolean;
  markHandled: (targetSignature: string, nowMs: number) => void;
  /** Propose a `proposed` fix task and run it through the EXISTING gate. */
  propose: (input: {
    signal: FailureSignal;
    targetSignature: string;
    agent: TaskAgent;
    riskTier: HealingRiskTier;
    prompt: string;
    routingReason: string;
  }) => Promise<{ taskId?: string }>;
  alert: (payload: AlertPayload) => Promise<boolean>;
  audit: (record: HealingAuditRecord) => Promise<unknown> | unknown;
  boardUrl: string;
  now: () => Date;
}

export interface SelfHealingResult {
  handled: Array<{ surface: string; action: HealingAction; reason: string }>;
}

export async function runSelfHealingOnce(deps: SelfHealingDeps): Promise<SelfHealingResult> {
  const signals = await deps.getSignals();
  const nowMs = deps.now().getTime();
  const suspended = deps.isSuspended();
  const halt = deps.isHalt();
  const handled: SelfHealingResult["handled"] = [];
  const proposalsToday = await deps.proposalsToday();
  const openFixCount = await deps.openFixCount();
  let proposedThisRun = 0;
  const seenTargets = new Set<string>();

  for (const signal of signals) {
    const targetSignature = selfHealingTargetSignature(signal);

    // Same-tick dedup: if a collector returns the same failing target twice,
    // only the first copy can act.
    if (seenTargets.has(targetSignature)) {
      deps.markHandled(targetSignature, nowMs);
      await deps.audit({ surface: signal.surface, targetSignature, source: signal.source, action: "skip", reason: "duplicate_signal" });
      handled.push({ surface: signal.surface, action: "skip", reason: "duplicate_signal" });
      continue;
    }
    seenTargets.add(targetSignature);

    // Operator dismissal is durable: once the operator says "clear this
    // proposal", B2 must not recreate the same target on the next tick.
    if (await deps.isSuppressedTarget?.(targetSignature)) {
      deps.markHandled(targetSignature, nowMs);
      await deps.audit({ surface: signal.surface, targetSignature, source: signal.source, action: "skip", reason: "operator_dismissed" });
      handled.push({ surface: signal.surface, action: "skip", reason: "operator_dismissed" });
      continue;
    }

    // Durable dedup: one open fix task per target, checked before cooldown so
    // the audit reason stays truthful after restarts or operator-created tasks.
    if (await deps.hasOpenFixTask(targetSignature)) {
      deps.markHandled(targetSignature, nowMs);
      await deps.audit({ surface: signal.surface, targetSignature, source: signal.source, action: "skip", reason: "open_fix_exists" });
      handled.push({ surface: signal.surface, action: "skip", reason: "open_fix_exists" });
      continue;
    }

    // Cooldown: a flapping target can't spawn a swarm of fixes/alerts.
    if (deps.inCooldown(targetSignature, nowMs)) {
      handled.push({ surface: signal.surface, action: "skip", reason: "cooldown" });
      continue;
    }

    // Classify only when a build is even possible (else the decision escalates).
    const classification =
      !suspended && !halt && !signal.isRollback && signal.autoFixable !== false && signal.repo ? deps.classify(signal) : undefined;
    let decision = decideHealingAction(signal, classification, { suspended, halt });

    // Backstops: don't propose past the per-tick cap, daily cap, nor past the
    // concurrent open-fix cap. The per-tick cap cools down + skips so one old
    // backlog of failures cannot page/propose a swarm on first arm.
    if (decision.action === "propose" && proposedThisRun >= deps.maxProposalsPerTick) {
      deps.markHandled(targetSignature, nowMs);
      await deps.audit({ surface: signal.surface, targetSignature, source: signal.source, action: "skip", reason: "tick_budget_exhausted" });
      handled.push({ surface: signal.surface, action: "skip", reason: "tick_budget_exhausted" });
      continue;
    }
    if (decision.action === "propose" && proposalsToday + proposedThisRun >= deps.maxProposalsPerDay) {
      decision = { action: "escalate", reason: "dispatch_budget_exhausted", ...(decision.riskTier ? { riskTier: decision.riskTier } : {}) };
    } else if (decision.action === "propose" && openFixCount + proposedThisRun >= deps.maxOpenFixTasks) {
      decision = { action: "escalate", reason: "open_fix_cap_reached", ...(decision.riskTier ? { riskTier: decision.riskTier } : {}) };
    }

    if (decision.action === "propose") {
      const prompt = buildFixPrompt(signal);
      const { taskId } = await deps.propose({
        signal,
        targetSignature,
        agent: decision.agent!,
        riskTier: decision.riskTier!,
        prompt,
        routingReason: classification!.reason,
      });
      proposedThisRun += 1;
      deps.markHandled(targetSignature, nowMs);
      await deps.audit({
        surface: signal.surface,
        targetSignature,
        source: signal.source,
        action: "propose",
        reason: decision.reason,
        ...(decision.riskTier ? { riskTier: decision.riskTier } : {}),
        ...(decision.agent ? { agent: decision.agent } : {}),
        ...(taskId ? { taskId } : {}),
        ...(signal.evidence ? { evidence: signal.evidence } : {}),
      });
      handled.push({ surface: signal.surface, action: "propose", reason: decision.reason });
      continue;
    }

    // Escalate.
    await deps.alert(buildHealingEscalationAlert(signal, decision, deps.boardUrl));
    deps.markHandled(targetSignature, nowMs);
    await deps.audit({
      surface: signal.surface,
      targetSignature,
      source: signal.source,
      action: "escalate",
      reason: decision.reason,
      ...(decision.riskTier ? { riskTier: decision.riskTier } : {}),
      ...(signal.evidence ? { evidence: signal.evidence } : {}),
    });
    handled.push({ surface: signal.surface, action: "escalate", reason: decision.reason });
  }

  return { handled };
}

export interface SelfHealingTargetSuppression {
  schemaVersion: 1;
  kind: "self_healing_target_suppression";
  targetSignature: string;
  dismissedAt: string;
  dismissedBy: string;
  sourceTaskId?: string;
}

export interface SelfHealingSuppressionDeps {
  path?: string;
  now?: Date;
  dismissedBy?: string;
  sourceTaskId?: string;
}

export async function suppressSelfHealingTarget(
  targetSignature: string,
  deps: SelfHealingSuppressionDeps = {}
): Promise<SelfHealingTargetSuppression> {
  const path = selfHealingSuppressionPath(deps.path);
  const items = await readSelfHealingSuppressions(path);
  const normalized = normalizeTargetSignature(targetSignature);
  const now = (deps.now ?? new Date()).toISOString();
  const suppression: SelfHealingTargetSuppression = {
    schemaVersion: 1,
    kind: "self_healing_target_suppression",
    targetSignature: normalized,
    dismissedAt: now,
    dismissedBy: deps.dismissedBy ?? "operator",
    ...(deps.sourceTaskId ? { sourceTaskId: deps.sourceTaskId } : {}),
  };
  const next = [
    ...items.filter((item) => item.targetSignature !== normalized),
    suppression,
  ];
  await writeSelfHealingSuppressions(path, next);
  return suppression;
}

export async function isSelfHealingTargetSuppressed(
  targetSignature: string,
  deps: Pick<SelfHealingSuppressionDeps, "path"> = {}
): Promise<boolean> {
  const normalized = normalizeTargetSignature(targetSignature);
  const items = await readSelfHealingSuppressions(selfHealingSuppressionPath(deps.path));
  return items.some((item) => item.targetSignature === normalized);
}

/** A simple in-memory per-surface cooldown the routine closure holds. */
export function createCooldown(cooldownMs: number) {
  const last = new Map<string, number>();
  return {
    inCooldown(surface: string, nowMs: number): boolean {
      const at = last.get(surface);
      return at !== undefined && nowMs - at < cooldownMs;
    },
    markHandled(surface: string, nowMs: number): void {
      last.set(surface, nowMs);
    },
  };
}

async function readSelfHealingSuppressions(path: string): Promise<SelfHealingTargetSuppression[]> {
  try {
    const content = await readFile(path, "utf8");
    const value: unknown = JSON.parse(content);
    if (!Array.isArray(value)) return [];
    return value.filter(isSelfHealingTargetSuppression);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function writeSelfHealingSuppressions(path: string, items: SelfHealingTargetSuppression[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(items, null, 2)}\n`);
}

function selfHealingSuppressionPath(path?: string): string {
  return path
    ?? process.env.SELF_HEALING_SUPPRESSIONS_PATH
    ?? `${process.env.AVERRAY_CODEX_TASKS_PATH ?? "/tmp/averray-reference-agent/codex-tasks.json"}.self-healing-suppressions.json`;
}

function normalizeTargetSignature(value: string): string {
  return value.trim();
}

function isSelfHealingTargetSuppression(value: unknown): value is SelfHealingTargetSuppression {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as SelfHealingTargetSuppression).schemaVersion === 1
    && (value as SelfHealingTargetSuppression).kind === "self_healing_target_suppression"
    && typeof (value as SelfHealingTargetSuppression).targetSignature === "string"
    && typeof (value as SelfHealingTargetSuppression).dismissedAt === "string"
    && typeof (value as SelfHealingTargetSuppression).dismissedBy === "string";
}
