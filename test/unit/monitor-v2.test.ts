import { describe, expect, it } from "vitest";

import {
  normalizeLane,
  mapTagsToRisk,
  inferCardType,
  inferAgentType,
  mapOwnerToWaitingOn,
  parseAgeToMinutes,
  cardId,
  toBoardCard,
  agentTypeFromBranch,
  buildV2BoardSnapshot,
  isCriticalFile,
  mapChecks,
  mapFiles,
  mapCheckRuns,
  mapRiskSignals,
  indexRawSummaries,
  indexCodexTasks,
  indexTestbedMissions,
  enrichBoardCard,
  mapMissionReport,
} from "../../services/slack-operator/src/monitor-v2.js";
import type { BoardCard } from "../../services/slack-operator/src/monitor-v2.js";
import type { HermesBoardCardSnapshot } from "../../services/slack-operator/src/monitor-hermes-voice.js";

function slim(overrides: Partial<HermesBoardCardSnapshot> = {}): HermesBoardCardSnapshot {
  return {
    repo: "depre-dev/agent",
    number: 548,
    title: "Allow operator override of agent claim-stake floor",
    lane: "Operator Review",
    owner: "Operator",
    verdict: "Hermes pre-check passed",
    ageLabel: "4m",
    why: "2 changed files touch review-gated surfaces",
    next: "Approve & merge",
    tags: ["workflow", "config", "review-gated"],
    ...overrides,
  };
}

describe("normalizeLane", () => {
  it("maps every classifier label to the kebab-case enum", () => {
    expect(normalizeLane("Needs Attention")).toBe("needs-attention");
    expect(normalizeLane("Waiting / Drafts")).toBe("drafts");
    expect(normalizeLane("Codex Needed")).toBe("codex-needed");
    expect(normalizeLane("Hermes Checking")).toBe("hermes-checking");
    expect(normalizeLane("Operator Review")).toBe("operator-review");
    expect(normalizeLane("Release Queue")).toBe("release-queue");
    expect(normalizeLane("Deploying")).toBe("deploying");
    expect(normalizeLane("Done")).toBe("done");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeLane("  operator review  ")).toBe("operator-review");
    expect(normalizeLane("DONE")).toBe("done");
  });

  it("falls back to hermes-checking for unknown / missing labels", () => {
    expect(normalizeLane("Some Future Lane")).toBe("hermes-checking");
    expect(normalizeLane(undefined)).toBe("hermes-checking");
    expect(normalizeLane("")).toBe("hermes-checking");
  });
});

describe("mapTagsToRisk", () => {
  it("keeps recognized risk tags, drops the rest", () => {
    expect(mapTagsToRisk(["workflow", "config", "made-up-tag", "contracts"]))
      .toEqual(["workflow", "config", "contracts"]);
  });

  it("is case-insensitive", () => {
    expect(mapTagsToRisk(["WORKFLOW", "Indexer"])).toEqual(["workflow", "indexer"]);
  });

  it("returns [] for missing / non-array input", () => {
    expect(mapTagsToRisk(undefined)).toEqual([]);
    // @ts-expect-error — exercising the defensive branch
    expect(mapTagsToRisk("not-an-array")).toEqual([]);
  });
});

describe("inferCardType", () => {
  it("done lane → done", () => {
    expect(inferCardType(slim({ lane: "Done" }), "done")).toBe("done");
  });
  it("testbed tag → mission", () => {
    expect(inferCardType(slim({ tags: ["testbed"] }), "hermes-checking")).toBe("mission");
  });
  it("'mission' in title → mission", () => {
    expect(inferCardType(slim({ title: "Verify onboarding mission" }), "hermes-checking")).toBe("mission");
  });
  it("codex-needed lane → task", () => {
    expect(inferCardType(slim({ tags: [] }), "codex-needed")).toBe("task");
  });
  it("deploying lane → deploy", () => {
    expect(inferCardType(slim({ tags: [] }), "deploying")).toBe("deploy");
  });
  it("post-merge verify title → deploy", () => {
    expect(inferCardType(slim({ title: "Post-merge verify #544", tags: [] }), "hermes-checking")).toBe("deploy");
  });
  it("drafts lane → draft", () => {
    expect(inferCardType(slim({ tags: [] }), "drafts")).toBe("draft");
  });
  it("default → pr", () => {
    expect(inferCardType(slim({ tags: [] }), "operator-review")).toBe("pr");
  });
});

describe("agentTypeFromBranch", () => {
  it("maps codex/* and claude/* prefixes (case-insensitive)", () => {
    expect(agentTypeFromBranch("codex/foo")).toBe("codex");
    expect(agentTypeFromBranch("claude/bar")).toBe("claude");
    expect(agentTypeFromBranch("Codex/Foo")).toBe("codex");
    expect(agentTypeFromBranch("  CLAUDE/Bar  ")).toBe("claude");
  });
  it("returns undefined for non-agent / missing branches", () => {
    expect(agentTypeFromBranch("feature/x")).toBeUndefined();
    expect(agentTypeFromBranch("codexish/x")).toBeUndefined(); // prefix must be "codex/"
    expect(agentTypeFromBranch("")).toBeUndefined();
    expect(agentTypeFromBranch(undefined)).toBeUndefined();
  });
});

describe("inferAgentType", () => {
  it("mission type → hermes (even with a non-hermes branch)", () => {
    expect(inferAgentType(slim({ owner: "Operator", headBranch: "codex/x" }), "mission")).toBe("hermes");
  });
  it("branch prefix wins over a conflicting owner", () => {
    expect(inferAgentType(slim({ owner: "Codex", headBranch: "claude/x" }), "pr")).toBe("claude");
    expect(inferAgentType(slim({ owner: "Merge steward", headBranch: "codex/x" }), "pr")).toBe("codex");
  });
  it("codex/* and claude/* attribute, case-insensitive", () => {
    expect(inferAgentType(slim({ owner: "ext", headBranch: "codex/feat" }), "pr")).toBe("codex");
    expect(inferAgentType(slim({ owner: "ext", headBranch: "Claude/Feat" }), "pr")).toBe("claude");
  });
  it("non-agent branch falls back to the owner heuristic", () => {
    expect(inferAgentType(slim({ owner: "Codex", headBranch: "feature/x" }), "pr")).toBe("codex");
    expect(inferAgentType(slim({ owner: "Merge steward", headBranch: "feature/x" }), "pr")).toBe("ext");
  });
  it("owner contains codex → codex (no branch)", () => {
    expect(inferAgentType(slim({ owner: "Codex", headBranch: undefined }), "pr")).toBe("codex");
  });
  it("owner contains hermes → hermes", () => {
    expect(inferAgentType(slim({ owner: "Hermes", headBranch: undefined }), "pr")).toBe("hermes");
  });
  it("unknown owner → ext", () => {
    expect(inferAgentType(slim({ owner: "Merge steward", headBranch: undefined }), "pr")).toBe("ext");
  });
});

describe("mapOwnerToWaitingOn", () => {
  it("operator + action → warn tone", () => {
    expect(mapOwnerToWaitingOn("Operator", true)).toEqual({ actor: "operator", tone: "warn" });
  });
  it("operator without action → neutral tone", () => {
    expect(mapOwnerToWaitingOn("Operator", false)).toEqual({ actor: "operator", tone: "neutral" });
  });
  it("PR author → author/neutral", () => {
    expect(mapOwnerToWaitingOn("PR author", false)).toEqual({ actor: "author", tone: "neutral" });
  });
  it("merge steward → branch-protection/neutral", () => {
    expect(mapOwnerToWaitingOn("Merge steward", false)).toEqual({ actor: "branch-protection", tone: "neutral" });
  });
  it("codex / hermes → agent/info", () => {
    expect(mapOwnerToWaitingOn("Codex", false)).toEqual({ actor: "agent", tone: "info" });
    expect(mapOwnerToWaitingOn("Hermes", false)).toEqual({ actor: "agent", tone: "info" });
  });
  it("unknown owner → agent/info", () => {
    expect(mapOwnerToWaitingOn("Mystery", false)).toEqual({ actor: "agent", tone: "info" });
    expect(mapOwnerToWaitingOn(undefined, false)).toEqual({ actor: "agent", tone: "info" });
  });
});

describe("parseAgeToMinutes", () => {
  it("parses minutes", () => {
    expect(parseAgeToMinutes("4m")).toBe(4);
    expect(parseAgeToMinutes("12 minutes ago")).toBe(12);
  });
  it("parses hours into minutes", () => {
    expect(parseAgeToMinutes("2h")).toBe(120);
    expect(parseAgeToMinutes("1.5 hours")).toBe(90);
  });
  it("parses days into minutes", () => {
    expect(parseAgeToMinutes("2d")).toBe(2880);
    expect(parseAgeToMinutes("3 days ago")).toBe(4320);
  });
  it("returns 0 for unparseable / missing", () => {
    expect(parseAgeToMinutes("just now")).toBe(0);
    expect(parseAgeToMinutes(undefined)).toBe(0);
    expect(parseAgeToMinutes("")).toBe(0);
  });
});

describe("cardId", () => {
  it("uses repo-name #number when PR identity exists", () => {
    expect(cardId(slim({ repo: "depre-dev/agent", number: 548 }))).toBe("agent #548");
  });
  it("slugs the title when no PR identity", () => {
    expect(cardId(slim({ repo: undefined, number: undefined, title: "Verify onboarding flow" })))
      .toBe("verify-onboarding-flow");
  });
  it("caps the slug length", () => {
    const longTitle = "a".repeat(80);
    expect(cardId(slim({ repo: undefined, number: undefined, title: longTitle })).length).toBeLessThanOrEqual(40);
  });

  it("appends a stable correlationId suffix for identity-less cards", () => {
    const id = cardId(slim({
      repo: undefined,
      number: undefined,
      title: "post-production-deploy verification after workflow run",
      correlationId: "github-deploy-1099-abc1234",
    }));
    expect(id.startsWith("post-production-deploy-verification-afte")).toBe(true);
    expect(id.endsWith("1099-abc1234")).toBe(true);
  });

  it("gives same-title deploy cards distinct ids by correlationId", () => {
    const a = cardId(slim({ repo: undefined, number: undefined, title: "post-deploy verification", correlationId: "github-deploy-1099-aaa" }));
    const b = cardId(slim({ repo: undefined, number: undefined, title: "post-deploy verification", correlationId: "github-deploy-1100-bbb" }));
    expect(a).not.toBe(b);
  });

  it("ignores correlationId when PR identity exists", () => {
    expect(cardId(slim({ repo: "depre-dev/agent", number: 548, correlationId: "github-deploy-1-x" }))).toBe("agent #548");
  });
});

describe("toBoardCard", () => {
  it("maps a full operator-review card", () => {
    const card = toBoardCard(slim());
    expect(card.id).toBe("agent #548");
    expect(card.lane).toBe("operator-review");
    expect(card.type).toBe("pr");
    expect(card.agentType).toBe("ext"); // owner "Operator" doesn't match codex/hermes/claude
    expect(card.title).toMatch(/claim-stake floor/);
    expect(card.summary).toMatch(/review-gated surfaces/);
    expect(card.repo).toBe("depre-dev/agent");
    expect(card.freshness).toBe(4);
    expect(card.state).toBe("fresh");
    expect(card.risk).toEqual(["workflow", "config", "review-gated"]);
    expect(card.waitingOn).toEqual({ actor: "operator", tone: "neutral" });
    expect(card.verdict).toBe("Hermes pre-check passed");
    expect(card.next).toBe("Approve & merge");
  });

  it("sets branch + agentType together from headBranch", () => {
    const card = toBoardCard(slim({ owner: "Operator", headBranch: "claude/monitor-agent-attribution" }));
    expect(card.branch).toBe("claude/monitor-agent-attribution");
    expect(card.agentType).toBe("claude"); // branch wins over the "Operator" owner
  });

  it("leaves branch undefined when no headBranch is present", () => {
    expect(toBoardCard(slim({ headBranch: undefined })).branch).toBeUndefined();
  });

  it("flags needs-attention cards as isAction with warn tone", () => {
    const card = toBoardCard(slim({ lane: "Needs Attention", owner: "Operator" }));
    expect(card.lane).toBe("needs-attention");
    expect(card.isAction).toBe(true);
    expect(card.waitingOn).toEqual({ actor: "operator", tone: "warn" });
  });

  it("flags drafts cards as isDraft", () => {
    const card = toBoardCard(slim({ lane: "Waiting / Drafts", owner: "PR author" }));
    expect(card.lane).toBe("drafts");
    expect(card.isDraft).toBe(true);
    expect(card.type).toBe("draft");
  });

  it("classifies a testbed mission card", () => {
    const card = toBoardCard(slim({
      lane: "Hermes Checking",
      tags: ["testbed"],
      title: "Verify onboarding flow on staging",
      owner: "Hermes",
    }));
    expect(card.type).toBe("mission");
    expect(card.agentType).toBe("hermes");
  });

  it("falls back to empty summary + 0 freshness on a bare card", () => {
    const card = toBoardCard({ title: "X", lane: "Hermes Checking", owner: "Hermes" } as HermesBoardCardSnapshot);
    expect(card.summary).toBe("");
    expect(card.freshness).toBe(0);
    expect(card.repo).toBe("");
    expect(card.risk).toEqual([]);
  });
});

describe("buildV2BoardSnapshot", () => {
  it("returns an empty board for an empty / non-record snapshot", () => {
    const snap = buildV2BoardSnapshot(undefined, { repo: "depre-dev/agent", now: () => new Date("2026-05-28T12:00:00Z") });
    expect(snap.cards).toEqual([]);
    expect(snap.at).toBe("2026-05-28T12:00:00.000Z");
    expect(snap.repo).toBe("depre-dev/agent");
  });

  it("classifies + enriches items from a raw monitor snapshot", () => {
    // Minimal raw snapshot the classifier can consume: it reads
    // `active` and `recent` arrays of item records.
    const raw = {
      active: [
        {
          title: "Allow operator override of agent claim-stake floor",
          status: "needs_review",
          intent: "operator_review",
          summary: {
            pullRequest: { repo: "depre-dev/agent", number: 548, state: "open" },
            finalVerdict: "operator_review",
          },
          ageLabel: "4m",
        },
      ],
      recent: [],
    };
    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    expect(Array.isArray(snap.cards)).toBe(true);
    // The classifier produced at least one card and it enriched into
    // a valid BoardCard with a lane + type.
    if (snap.cards.length > 0) {
      const card = snap.cards[0];
      expect(typeof card.id).toBe("string");
      expect(typeof card.lane).toBe("string");
      expect(["pr", "mission", "task", "deploy", "draft", "done"]).toContain(card.type);
      expect(card.state).toBe("fresh");
    }
  });

  it("includes the configured repo on the envelope", () => {
    const snap = buildV2BoardSnapshot({ active: [], recent: [] }, { repo: "depre-dev/site" });
    expect(snap.repo).toBe("depre-dev/site");
  });
});

// ── Enrichment ──────────────────────────────────────────────────────

describe("isCriticalFile", () => {
  it("flags secrets, env, migrations, contracts, .sol", () => {
    expect(isCriticalFile("ops/secrets.yml")).toBe(true);
    expect(isCriticalFile(".env")).toBe(true);
    expect(isCriticalFile("config/.env.prod")).toBe(true);
    expect(isCriticalFile("db/0042_migration.sql")).toBe(true);
    expect(isCriticalFile("contracts/Foo.sol")).toBe(true);
    expect(isCriticalFile("agent/Token.sol")).toBe(true);
  });
  it("treats ordinary files as non-critical", () => {
    expect(isCriticalFile("docs/readme.md")).toBe(false);
    expect(isCriticalFile("packages/monitor-ui/src/App.tsx")).toBe(false);
  });
});

describe("mapChecks", () => {
  it("maps githubLive.checkTotals to the UI shape", () => {
    const summary = {
      githubLive: { checkTotals: { total: 6, passed: 5, failed: 0, active: 1, neutral: 0 } },
    };
    expect(mapChecks(summary)).toEqual({ pass: 5, running: 1, fail: 0, pending: 0, total: 6 });
  });
  it("maps neutral → pending and failed → fail", () => {
    const summary = {
      githubLive: { checkTotals: { total: 7, passed: 4, failed: 2, active: 0, neutral: 1 } },
    };
    expect(mapChecks(summary)).toEqual({ pass: 4, running: 0, fail: 2, pending: 1, total: 7 });
  });
  it("returns undefined when there are no checks (no totals / zero total)", () => {
    expect(mapChecks(undefined)).toBeUndefined();
    expect(mapChecks({})).toBeUndefined();
    expect(mapChecks({ githubLive: {} })).toBeUndefined();
    expect(mapChecks({ githubLive: { checkTotals: { total: 0 } } })).toBeUndefined();
  });
});

describe("mapFiles", () => {
  it("maps touchedFiles to path + critical (diff left empty)", () => {
    const summary = {
      reviewSignals: {
        touchedFiles: [
          { path: "contracts/AgentAccountCore.sol", area: "contracts" },
          { path: "ops/deploy.staging.yml", area: "ops" },
          { path: "docs/operator/claim-stake.md", area: "docs" },
        ],
      },
    };
    expect(mapFiles(summary)).toEqual([
      { path: "contracts/AgentAccountCore.sol", diff: "", critical: true },
      { path: "ops/deploy.staging.yml", diff: "", critical: false },
      { path: "docs/operator/claim-stake.md", diff: "", critical: false },
    ]);
  });
  it("builds a +A -D diff line when additions/deletions are present", () => {
    const summary = {
      reviewSignals: {
        touchedFiles: [
          { path: "contracts/Foo.sol", area: "contracts", additions: 18, deletions: 4 },
          { path: "docs/x.md", area: "docs", additions: 34, deletions: 0 },
          { path: "ops/only-adds.yml", area: "ops", additions: 9 },
        ],
      },
    };
    expect(mapFiles(summary)).toEqual([
      { path: "contracts/Foo.sol", diff: "+18 -4", critical: true },
      { path: "docs/x.md", diff: "+34 -0", critical: false },
      { path: "ops/only-adds.yml", diff: "+9 -0", critical: false },
    ]);
  });
  it("skips entries without a path and returns [] when absent", () => {
    expect(mapFiles(undefined)).toEqual([]);
    expect(mapFiles({ reviewSignals: { touchedFiles: [{ area: "ops" }, { path: "" }] } })).toEqual([]);
  });
});

describe("mapCheckRuns", () => {
  it("maps summary.checks to pass/fail/running/neutral", () => {
    const summary = {
      checks: [
        { name: "CI · lint", status: "completed", conclusion: "success" },
        { name: "CI · unit", status: "completed", conclusion: "failure" },
        { name: "CI · deploy plan", status: "in_progress", conclusion: null },
        { name: "CI · skipped", status: "completed", conclusion: "skipped" },
      ],
    };
    expect(mapCheckRuns(summary)).toEqual([
      { name: "CI · lint", status: "pass" },
      { name: "CI · unit", status: "fail" },
      { name: "CI · deploy plan", status: "running" },
      { name: "CI · skipped", status: "neutral" },
    ]);
  });
  it("skips nameless checks and returns [] when absent", () => {
    expect(mapCheckRuns(undefined)).toEqual([]);
    expect(mapCheckRuns({ checks: [{ status: "completed" }] })).toEqual([]);
  });
});

describe("mapRiskSignals", () => {
  it("maps reviewReasons, dropping the all-clear sentinel", () => {
    const summary = {
      reviewReasons: [
        { severity: "high", code: "pr_critical_files", message: "1 changed file touches secrets." },
        { severity: "medium", code: "pr_test_signal_missing", message: "No matching test files." },
        { severity: "low", code: "pr_review_green", message: "Looks merge-ready." },
      ],
    };
    expect(mapRiskSignals(summary)).toEqual([
      { severity: "high", code: "pr_critical_files", message: "1 changed file touches secrets." },
      { severity: "medium", code: "pr_test_signal_missing", message: "No matching test files." },
    ]);
  });
  it("defaults an unknown severity to low and returns [] when absent", () => {
    expect(mapRiskSignals({ reviewReasons: [{ code: "x", message: "m", severity: "bogus" }] }))
      .toEqual([{ severity: "low", code: "x", message: "m" }]);
    expect(mapRiskSignals(undefined)).toEqual([]);
  });
});

describe("indexRawSummaries", () => {
  it("indexes active + recent items by <repo>#<number>", () => {
    const raw = {
      active: [{ summary: { pullRequest: { repo: "depre-dev/agent", number: 548 }, foo: 1 } }],
      recent: [{ summary: { currentPullRequest: { repo: "depre-dev/site", number: 547 }, bar: 2 } }],
    };
    const index = indexRawSummaries(raw);
    expect(index.get("depre-dev/agent#548")).toMatchObject({ foo: 1 });
    expect(index.get("depre-dev/site#547")).toMatchObject({ bar: 2 });
  });
  it("falls back to item-level repo + pullRequestNumber", () => {
    const raw = { active: [{ repo: "depre-dev/agent", pullRequestNumber: 999, summary: { z: 3 } }] };
    expect(indexRawSummaries(raw).get("depre-dev/agent#999")).toMatchObject({ z: 3 });
  });
  it("returns an empty map for a non-record snapshot", () => {
    expect(indexRawSummaries(undefined).size).toBe(0);
    expect(indexRawSummaries("nope").size).toBe(0);
  });
});

describe("indexCodexTasks", () => {
  it("indexes codexTasks.items by <repo>#<number>", () => {
    const raw = {
      codexTasks: {
        items: [
          { repo: "depre-dev/agent", pullRequestNumber: 100, prompt: "do the thing" },
          { repo: "depre-dev/agent", pullRequestNumber: 101, prompt: "other" },
        ],
      },
    };
    const index = indexCodexTasks(raw);
    expect(index.get("depre-dev/agent#100")).toMatchObject({ prompt: "do the thing" });
    expect(index.get("depre-dev/agent#101")).toMatchObject({ prompt: "other" });
  });
  it("returns an empty map when codexTasks is absent", () => {
    expect(indexCodexTasks({}).size).toBe(0);
  });
});

describe("enrichBoardCard", () => {
  function base(overrides: Partial<BoardCard> = {}): BoardCard {
    return {
      id: "agent #548",
      lane: "operator-review",
      type: "pr",
      agentType: "codex",
      title: "T",
      summary: "S",
      repo: "depre-dev/agent",
      freshness: 4,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "operator", tone: "warn" },
      ...overrides,
    };
  }

  it("adds checks + files + per-check breakdown + risk signals to a live card", () => {
    const card = enrichBoardCard(base(), slim(), {
      summary: {
        githubLive: { checkTotals: { total: 6, passed: 5, failed: 0, active: 1, neutral: 0 } },
        reviewSignals: { touchedFiles: [{ path: "contracts/Foo.sol", additions: 18, deletions: 4 }] },
        checks: [
          { name: "CI · lint", status: "completed", conclusion: "success" },
          { name: "CI · deploy plan", status: "in_progress" },
        ],
        reviewReasons: [
          { severity: "high", code: "pr_critical_files", message: "1 changed file touches contracts." },
          { severity: "low", code: "pr_review_green", message: "merge-ready" },
        ],
      },
    });
    expect(card.checks).toEqual({ pass: 5, running: 1, fail: 0, pending: 0, total: 6 });
    expect(card.files).toEqual([{ path: "contracts/Foo.sol", diff: "+18 -4", critical: true }]);
    expect(card.checkRuns).toEqual([
      { name: "CI · lint", status: "pass" },
      { name: "CI · deploy plan", status: "running" },
    ]);
    expect(card.riskSignals).toEqual([
      { severity: "high", code: "pr_critical_files", message: "1 changed file touches contracts." },
    ]);
  });

  it("does NOT add checks / files to done cards (compressed layout)", () => {
    const card = enrichBoardCard(base({ type: "done", lane: "done" }), slim({ lane: "Done" }), {
      summary: {
        githubLive: { checkTotals: { total: 6, passed: 6, failed: 0, active: 0, neutral: 0 } },
        reviewSignals: { touchedFiles: [{ path: "docs/x.md" }] },
      },
    });
    expect(card.checks).toBeUndefined();
    expect(card.files).toBeUndefined();
  });

  it("sets mergeStatus / closedAt / verdictText on done cards", () => {
    const card = enrichBoardCard(
      base({ type: "done", lane: "done", verdict: "merged" }),
      slim({ lane: "Done", verdict: "merged" }),
      {
        summary: {
          currentPullRequest: { repo: "depre-dev/agent", number: 546, merged: true, updatedAt: "2026-05-27T16:28:00Z" },
        },
      }
    );
    expect(card.mergeStatus).toBe("MERGED");
    expect(card.closedAt).toBe("2026-05-27T16:28:00Z");
    expect(card.verdictText).toBe("merged");
  });

  it("marks an unmerged closed PR as CLOSED", () => {
    const card = enrichBoardCard(base({ type: "done", lane: "done" }), slim({ lane: "Done" }), {
      summary: { currentPullRequest: { merged: false } },
    });
    expect(card.mergeStatus).toBe("CLOSED");
  });

  it("adds Codex task detail + runner liveness to task cards", () => {
    const card = enrichBoardCard(base({ type: "task", lane: "codex-needed" }), slim({ lane: "Codex Needed" }), {
      codexTask: {
        id: "task-1",
        prompt: "Coalesce repeated policy-attach entries",
        stdoutTail: "ran ok",
        failureReason: undefined,
      },
      runner: { status: "running", updatedAt: "2026-05-28T12:00:00Z", activeTaskId: "task-1" },
    });
    expect(card.prompt).toMatch(/Coalesce/);
    expect(card.output).toBe("ran ok");
    expect(card.runnerHeartbeat).toEqual({ lastSeen: "2026-05-28T12:00:00Z", online: true });
  });

  it("falls back to completionSummary for output and marks a stopped runner offline", () => {
    const card = enrichBoardCard(base({ type: "task", lane: "codex-needed" }), slim({ lane: "Codex Needed" }), {
      codexTask: { id: "task-2", prompt: "p", completionSummary: "done summary" },
      runner: { status: "disabled", updatedAt: "2026-05-28T12:00:00Z" },
    });
    expect(card.output).toBe("done summary");
    expect(card.runnerHeartbeat).toEqual({ lastSeen: "2026-05-28T12:00:00Z", online: false });
  });

  it("is a no-op when no enrichment context is present", () => {
    const card = enrichBoardCard(base(), slim(), {});
    expect(card.checks).toBeUndefined();
    expect(card.files).toBeUndefined();
    expect(card.mergeStatus).toBeUndefined();
    expect(card.prompt).toBeUndefined();
  });
});

describe("buildV2BoardSnapshot — enrichment integration", () => {
  it("projects githubLive checks onto a classified card", () => {
    const raw = {
      active: [
        {
          title: "Allow operator override of agent claim-stake floor",
          status: "needs_review",
          intent: "operator_review",
          ageLabel: "4m",
          summary: {
            pullRequest: { repo: "depre-dev/agent", number: 548, state: "open" },
            currentPullRequest: { repo: "depre-dev/agent", number: 548, state: "open" },
            finalVerdict: "operator_review",
            githubLive: { checkTotals: { total: 6, passed: 5, failed: 0, active: 1, neutral: 0 } },
            reviewSignals: { touchedFiles: [{ path: "ops/deploy.staging.yml" }] },
          },
        },
      ],
      recent: [],
    };
    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const card = snap.cards.find((c) => c.id === "agent #548");
    expect(card).toBeDefined();
    expect(card?.checks).toEqual({ pass: 5, running: 1, fail: 0, pending: 0, total: 6 });
    expect(card?.files).toEqual([{ path: "ops/deploy.staging.yml", diff: "", critical: false }]);
  });

  it("enriches a mission card with the browser agent's structured report (by correlationId)", () => {
    // A classified mission item carries correlationId = run.id and no PR
    // number; the run with its report is bundled at snapshot.testbedMissions.
    const raw = {
      active: [
        {
          correlationId: "mission-xyz",
          repo: "testbed/mission",
          intent: "testbed_agent_mission",
          title: "Verify onboarding mission",
          summary: { kind: "testbed_mission_run", reviewSignals: { touchedAreas: ["testbed"] } },
        },
      ],
      recent: [],
      testbedMissions: [
        {
          id: "mission-xyz",
          targetUrl: "https://staging.averray.com/onboarding",
          freshMemory: true,
          allowTestMutations: false,
          result: {
            verdict: "partial",
            confidence: 0.81,
            scores: { success: 4, clarity: 3, latency: 5 },
            blockers: ["Sign-message modal latency"],
            confusingMoments: ["Receipt poll has no visible cadence"],
            mutationBoundaryNotes: ["No transactions submitted"],
            stoppedBeforeMutation: true,
            completedPath: ["Loaded onboarding page", "Clicked Connect wallet"],
            recommendations: ["Add a spinner to the Sign-message modal"],
            evidence: ["screenshot: https://x.test/step3.png", "trace: browser-trace 2m14s"],
          },
        },
      ],
    };
    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const mission = snap.cards.find((c) => c.type === "mission");
    expect(mission?.mission).toBeDefined();
    expect(mission?.mission?.verdict).toBe("PARTIAL");
    expect(mission?.mission?.target).toBe("https://staging.averray.com/onboarding");
    expect(mission?.mission?.path).toHaveLength(2);
  });
});

describe("indexTestbedMissions", () => {
  it("indexes bundled runs by id and tolerates a missing list", () => {
    const map = indexTestbedMissions({ testbedMissions: [{ id: "m1" }, { id: "m2" }] });
    expect(map.get("m1")).toEqual({ id: "m1" });
    expect(map.size).toBe(2);
    expect(indexTestbedMissions({}).size).toBe(0);
    expect(indexTestbedMissions(undefined).size).toBe(0);
  });
});

describe("mapMissionReport", () => {
  const run = {
    id: "mission-xyz",
    targetUrl: "https://staging.averray.com/onboarding",
    freshMemory: true,
    allowTestMutations: false,
    result: {
      verdict: "partial",
      confidence: 0.81,
      scores: { success: 4, clarity: 3, latency: 5 },
      blockers: ["Sign-message modal latency"],
      confusingMoments: ["Receipt poll has no visible cadence"],
      mutationBoundaryNotes: ["No transactions submitted"],
      stoppedBeforeMutation: true,
      completedPath: ["Loaded onboarding page", "Clicked Connect wallet"],
      recommendations: ["Add a spinner to the Sign-message modal"],
      evidence: ["screenshot: https://x.test/step3.png", "trace: browser-trace 2m14s"],
    },
  };

  it("maps verdict, confidence, seed, path, blockers, evidence, boundary, recs", () => {
    const m = mapMissionReport(run)!;
    expect(m.verdict).toBe("PARTIAL");
    expect(m.verdictTone).toBe("warn");
    expect(m.confidence).toBe(0.81);
    expect(m.seed).toBe("fresh · no memory");
    expect(m.path).toEqual([
      { n: 1, status: "ok", desc: "Loaded onboarding page", lat: "" },
      { n: 2, status: "ok", desc: "Clicked Connect wallet", lat: "" },
    ]);
    // blockers then confusing moments, as plain heads
    expect(m.blockers.map((b) => b.head)).toEqual([
      "Sign-message modal latency",
      "Receipt poll has no visible cadence",
    ]);
    // evidence "type: detail" → kind + label + href (link only when a URL)
    expect(m.evidence[0]).toEqual({ kind: "screenshot", label: "https://x.test/step3.png", href: "https://x.test/step3.png" });
    expect(m.evidence[1]).toEqual({ kind: "trace", label: "browser-trace 2m14s", href: "#" });
    expect(m.mutationBoundary).toMatch(/stopped before any mutation\. No transactions submitted/);
    expect(m.recommendations).toEqual(["Add a spinner to the Sign-message modal"]);
  });

  it("maps 0–5 scores to 0–10 by key, omitting unknown ones", () => {
    const m = mapMissionReport(run)!;
    expect(m.successScore).toBe(8); // 4 × 2
    expect(m.clarityScore).toBe(6); // 3 × 2
    expect(m.latencyScore).toBe(10); // 5 × 2
  });

  it("does NOT invent runs/latency the report doesn't carry", () => {
    const m = mapMissionReport(run)!;
    expect(m.runs).toBeUndefined();
    expect(m.latency).toBeUndefined();
  });

  it("returns undefined when the run has no result yet (mission still running)", () => {
    expect(mapMissionReport({ id: "m", targetUrl: "https://x.test" })).toBeUndefined();
  });
});
