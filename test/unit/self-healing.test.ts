import { describe, expect, it, vi } from "vitest";

import {
  decideHealingAction,
  runSelfHealingOnce,
  buildFixPrompt,
  buildHealingEscalationAlert,
  createCooldown,
  testbedSurfaceKey,
  selfHealingTargetSignature,
  type FailureSignal,
  type HealingClassification,
  type SelfHealingDeps,
} from "../../services/slack-operator/src/self-healing.js";

const LOW: HealingClassification = { agent: "claude", riskTier: "low", reason: "UI surface, low-risk" };
const HIGH: HealingClassification = { agent: "codex", riskTier: "high", reason: "deploy/settlement, high-risk" };

function signal(over: Partial<FailureSignal> = {}): FailureSignal {
  return {
    surface: "testbed:sweep-1",
    source: "testbed_mission",
    summary: "Testbed mission for https://app.example/overview failed: 503 on /overview",
    evidence: "https://board.example?mission=sweep-1",
    repo: "averray-agent/agent",
    area: "testbed overview",
    ...over,
  };
}

// ── pure decision matrix ────────────────────────────────────────────

describe("decideHealingAction — propose only the safe path; everything else escalates", () => {
  const open = { suspended: false, halt: false };

  it("non-high-risk + repo + classified → propose with the routed agent", () => {
    expect(decideHealingAction(signal(), LOW, open)).toMatchObject({ action: "propose", agent: "claude", riskTier: "low", reason: "routed_fix" });
  });

  it("high-risk surface → escalate (never propose a build)", () => {
    expect(decideHealingAction(signal(), HIGH, open)).toMatchObject({ action: "escalate", reason: "high_risk_surface" });
  });

  it("rollback → escalate even when it would classify low-risk", () => {
    expect(decideHealingAction(signal({ isRollback: true }), LOW, open)).toMatchObject({ action: "escalate", reason: "rollback_operator_confirmed" });
  });

  it("D3 interlock: suspended → escalate only", () => {
    expect(decideHealingAction(signal(), LOW, { suspended: true, halt: false })).toMatchObject({ action: "escalate", reason: "autopilot_suspended" });
  });

  it("HALT set → escalate only", () => {
    expect(decideHealingAction(signal(), LOW, { suspended: false, halt: true })).toMatchObject({ action: "escalate", reason: "halt_present" });
  });

  it("no target repo → escalate (can't route a build)", () => {
    expect(decideHealingAction(signal({ repo: undefined }), undefined, open)).toMatchObject({ action: "escalate", reason: "no_target_repo" });
  });

  it("HALT/suspend win over a high-risk classification (interlock first)", () => {
    expect(decideHealingAction(signal(), HIGH, { suspended: true, halt: false }).reason).toBe("autopilot_suspended");
  });
});

describe("buildFixPrompt / escalation alert", () => {
  it("the fix prompt carries the failure + evidence and says don't merge/deploy", () => {
    const p = buildFixPrompt(signal());
    expect(p).toContain("503 on /overview");
    expect(p).toContain("Evidence: https://board.example?mission=sweep-1");
    expect(p).toMatch(/do not merge or deploy/i);
  });
  it("the escalation alert names the surface + reason", () => {
    const alert = buildHealingEscalationAlert(signal({ isRollback: true }), { action: "escalate", reason: "rollback_operator_confirmed" }, "https://board.example");
    expect(alert.text).toMatch(/rollback/i);
    expect(alert.text).toContain("testbed:sweep-1");
    expect(alert.items[0]?.id).toBe("testbed:sweep-1");
  });
});

// ── injected orchestrator ───────────────────────────────────────────

interface Harness {
  deps: SelfHealingDeps;
  proposed: Array<{ surface: string; agent: string; riskTier: string }>;
  alerts: number;
  audits: Array<{ surface: string; action: string; reason: string; agent?: string; taskId?: string }>;
}

function harness(signals: FailureSignal[], over: Partial<SelfHealingDeps> = {}, classification: HealingClassification = LOW): Harness {
  const proposed: Harness["proposed"] = [];
  const alerts = { n: 0 };
  const audits: Harness["audits"] = [];
  const cooldown = createCooldown(30 * 60_000);
  const deps: SelfHealingDeps = {
    getSignals: () => signals,
    isSuspended: () => false,
    isHalt: () => false,
    classify: () => classification,
    hasOpenFixTask: () => false,
    proposalsToday: () => 0,
    maxProposalsPerDay: 10,
    openFixCount: () => 0,
    maxOpenFixTasks: 3,
    maxProposalsPerTick: 10,
    inCooldown: (s, n) => cooldown.inCooldown(s, n),
    markHandled: (s, n) => cooldown.markHandled(s, n),
    propose: async ({ signal: s, agent, riskTier }) => {
      proposed.push({ surface: s.surface, agent, riskTier });
      return { taskId: `task-${s.surface}` };
    },
    alert: async () => {
      alerts.n += 1;
      return true;
    },
    audit: (record) => {
      audits.push({ surface: record.surface, action: record.action, reason: String(record.reason), ...(record.agent ? { agent: record.agent } : {}), ...(record.taskId ? { taskId: record.taskId } : {}) });
    },
    boardUrl: "https://board.example",
    now: () => new Date("2026-05-31T12:00:00.000Z"),
    ...over,
  };
  return { deps, proposed, get alerts() { return alerts.n; }, audits };
}

describe("runSelfHealingOnce — orchestration (injected deps, no fs/network)", () => {
  it("no signals (normal load) → nothing proposed, nothing alerted, nothing audited", async () => {
    const h = harness([]);
    const r = await runSelfHealingOnce(h.deps);
    expect(r.handled).toHaveLength(0);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it("a non-high-risk failure → ONE proposed fix task with the routed agent, audited", async () => {
    const h = harness([signal()]);
    const r = await runSelfHealingOnce(h.deps);
    expect(h.proposed).toEqual([{ surface: "testbed:sweep-1", agent: "claude", riskTier: "low" }]);
    expect(h.alerts).toBe(0);
    expect(h.audits[0]).toMatchObject({ action: "propose", agent: "claude", taskId: "task-testbed:sweep-1" });
    expect(r.handled[0]).toMatchObject({ action: "propose" });
  });

  it("a high-risk failure → escalate, NO build task", async () => {
    const h = harness([signal()], {}, HIGH);
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "high_risk_surface" });
  });

  it("a rollback → escalate, NO build task", async () => {
    const h = harness([signal({ isRollback: true })]);
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "rollback_operator_confirmed" });
  });

  it("dedup: an already-open fix task for the surface → skip (no second proposal)", async () => {
    const h = harness([signal()], { hasOpenFixTask: (targetSignature) => targetSignature === "testbed_mission:testbed:sweep-1" });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ action: "skip", reason: "open_fix_exists" });
  });

  it("dedup: duplicate signals for the same failing target in one tick → proposed once", async () => {
    const h = harness([
      signal({ surface: "testbed:app.example/overview", evidence: "https://board.example?mission=old-1" }),
      signal({ surface: "testbed:app.example/overview", evidence: "https://board.example?mission=old-2" }),
    ]);
    const r = await runSelfHealingOnce(h.deps);
    expect(h.proposed.map((p) => p.surface)).toEqual(["testbed:app.example/overview"]);
    expect(r.handled).toEqual([
      { surface: "testbed:app.example/overview", action: "propose", reason: "routed_fix" },
      { surface: "testbed:app.example/overview", action: "skip", reason: "duplicate_signal" },
    ]);
    expect(h.audits.at(-1)).toMatchObject({ action: "skip", reason: "duplicate_signal" });
  });

  it("cooldown: a target handled within the window is skipped", async () => {
    const cd = createCooldown(30 * 60_000);
    cd.markHandled("testbed_mission:testbed:sweep-1", Date.parse("2026-05-31T11:50:00.000Z")); // 10m before now
    const h = harness([signal()], { inCooldown: (s, n) => cd.inCooldown(s, n), markHandled: (s, n) => cd.markHandled(s, n) });
    const r = await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(0);
    expect(r.handled[0]).toMatchObject({ action: "skip", reason: "cooldown" });
  });

  it("same failure twice within cooldown → proposed once", async () => {
    const cooldown = createCooldown(30 * 60_000);
    const now = { value: Date.parse("2026-05-31T12:00:00.000Z") };
    const first = harness([signal()], {
      inCooldown: (target, n) => cooldown.inCooldown(target, n),
      markHandled: (target, n) => cooldown.markHandled(target, n),
      now: () => new Date(now.value),
    });
    const second = harness([signal({ summary: "same mission failed again: 503 on /overview" })], {
      inCooldown: (target, n) => cooldown.inCooldown(target, n),
      markHandled: (target, n) => cooldown.markHandled(target, n),
      now: () => new Date(now.value + 5 * 60_000),
    });

    await runSelfHealingOnce(first.deps);
    await runSelfHealingOnce(second.deps);

    expect(first.proposed).toHaveLength(1);
    expect(second.proposed).toHaveLength(0);
  });

  it("uses a stable target signature based on the failing mission identity, not refreshed failure text", () => {
    expect(selfHealingTargetSignature(signal())).toBe(selfHealingTargetSignature(signal({ summary: "updated failure text" })));
  });

  it("D3 interlock: suspended → escalate only (no proposal)", async () => {
    const h = harness([signal()], { isSuspended: () => true });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "autopilot_suspended" });
  });

  it("HALT → escalate only (no proposal)", async () => {
    const h = harness([signal()], { isHalt: () => true });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "halt_present" });
  });

  it("budget backstop: at the daily cap → escalate instead of propose", async () => {
    const h = harness([signal()], { proposalsToday: () => 10, maxProposalsPerDay: 10 });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "dispatch_budget_exhausted" });
  });

  it("per-tick cap: extra same-tick proposals skip instead of bursting", async () => {
    const h = harness([
      signal({ surface: "testbed:a" }),
      signal({ surface: "testbed:b" }),
    ], { maxProposalsPerTick: 1 });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed.map((p) => p.surface)).toEqual(["testbed:a"]);
    expect(h.alerts).toBe(0);
    expect(h.audits.find((a) => a.surface === "testbed:b")).toMatchObject({ action: "skip", reason: "tick_budget_exhausted" });
  });

  it("mixed batch: one low-risk proposes, one high-risk escalates, deduped surface skips", async () => {
    const signals = [
      signal({ surface: "testbed:a" }),
      signal({ surface: "deploy-verify:b", source: "post_deploy_verification", area: "deploy" }),
      signal({ surface: "testbed:c" }),
    ];
    const h = harness(signals, {
      classify: (s) => (s.area === "deploy" ? HIGH : LOW),
      hasOpenFixTask: (targetSignature) => targetSignature === "testbed_mission:testbed:c",
    });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed.map((p) => p.surface)).toEqual(["testbed:a"]);
    expect(h.alerts).toBe(1); // deploy-verify:b escalated
    expect(h.audits.find((a) => a.surface === "testbed:c")).toMatchObject({ action: "skip", reason: "open_fix_exists" });
  });
});

// ── swarm fixes: stable surface key + open-fix cap ──────────────────

describe("testbedSurfaceKey — stable across re-runs (NOT the per-run id)", () => {
  it("keys on the target host+path, so re-runs of the same mission collapse", () => {
    // Different mission RUN ids, same target → same surface key.
    const a = testbedSurfaceKey("https://app.example.test/overview");
    const b = testbedSurfaceKey("https://app.example.test/overview?ts=2");
    expect(a).toBe("testbed:app.example.test/overview");
    expect(b).toBe("testbed:app.example.test/overview");
    expect(a).toBe(b);
  });
  it("distinct targets stay distinct surfaces", () => {
    expect(testbedSurfaceKey("https://app.example.test/runs")).not.toBe(
      testbedSurfaceKey("https://app.example.test/overview"),
    );
  });
  it("tolerates a non-URL target and trailing slashes", () => {
    expect(testbedSurfaceKey("app.example.test/jobs/")).toBe("testbed:app.example.test/jobs");
    expect(testbedSurfaceKey("")).toBe("testbed:unknown");
  });
});

describe("runSelfHealingOnce — open-fix cap backstop", () => {
  it("at the concurrent open-fix cap → escalate instead of proposing", async () => {
    const h = harness([signal()], { openFixCount: () => 3, maxOpenFixTasks: 3 });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(h.alerts).toBe(1);
    expect(h.audits[0]).toMatchObject({ action: "escalate", reason: "open_fix_cap_reached" });
  });

  it("a batch of distinct-surface failures stops proposing once the cap fills mid-run", async () => {
    const signals = [
      signal({ surface: "testbed:a" }),
      signal({ surface: "testbed:b" }),
      signal({ surface: "testbed:c" }),
    ];
    // Start with 2 already open + cap 3 → only the first new one proposes, the rest escalate.
    const h = harness(signals, { openFixCount: () => 2, maxOpenFixTasks: 3 });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed.map((p) => p.surface)).toEqual(["testbed:a"]);
    expect(h.alerts).toBe(2); // b + c escalated
    expect(h.audits.filter((a) => a.reason === "open_fix_cap_reached")).toHaveLength(2);
  });
});

describe("runSelfHealingOnce — per-tick proposal cap", () => {
  it("cools down and skips eligible failures once the tick cap is reached", async () => {
    const signals = [
      signal({ surface: "testbed:a" }),
      signal({ surface: "testbed:b" }),
      signal({ surface: "testbed:c" }),
    ];
    const h = harness(signals, { maxProposalsPerTick: 1 });
    await runSelfHealingOnce(h.deps);
    expect(h.proposed.map((p) => p.surface)).toEqual(["testbed:a"]);
    expect(h.alerts).toBe(0);
    expect(h.audits.filter((a) => a.reason === "tick_budget_exhausted")).toHaveLength(2);
  });
});
