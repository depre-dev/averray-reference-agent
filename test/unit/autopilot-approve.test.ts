import { describe, expect, it, vi } from "vitest";

import {
  decideAutoApproval,
  runAutoApproval,
  buildHighRiskEscalationAlert,
  type AutoApprovalDeps,
  type AutoApprovalTask,
} from "../../services/slack-operator/src/autopilot-approve.js";
import type { DispatchPolicyConfig } from "../../packages/averray-mcp/src/dispatch-policy.js";

// ── pure decision matrix ────────────────────────────────────────────

const base = { engaged: true, suspended: false, halt: false, dispatchAllowed: true, riskTier: "low" as const };

describe("decideAutoApproval — the authority matrix (fail-closed)", () => {
  it("supervised (not engaged) → never auto-approves, not an escalation", () => {
    expect(decideAutoApproval({ ...base, engaged: false })).toMatchObject({ approve: false, escalate: false, reason: "supervised" });
  });

  it("engaged + low-risk + all gates pass → auto-approve", () => {
    expect(decideAutoApproval(base)).toMatchObject({ approve: true, escalate: false, reason: "auto_approved" });
  });

  it("high-risk ALWAYS escalates — even with every other gate green", () => {
    expect(decideAutoApproval({ ...base, riskTier: "high" })).toMatchObject({ approve: false, escalate: true, reason: "high_risk_escalated" });
  });

  it("an unclassified (missing) risk tier is treated as high → escalate (fail-safe)", () => {
    expect(decideAutoApproval({ ...base, riskTier: undefined })).toMatchObject({ approve: false, escalate: true, reason: "high_risk_escalated" });
  });

  it("D3-suspended (low-risk) → left proposed, no escalation alert", () => {
    expect(decideAutoApproval({ ...base, suspended: true })).toMatchObject({ approve: false, escalate: false, reason: "autopilot_suspended" });
  });

  it("HALT present (low-risk) → left proposed", () => {
    expect(decideAutoApproval({ ...base, halt: true })).toMatchObject({ approve: false, escalate: false, reason: "halt_present" });
  });

  it("dispatch blocked (over-budget / not-allowlisted) → left proposed with the policy reason", () => {
    expect(decideAutoApproval({ ...base, dispatchAllowed: false, dispatchReason: "daily_budget_exhausted" }))
      .toMatchObject({ approve: false, escalate: false, reason: "dispatch_blocked", detail: "daily_budget_exhausted" });
  });

  it("high-risk wins over a suspended/halt low gate (still escalates)", () => {
    expect(decideAutoApproval({ ...base, riskTier: "high", suspended: true, halt: true })).toMatchObject({ escalate: true, reason: "high_risk_escalated" });
  });
});

// ── injected orchestrator ───────────────────────────────────────────

const POLICY: DispatchPolicyConfig = {
  allowedRepos: ["owner/repo"],
  allowedAgents: ["codex", "claude"],
  perDayMax: 10,
  perRepoPerDayMax: 5,
};

const TASK: AutoApprovalTask = { id: "codex-task-1", repo: "owner/repo", agent: "claude", riskTier: "low", title: "tweak the UI" };

interface Harness {
  deps: AutoApprovalDeps;
  approved: Array<{ id: string; approvedBy: string }>;
  alerts: number;
  audits: Array<{ action: string; reason: string; taskId: string }>;
}

function harness(over: Partial<AutoApprovalDeps> = {}, task: AutoApprovalTask = TASK): Harness {
  const approved: Harness["approved"] = [];
  const alerts = { n: 0 };
  const audits: Harness["audits"] = [];
  const deps: AutoApprovalDeps = {
    task,
    isEngaged: () => true,
    isSuspended: () => false,
    isHalt: () => false,
    policy: POLICY,
    counts: async () => ({ todayCount: 0, todayRepoCount: 0 }),
    approve: async (id, approvedBy) => {
      approved.push({ id, approvedBy });
      return { id, status: "approved" };
    },
    alert: async () => {
      alerts.n += 1;
      return true;
    },
    audit: (record) => {
      audits.push({ action: record.action, reason: record.reason, taskId: record.taskId });
    },
    boardUrl: "https://board.example/monitor",
    ...over,
  };
  return { deps, approved, get alerts() { return alerts.n; }, audits };
}

describe("runAutoApproval — orchestration (injected effects, no fs/network)", () => {
  it("supervised → SILENT no-op: no approve, no alert, no audit", async () => {
    const h = harness({ isEngaged: () => false });
    const r = await runAutoApproval(h.deps);
    expect(r).toMatchObject({ action: "left_proposed", reason: "supervised" });
    expect(h.approved).toHaveLength(0);
    expect(h.alerts).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it("engaged + low-risk + within budget → auto-approve by hermes-autopilot, audited, NO alert", async () => {
    const h = harness();
    const r = await runAutoApproval(h.deps);
    expect(r.action).toBe("approved");
    expect(h.approved).toEqual([{ id: "codex-task-1", approvedBy: "hermes-autopilot" }]);
    expect(h.audits).toEqual([{ action: "approved", reason: "auto_approved", taskId: "codex-task-1" }]);
    expect(h.alerts).toBe(0); // routine auto-approval doesn't spam the operator
  });

  it("high-risk → escalate: NOT approved, audited, AND alerted", async () => {
    const h = harness({}, { ...TASK, riskTier: "high" });
    const r = await runAutoApproval(h.deps);
    expect(r.action).toBe("escalated");
    expect(h.approved).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ action: "escalated", reason: "high_risk_escalated" });
    expect(h.alerts).toBe(1);
  });

  it("D3-suspended → left proposed, no approve, no alert, audited with the reason", async () => {
    const h = harness({ isSuspended: () => true });
    const r = await runAutoApproval(h.deps);
    expect(r).toMatchObject({ action: "left_proposed", reason: "autopilot_suspended" });
    expect(h.approved).toHaveLength(0);
    expect(h.alerts).toBe(0);
    expect(h.audits[0]).toMatchObject({ action: "left_proposed", reason: "autopilot_suspended" });
  });

  it("HALT present → left proposed (no approve)", async () => {
    const h = harness({ isHalt: () => true });
    const r = await runAutoApproval(h.deps);
    expect(r.reason).toBe("halt_present");
    expect(h.approved).toHaveLength(0);
  });

  it("over the daily budget → left proposed via the real dispatch policy", async () => {
    const h = harness({ counts: async () => ({ todayCount: 10, todayRepoCount: 5 }) });
    const r = await runAutoApproval(h.deps);
    expect(r.action).toBe("left_proposed");
    expect(r.reason).toBe("dispatch_blocked");
    expect(h.approved).toHaveLength(0);
  });

  it("a repo not on the allowlist → left proposed (fail-closed)", async () => {
    const h = harness({}, { ...TASK, repo: "owner/not-allowed" });
    const r = await runAutoApproval(h.deps);
    expect(r.action).toBe("left_proposed");
    expect(r.reason).toBe("dispatch_blocked");
    expect(h.approved).toHaveLength(0);
  });

  it("the only mutation autopilot performs is dispatch approval — never merge/deploy", async () => {
    const h = harness();
    await runAutoApproval(h.deps);
    // The sole effect is approveCodexTask(approvedBy hermes-autopilot); there is
    // no merge/deploy effect in the deps surface at all.
    expect(h.approved).toEqual([{ id: "codex-task-1", approvedBy: "hermes-autopilot" }]);
  });
});

describe("buildHighRiskEscalationAlert", () => {
  it("names the task + repo and says autopilot won't auto-approve high-risk", () => {
    const alert = buildHighRiskEscalationAlert({ ...TASK, riskTier: "high", routingReason: "touches settlement" }, "https://board.example/monitor");
    expect(alert.text).toMatch(/HIGH-RISK/);
    expect(alert.text).toContain("owner/repo");
    expect(alert.text).toContain("touches settlement");
    expect(alert.text).toContain("https://board.example/monitor");
  });
});
