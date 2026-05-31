// O4-PR3b — autopilot auto-approval: THE AUTHORITY CHANGE.
//
// When Hermes proposes a task, autopilot may approve it (proposed → approved,
// approvedBy "hermes-autopilot") — but ONLY dispatch, and ONLY when every gate
// holds. It NEVER merges or deploys (those stay human, always), and high-risk
// surfaces ALWAYS escalate to the operator.
//
// Auto-approve iff ALL hold:
//   - autopilot engaged (mode==autopilot AND now<until)            [PR3a]
//   - NOT D3-suspended                                             [D3]
//   - HALT_FILE absent                                             [kill switch]
//   - dispatch policy allows (allowlist + within daily budget)     [O4-PR1]
//   - riskTier != "high"  (high ALWAYS escalates)                  [O4-PR2]
// Otherwise the task is LEFT PROPOSED for the operator. Supervised (autopilot
// not engaged) is the silent default — no decision is recorded, every task just
// waits for the operator exactly as before.
//
// Pure decision (decideAutoApproval) + effect-injected orchestrator
// (runAutoApproval) so the authority matrix is unit-tested with no fs/network.

import type { AlertPayload } from "./alert-bridge.js";
import { evaluateDispatchPolicy, type DispatchPolicyConfig } from "@avg/averray-mcp/dispatch-policy";

export interface AutoApprovalSignals {
  /** mode==autopilot AND now<until (PR3a isAutopilotEngaged). */
  engaged: boolean;
  /** D3 autopilot-suspended flag. */
  suspended: boolean;
  /** HALT_FILE present. */
  halt: boolean;
  /** evaluateDispatchPolicy(...).allowed (allowlist + within daily budget). */
  dispatchAllowed: boolean;
  /** The machine reason from the dispatch policy (for the audit when blocked). */
  dispatchReason?: string;
  /** O4-PR2 routing tier. Anything other than "low" is treated as high (fail-safe). */
  riskTier?: "high" | "low";
}

export type AutoApprovalReason =
  | "supervised"
  | "auto_approved"
  | "high_risk_escalated"
  | "autopilot_suspended"
  | "halt_present"
  | "dispatch_blocked";

export interface AutoApprovalDecision {
  /** Approve the task now (proposed → approved by hermes-autopilot). */
  approve: boolean;
  /** High-risk: always left for the operator AND alerted. */
  escalate: boolean;
  reason: AutoApprovalReason;
  detail?: string;
}

/**
 * Pure: the auto-approval authority matrix. High-risk is checked first so it
 * ALWAYS escalates (and alerts) whenever autopilot is engaged. Everything else
 * fails closed — any single failed gate leaves the task proposed.
 */
export function decideAutoApproval(s: AutoApprovalSignals): AutoApprovalDecision {
  if (!s.engaged) return { approve: false, escalate: false, reason: "supervised" };
  // High-risk surfaces (contracts/chain/settlement/secrets/migrations/deploy)
  // ALWAYS escalate — autopilot never auto-approves them. Treat any non-"low"
  // tier as high (fail-safe: an unclassified task is not auto-approved).
  if (s.riskTier !== "low") {
    return { approve: false, escalate: true, reason: "high_risk_escalated", detail: `riskTier=${s.riskTier ?? "unset"}` };
  }
  if (s.suspended) return { approve: false, escalate: false, reason: "autopilot_suspended" };
  if (s.halt) return { approve: false, escalate: false, reason: "halt_present" };
  if (!s.dispatchAllowed) {
    return { approve: false, escalate: false, reason: "dispatch_blocked", detail: s.dispatchReason };
  }
  return { approve: true, escalate: false, reason: "auto_approved" };
}

export interface AutoApprovalTask {
  id: string;
  repo: string;
  agent: "codex" | "claude";
  riskTier?: "high" | "low";
  routingReason?: string;
  title?: string;
}

export interface AutoApprovalAudit {
  taskId: string;
  repo: string;
  agent: string;
  action: "approved" | "escalated" | "left_proposed";
  reason: AutoApprovalReason;
  detail?: string;
  riskTier?: "high" | "low";
}

export interface AutoApprovalDeps {
  task: AutoApprovalTask;
  isEngaged: () => boolean;
  isSuspended: () => boolean;
  isHalt: () => boolean;
  policy: DispatchPolicyConfig;
  /** Autopilot-dispatched-today counts for the budget gate (global + per repo). */
  counts: () => Promise<{ todayCount: number; todayRepoCount: number }>;
  /** proposed → approved, approvedBy "hermes-autopilot". */
  approve: (id: string, approvedBy: string) => Promise<unknown>;
  /** D4 alert (fired ONLY on high-risk escalation). */
  alert: (payload: AlertPayload) => Promise<boolean>;
  /** Handoff/decision audit (every engaged decision). */
  audit: (record: AutoApprovalAudit) => Promise<unknown> | unknown;
  boardUrl: string;
}

export interface AutoApprovalResult {
  action: "approved" | "escalated" | "left_proposed";
  reason: AutoApprovalReason;
  detail?: string;
}

const AUTOPILOT_APPROVER = "hermes-autopilot";

/**
 * Orchestrate a single proposed task through the autopilot gate. Supervised is
 * a silent no-op (the task simply waits for the operator). When engaged: a
 * passing low-risk task is auto-approved + audited; a high-risk task is left
 * proposed + audited + ALERTED; any gate-block is left proposed + audited
 * (no silent caps — the operator can see why autopilot didn't act).
 */
export async function runAutoApproval(deps: AutoApprovalDeps): Promise<AutoApprovalResult> {
  const engaged = deps.isEngaged();
  if (!engaged) return { action: "left_proposed", reason: "supervised" };

  const suspended = deps.isSuspended();
  const halt = deps.isHalt();
  const { todayCount, todayRepoCount } = await deps.counts();
  const dispatch = evaluateDispatchPolicy(deps.policy, {
    repo: deps.task.repo,
    agent: deps.task.agent,
    todayCount,
    todayRepoCount,
  });

  const decision = decideAutoApproval({
    engaged,
    suspended,
    halt,
    dispatchAllowed: dispatch.allowed,
    dispatchReason: dispatch.reason,
    ...(deps.task.riskTier ? { riskTier: deps.task.riskTier } : {}),
  });

  const baseAudit = {
    taskId: deps.task.id,
    repo: deps.task.repo,
    agent: deps.task.agent,
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
    ...(deps.task.riskTier ? { riskTier: deps.task.riskTier } : {}),
  };

  if (decision.approve) {
    await deps.approve(deps.task.id, AUTOPILOT_APPROVER);
    await deps.audit({ ...baseAudit, action: "approved" });
    return { action: "approved", reason: decision.reason };
  }

  if (decision.escalate) {
    await deps.audit({ ...baseAudit, action: "escalated" });
    await deps.alert(buildHighRiskEscalationAlert(deps.task, deps.boardUrl));
    return { action: "escalated", reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
  }

  // Engaged but a gate blocked a low-risk task (suspended / halt / over-budget).
  await deps.audit({ ...baseAudit, action: "left_proposed" });
  return { action: "left_proposed", reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
}

export function buildHighRiskEscalationAlert(task: AutoApprovalTask, boardUrl: string): AlertPayload {
  const label = task.title ? `"${task.title}"` : task.id;
  const text =
    `⚠️ Autopilot escalated a HIGH-RISK task to you — ${label} in ${task.repo} (${task.agent}). ` +
    `Autopilot never auto-approves high-risk dispatch; approve or cancel it on the board.\n` +
    (task.routingReason ? `Why high-risk: ${task.routingReason}\n` : "") +
    `Board: ${boardUrl}`;
  return { count: 1, items: [], boardUrl, text };
}
