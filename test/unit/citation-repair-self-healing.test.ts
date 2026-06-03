import { describe, expect, it } from "vitest";

import { classifyTask } from "../../packages/averray-mcp/src/dispatch-routing.js";
import {
  runSelfHealingOnce,
  selfHealingTargetSignature,
  type FailureSignal,
  type SelfHealingDeps,
} from "../../services/slack-operator/src/self-healing.js";
import {
  citationRepairSignalFromRun,
  citationRepairJobIdFromCorrelation,
  decideCitationRepairReruns,
  failedCitationRepairRunsForSelfHealing,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";

// A raw #410 dry-run result that FAILs the gate (0 dead links + weak_source +
// garbled <ref> + prose replacement). Attached as run.result the way PR #407 does.
const DEFECTIVE_RAW = {
  status: "needs_review",
  runId: "wiki-en-62871101-citation-repair-hash-r3",
  jobId: "wiki-en-62871101",
  confidence: 0.62,
  evidenceSummary: { pageTitle: "Acme Corporation", totalCitations: 9, flaggedCitations: 4, deadLinkCitations: 0 },
  proposalPreview: {
    page_title: "Acme Corporation",
    citation_findings: [{ problem: "weak_source", current_claim: "ounded in 1999 <ref name=acme", evidence_url: "https://example.com/live" }],
    proposed_changes: [{ change_type: "replace_citation", target_text: "ounded in 1999", replacement_text: "Use archived source after editor review.", source_url: "https://example.com/live" }],
    review_notes: "Averray-attributed proposal only.",
  },
  reviewNotes: ["Editor should verify."],
};

function citationRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-cr-1",
    jobId: "wiki-en-62871101",
    mode: "citation_repair",
    status: "failed",
    targetUrl: "https://en.wikipedia.org/wiki/Acme_Corporation",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:05:00.000Z",
    failedAt: "2026-06-01T10:05:00.000Z",
    history: [],
    mission: {},
    result: DEFECTIVE_RAW,
    ...over,
  } as never;
}

const REPO = "depre-dev/averray-reference-agent";

// ── routing ─────────────────────────────────────────────────────────

describe("classifyTask — citation-repair adapter routing", () => {
  it("routes area=citation-repair-adapter → codex, low risk (proposable, not escalate-only)", () => {
    const r = classifyTask({ repo: REPO, area: "citation-repair-adapter", prompt: "Fix the adapter in wiki-evidence.ts and job-workflows.ts." });
    expect(r.agent).toBe("codex");
    expect(r.riskTier).toBe("low");
  });

  it("an incidental high-risk word in the fix-spec does NOT bump a citation task to high-risk", () => {
    // "policy" is a treasury/policy high-risk keyword; the adapter surface wins
    // because it's checked first, so the task stays proposable (low risk).
    const r = classifyTask({ repo: REPO, area: "citation-repair-adapter", prompt: "Diagnose the schema validation or policy path in job-workflows.ts." });
    expect(r.agent).toBe("codex");
    expect(r.riskTier).toBe("low");
  });

  it("does not regress: a genuine settlement task is still high-risk codex", () => {
    const r = classifyTask({ repo: REPO, prompt: "Fix the on-chain settlement escrow payout." });
    expect(r.riskTier).toBe("high");
    expect(r.agent).toBe("codex");
  });
});

// ── collectors ──────────────────────────────────────────────────────

describe("failedCitationRepairRunsForSelfHealing", () => {
  it("returns only the latest FAILED citation-repair run per jobId; ignores non-citation + non-failed", () => {
    const runs = [
      citationRun({ id: "old", updatedAt: "2026-06-01T09:00:00.000Z", failedAt: "2026-06-01T09:00:00.000Z" }),
      citationRun({ id: "new", updatedAt: "2026-06-01T10:05:00.000Z" }),
      citationRun({ id: "other-job", jobId: "wiki-en-99", updatedAt: "2026-06-01T10:01:00.000Z", failedAt: "2026-06-01T10:01:00.000Z" }),
      citationRun({ id: "completed", jobId: "wiki-en-ok", status: "completed", failedAt: undefined }),
      { id: "browser", mode: "surface_sweep", status: "failed", targetUrl: "https://app", updatedAt: "2026-06-01T10:02:00.000Z", failedAt: "2026-06-01T10:02:00.000Z" } as never,
    ];
    const out = failedCitationRepairRunsForSelfHealing(runs, { now: new Date("2026-06-01T11:00:00.000Z") });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(["new", "other-job"]); // deduped to latest per job, citation+failed only
  });
});

describe("citationRepairSignalFromRun", () => {
  it("builds a routable citation_repair FailureSignal for a FAILED run", () => {
    const signal = citationRepairSignalFromRun(citationRun(), { repo: REPO, boardUrl: "https://board.example" });
    expect(signal).toBeDefined();
    expect(signal!.source).toBe("citation_repair");
    expect(signal!.area).toBe("citation-repair-adapter");
    expect(signal!.autoFixable).toBe(true);
    expect(signal!.repo).toBe(REPO);
    expect(signal!.jobId).toBe("wiki-en-62871101");
    expect(signal!.fixPrompt).toContain("wiki-evidence.ts");
    expect(signal!.fixPrompt).toContain("job-workflows.ts");
  });

  it("returns undefined for a run that is not a FAIL (no dispatch from a clean run)", () => {
    const cleanRaw = {
      status: "needs_review",
      jobId: "wiki-en-clean",
      confidence: 0.8,
      evidenceSummary: { totalCitations: 5, flaggedCitations: 0, deadLinkCitations: 0 },
      proposalPreview: { citation_findings: [], proposed_changes: [], review_notes: "All 5 links resolve (200). No repair needed." },
      reviewNotes: ["No dead links found."],
    };
    expect(citationRepairSignalFromRun(citationRun({ jobId: "wiki-en-clean", result: cleanRaw }), { repo: REPO })).toBeUndefined();
  });
});

// ── signal → proposed task (operator-gated, no auto-execute) ─────────

interface Captured {
  agent: string;
  riskTier: string;
  prompt: string;
  targetSignature: string;
  correlationId: string;
}

function healDeps(signals: FailureSignal[], over: Partial<SelfHealingDeps> = {}): { deps: SelfHealingDeps; proposed: Captured[]; alerts: number } {
  const proposed: Captured[] = [];
  const state = { alerts: 0 };
  const deps: SelfHealingDeps = {
    getSignals: () => signals,
    isSuspended: () => false,
    isHalt: () => false,
    classify: (s) =>
      classifyTask({ ...(s.repo ? { repo: s.repo } : {}), prompt: s.summary, ...(s.area ? { area: s.area } : {}) }),
    hasOpenFixTask: () => false,
    proposalsToday: () => 0,
    maxProposalsPerDay: 10,
    openFixCount: () => 0,
    maxOpenFixTasks: 3,
    maxProposalsPerTick: 10,
    inCooldown: () => false,
    markHandled: () => {},
    propose: async ({ signal, targetSignature, agent, riskTier, prompt }) => {
      proposed.push({ agent, riskTier, prompt, targetSignature, correlationId: `self-heal:${targetSignature}` });
      return { taskId: `task-${targetSignature}` };
    },
    alert: async () => {
      state.alerts += 1;
      return true;
    },
    audit: async () => {},
    boardUrl: "https://board.example",
    now: () => new Date("2026-06-01T11:00:00.000Z"),
    ...over,
  };
  return { deps, proposed, get alerts() { return state.alerts; } };
}

describe("citation FAIL → self-healing dispatch", () => {
  it("proposes ONE operator-gated Codex task whose prompt is the fix-spec — no auto-execute", async () => {
    const signal = citationRepairSignalFromRun(citationRun(), { repo: REPO })!;
    const h = healDeps([signal]);
    const result = await runSelfHealingOnce(h.deps);

    expect(h.proposed).toHaveLength(1);
    expect(h.proposed[0]!.agent).toBe("codex");
    expect(h.proposed[0]!.riskTier).toBe("low");
    expect(h.proposed[0]!.prompt).toContain("wiki-evidence.ts");
    expect(h.proposed[0]!.prompt).toContain("job-workflows.ts");
    // The only action is "propose" — runSelfHealingOnce never approves or executes.
    expect(result.handled[0]).toMatchObject({ action: "propose" });
    expect(h.alerts).toBe(0);
    // correlationId encodes the jobId so the loop can re-run the right mission.
    expect(h.proposed[0]!.correlationId).toBe("self-heal:citation_repair:citation-repair:wiki-en-62871101");
    expect(selfHealingTargetSignature(signal)).toBe("citation_repair:citation-repair:wiki-en-62871101");
  });

  it("relief valve: while autopilot is suspended, a citation FAIL escalates — it does NOT dispatch", async () => {
    const signal = citationRepairSignalFromRun(citationRun(), { repo: REPO })!;
    const h = healDeps([signal], { isSuspended: () => true });
    const result = await runSelfHealingOnce(h.deps);
    expect(h.proposed).toHaveLength(0);
    expect(result.handled[0]).toMatchObject({ action: "escalate" });
  });
});

// ── close the loop (re-run keyed by jobId) ──────────────────────────

describe("citationRepairJobIdFromCorrelation", () => {
  it("recovers the jobId from a citation self-heal correlationId", () => {
    expect(citationRepairJobIdFromCorrelation("self-heal:citation_repair:citation-repair:wiki-en-62871101")).toBe("wiki-en-62871101");
  });
  it("returns undefined for a non-citation correlationId", () => {
    expect(citationRepairJobIdFromCorrelation("self-heal:testbed_mission:testbed:app/x")).toBeUndefined();
    expect(citationRepairJobIdFromCorrelation(undefined)).toBeUndefined();
  });
});

describe("decideCitationRepairReruns", () => {
  const completedTask = {
    id: "task-1",
    status: "completed",
    correlationId: "self-heal:citation_repair:citation-repair:wiki-en-62871101",
    completedAt: "2026-06-02T12:00:00.000Z",
  };

  it("re-runs the citation_repair mission for the jobId when the fix task completes", () => {
    const out = decideCitationRepairReruns({ tasks: [completedTask], runs: [], enabled: true });
    expect(out).toEqual([{ jobId: "wiki-en-62871101", taskId: "task-1" }]);
  });

  it("is idempotent: a re-run mission created after completion suppresses further re-runs", () => {
    const out = decideCitationRepairReruns({
      tasks: [completedTask],
      runs: [{ jobId: "wiki-en-62871101", mode: "citation_repair", createdAt: "2026-06-02T12:00:30.000Z" }],
      enabled: true,
    });
    expect(out).toEqual([]);
  });

  it("ignores non-completed tasks and non-citation correlationIds", () => {
    const out = decideCitationRepairReruns({
      tasks: [
        { ...completedTask, status: "running" },
        { id: "t2", status: "completed", correlationId: "self-heal:testbed_mission:testbed:x", completedAt: "2026-06-02T12:00:00.000Z" },
      ],
      runs: [],
      enabled: true,
    });
    expect(out).toEqual([]);
  });

  it("relief valve: returns nothing when self-healing is disabled", () => {
    expect(decideCitationRepairReruns({ tasks: [completedTask], runs: [], enabled: false })).toEqual([]);
  });
});
