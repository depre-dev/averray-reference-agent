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
import {
  createHermesDecisionRecord,
  whyHermesLine,
  type HermesDecisionRecord,
} from "@avg/averray-mcp/decision-records";

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
  agent: string;
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
  decisionRecord?: HermesDecisionRecord;
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
  const decisionRecord = buildAutoApprovalDecisionRecord({
    task: deps.task,
    decision,
    dispatch,
    policy: deps.policy,
    todayCount,
    todayRepoCount,
    suspended,
    halt,
  });

  if (decision.approve) {
    await deps.approve(deps.task.id, AUTOPILOT_APPROVER);
    await deps.audit({ ...baseAudit, action: "approved", decisionRecord });
    return { action: "approved", reason: decision.reason };
  }

  if (decision.escalate) {
    await deps.audit({ ...baseAudit, action: "escalated", decisionRecord });
    await deps.alert(buildHighRiskEscalationAlert(deps.task, deps.boardUrl, decisionRecord));
    return { action: "escalated", reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
  }

  // Engaged but a gate blocked a low-risk task (suspended / halt / over-budget).
  await deps.audit({ ...baseAudit, action: "left_proposed", decisionRecord });
  return { action: "left_proposed", reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
}

export function buildHighRiskEscalationAlert(
  task: AutoApprovalTask,
  boardUrl: string,
  decisionRecord?: HermesDecisionRecord,
): AlertPayload {
  const label = task.title ? `"${task.title}"` : task.id;
  const text =
    `⚠️ Autopilot escalated a HIGH-RISK task to you — ${label} in ${task.repo} (${task.agent}). ` +
    `Autopilot never auto-approves high-risk dispatch; approve or cancel it on the board.\n` +
    (decisionRecord ? `${whyHermesLine(decisionRecord)}\n` : "") +
    (task.routingReason ? `Why high-risk: ${task.routingReason}\n` : "") +
    `Board: ${boardUrl}`;
  return { count: 1, items: [], boardUrl, text };
}

function buildAutoApprovalDecisionRecord(input: {
  task: AutoApprovalTask;
  decision: AutoApprovalDecision;
  dispatch: { allowed: boolean; reason: string };
  policy: DispatchPolicyConfig;
  todayCount: number;
  todayRepoCount: number;
  suspended: boolean;
  halt: boolean;
}): HermesDecisionRecord {
  const action = input.decision.approve
    ? "approved"
    : input.decision.escalate
      ? "escalated"
      : "left_proposed";
  return createHermesDecisionRecord({
    kind: input.decision.escalate ? "escalation" : "auto_approval",
    subject: { type: "task", id: input.task.id, repo: input.task.repo },
    decision: action,
    reasons: autoApprovalReasons(input),
    inputs: {
      riskTier: input.task.riskTier ?? "unset",
      routingReason: input.task.routingReason,
      policyGates: {
        dispatchAllowed: input.dispatch.allowed,
        dispatchReason: input.dispatch.reason,
        allowedRepos: input.policy.allowedRepos,
        allowedAgents: input.policy.allowedAgents,
      },
      budgetGates: {
        todayCount: input.todayCount,
        todayRepoCount: input.todayRepoCount,
        perDayMax: input.policy.perDayMax,
        perRepoPerDayMax: input.policy.perRepoPerDayMax,
      },
      anomalySignals: {
        autopilotSuspended: input.suspended,
        haltPresent: input.halt,
      },
      wouldChangeDecision: input.decision.approve
        ? "Any failed gate, exhausted budget, HALT, suspension, or high-risk tier would have left the task proposed."
        : "A low-risk tier, no suspension/HALT, allowed dispatch policy, and remaining budget are required for auto-approval.",
    },
    outcome: {
      summary: input.decision.approve
        ? "Hermes approved the proposed task for dispatch."
        : input.decision.escalate
          ? "Hermes left the task proposed and alerted the operator."
          : "Hermes left the task proposed for operator action.",
      waitingNext: input.decision.approve
        ? "The runner can claim the task."
        : "The operator can approve or cancel the task on the board.",
      changed: input.decision.approve ? ["task status: proposed -> approved"] : undefined,
    },
    safety: {
      readOnly: false,
      mutates: input.decision.approve,
      mutatesGithub: false,
      mutatesAverray: input.decision.approve,
      editsWikipedia: false,
    },
  });
}

function autoApprovalReasons(input: {
  task: AutoApprovalTask;
  decision: AutoApprovalDecision;
  dispatch: { allowed: boolean; reason: string };
  policy: DispatchPolicyConfig;
  todayCount: number;
  todayRepoCount: number;
  suspended: boolean;
  halt: boolean;
}): string[] {
  if (input.decision.approve) {
    return [
      "Autopilot is engaged and the task is low-risk.",
      "The dispatch policy allowed this repo and agent.",
      `Daily budget remaining after this decision: ${Math.max(0, input.policy.perDayMax - input.todayCount)} global, ${Math.max(0, input.policy.perRepoPerDayMax - input.todayRepoCount)} for this repo.`,
    ];
  }
  if (input.decision.escalate) {
    return [
      "Autopilot never auto-approves high-risk or unclassified tasks.",
      input.task.routingReason ?? input.decision.detail ?? "The task did not carry a low-risk classification.",
      "The operator must approve or cancel the task manually.",
    ];
  }
  if (input.suspended) return ["The D3 anomaly guard suspended autopilot.", "Hermes left the task proposed until the operator resumes autopilot."];
  if (input.halt) return ["HALT is present.", "Hermes left the task proposed because mutating work is stopped."];
  if (!input.dispatch.allowed) {
    return [
      `The dispatch policy blocked approval: ${input.dispatch.reason}.`,
      "Hermes left the task proposed so the operator can inspect the policy or budget.",
    ];
  }
  return ["A required approval gate did not pass.", "Hermes left the task proposed for operator review."];
}
