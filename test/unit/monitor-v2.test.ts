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
  synthesizeTaskCards,
  taskHealthForBoard,
  automationHealthForBoard,
  diffBoardSnapshots,
} from "../../services/slack-operator/src/monitor-v2.js";
import type { BoardCard } from "../../services/slack-operator/src/monitor-v2.js";
import type { HermesBoardCardSnapshot } from "../../services/slack-operator/src/monitor-hermes-voice.js";
import { createHermesDecisionRecord } from "../../packages/averray-mcp/src/decision-records.js";

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
  it("done-lane testbed mission → mission", () => {
    expect(inferCardType(slim({ lane: "Done", tags: ["testbed"], title: "Fresh-agent browser mission" }), "done"))
      .toBe("mission");
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
  it("maps codex/*, claude/*, and specialist prefixes (case-insensitive)", () => {
    expect(agentTypeFromBranch("codex/foo")).toBe("codex");
    expect(agentTypeFromBranch("claude/bar")).toBe("claude");
    expect(agentTypeFromBranch("test-writer/bar")).toBe("test-writer");
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
    expect(inferAgentType(slim({ owner: "ext", headBranch: "test-writer/coverage" }), "pr")).toBe("test-writer");
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
  it("owner contains test-writer → test-writer", () => {
    expect(inferAgentType(slim({ owner: "Test-writer", headBranch: undefined }), "pr")).toBe("test-writer");
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

  it("corrects a deploy card's waiting-on: branch-protection (pre-merge) → CI (post-merge verify)", () => {
    const card = toBoardCard(slim({
      lane: "Deploying",
      owner: "Merge steward", // would map to branch-protection
      title: "post-production-deploy verification after workflow run",
    }));
    expect(card.type).toBe("deploy");
    expect(card.waitingOn).toEqual({ actor: "CI", tone: "info" });
  });

  it("leaves a non-deploy branch-protection waiting-on untouched (release-queue still awaits branch protection)", () => {
    const card = toBoardCard(slim({ lane: "Release Queue", owner: "Merge steward" }));
    expect(card.type).toBe("pr");
    expect(card.waitingOn).toEqual({ actor: "branch-protection", tone: "neutral" });
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

  it("marks a card failed-fetch when the GitHub source read reported a real error", () => {
    const card = enrichBoardCard(base(), slim(), {
      summary: {
        githubLive: {
          fetchError: {
            code: "404",
            message: "GitHub returned 404 reading /pulls/555",
            lastGoodAt: "2026-05-31T12:00:00Z",
          },
        },
      },
    });

    expect(card.state).toBe("failed-fetch");
    expect(card.sourceFailure).toEqual({
      source: "github",
      code: "404",
      message: "GitHub returned 404 reading /pulls/555",
      lastGoodAt: "2026-05-31T12:00:00Z",
    });
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
        status: "running",
        prompt: "Coalesce repeated policy-attach entries",
        stdoutTail: "ran ok",
        failureReason: undefined,
        workingNow: {
          agent: "codex",
          runnerId: "runner-a",
          label: "Codex fixing",
          since: "2026-05-28T11:55:00Z",
        },
      },
      runner: { status: "running", runnerId: "runner-a", updatedAt: "2026-05-28T12:00:00Z", activeTaskId: "task-1" },
    });
    expect(card.prompt).toMatch(/Coalesce/);
    expect(card.output).toBe("ran ok");
    expect(card.runnerHeartbeat).toEqual({ lastSeen: "2026-05-28T12:00:00Z", online: true });
    expect(card.workingNow).toEqual({
      agent: "codex",
      label: "Codex fixing",
      source: "runner",
      taskId: "task-1",
      runnerId: "runner-a",
      since: "2026-05-28T11:55:00Z",
    });
  });

  it("shows the runner currently working a PR separately from branch author attribution", () => {
    const card = enrichBoardCard(
      base({ type: "pr", lane: "hermes-checking", agentType: "claude", branch: "claude/ui-polish" }),
      slim({ lane: "Hermes Checking", owner: "Hermes", headBranch: "claude/ui-polish" }),
      {
        codexTask: {
          id: "task-pr-1",
          status: "running",
          agent: "codex",
          repo: "depre-dev/agent",
          pullRequestNumber: 548,
          startedAt: "2026-05-28T11:57:00Z",
          workingNow: {
            agent: "codex",
            runnerId: "codex-task-runner",
            label: "Codex fixing",
            since: "2026-05-28T11:57:00Z",
          },
        },
        runner: {
          status: "running",
          runnerId: "codex-task-runner",
          activeTaskId: "task-pr-1",
          updatedAt: "2026-05-28T12:00:00Z",
        },
      },
    );

    expect(card.agentType).toBe("claude");
    expect(card.workingNow).toMatchObject({
      agent: "codex",
      label: "Codex fixing",
      source: "runner",
      taskId: "task-pr-1",
    });
  });

  it("does not show a task worker when runner heartbeat points elsewhere", () => {
    const card = enrichBoardCard(base({ type: "task", lane: "codex-needed" }), slim({ lane: "Codex Needed" }), {
      codexTask: { id: "task-1", status: "running", agent: "codex", prompt: "x" },
      runner: { status: "running", updatedAt: "2026-05-28T12:00:00Z", activeTaskId: "other-task" },
    });

    expect(card.workingNow).toBeUndefined();
  });

  it("uses the classifier owner as a Hermes working-now source for watch cards", () => {
    const card = enrichBoardCard(
      base({ type: "pr", lane: "hermes-checking", agentType: "hermes", waitingOn: { actor: "agent", tone: "info" } }),
      slim({ lane: "Hermes Checking", owner: "Hermes" }),
      {},
    );

    expect(card.workingNow).toEqual({
      agent: "hermes",
      label: "Hermes reviewing",
      source: "classifier",
    });
  });

  it("projects real task timeline events onto task cards", () => {
    const card = enrichBoardCard(base({ type: "task", lane: "codex-needed" }), slim({ lane: "Codex Needed" }), {
      codexTask: {
        id: "task-1",
        prompt: "Fix contract tests",
        events: [
          { at: "2026-06-01T12:00:00.000Z", status: "proposed", message: "Hermes proposed a bounded Codex task." },
          { at: "2026-06-01T12:00:12.000Z", status: "running", message: "Codex runner claimed the task." },
          { at: "", status: "running", message: "missing timestamp ignored" },
        ],
      },
    });

    expect(card.taskEvents).toEqual([
      { at: "2026-06-01T12:00:00.000Z", status: "proposed", message: "Hermes proposed a bounded Codex task." },
      { at: "2026-06-01T12:00:12.000Z", status: "running", message: "Codex runner claimed the task." },
    ]);
  });

  it("falls back to completionSummary for output and marks a stopped runner offline", () => {
    const card = enrichBoardCard(base({ type: "task", lane: "codex-needed" }), slim({ lane: "Codex Needed" }), {
      codexTask: { id: "task-2", status: "approved", prompt: "p", completionSummary: "done summary" },
      runner: { status: "disabled", updatedAt: "2026-05-28T12:00:00Z", message: "runner disabled by operator" },
    });
    expect(card.output).toBe("done summary");
    expect(card.runnerHeartbeat).toEqual({ lastSeen: "2026-05-28T12:00:00Z", online: false });
    expect(card.state).toBe("source-offline");
    expect(card.sourceFailure).toEqual({
      source: "runner",
      code: "ERROR",
      message: "runner disabled by operator",
      lastGoodAt: "2026-05-28T12:00:00Z",
    });
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

  it("attaches active and responded panel review requests to matching cards", () => {
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
          },
        },
      ],
      recent: [],
      reviewRequests: [
        {
          id: "review-1",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
          requestedBy: "hermes",
          reviewer: "claude",
          reason: "Second-agent review before this moves forward.",
          status: "requested",
          reviewMode: "panel",
          panelId: "panel-1",
          panelSize: 3,
          createdAt: "2026-05-31T12:00:00.000Z",
          updatedAt: "2026-05-31T12:00:00.000Z",
        },
        {
          id: "review-2",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
          requestedBy: "hermes",
          reviewer: "codex",
          reason: "Old request already answered.",
          status: "responded",
          createdAt: "2026-05-31T11:00:00.000Z",
          updatedAt: "2026-05-31T11:30:00.000Z",
        },
        {
          id: "review-3",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
          requestedBy: "hermes",
          reviewer: "hermes",
          reason: "Hermes panel response.",
          status: "responded",
          reviewMode: "panel",
          panelId: "panel-1",
          panelSize: 3,
          response: {
            verdict: "pass",
            reasoning: "Hermes sees the checks and rollout notes as sufficient.",
            respondedAt: "2026-05-31T12:05:00.000Z",
          },
          createdAt: "2026-05-31T12:00:00.000Z",
          updatedAt: "2026-05-31T12:05:00.000Z",
        },
      ],
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const card = snap.cards.find((c) => c.id === "agent #548");
    expect(card?.reviewRequests).toEqual([
      {
        id: "review-1",
        requestedBy: "hermes",
        reviewer: "claude",
        reason: "Second-agent review before this moves forward.",
        status: "requested",
        reviewMode: "panel",
        panelId: "panel-1",
        panelSize: 3,
        createdAt: "2026-05-31T12:00:00.000Z",
        updatedAt: "2026-05-31T12:00:00.000Z",
      },
      {
        id: "review-3",
        requestedBy: "hermes",
        reviewer: "hermes",
        reason: "Hermes panel response.",
        status: "responded",
        reviewMode: "panel",
        panelId: "panel-1",
        panelSize: 3,
        response: {
          verdict: "pass",
          reasoning: "Hermes sees the checks and rollout notes as sufficient.",
          respondedAt: "2026-05-31T12:05:00.000Z",
        },
        createdAt: "2026-05-31T12:00:00.000Z",
        updatedAt: "2026-05-31T12:05:00.000Z",
      },
    ]);
  });

  it("attaches real card-scoped Hermes/agent discussion and ignores operator/unrelated messages", () => {
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
          },
        },
      ],
      recent: [],
      collaborationMessages: [
        {
          id: "operator-1",
          ts: Date.parse("2026-06-01T10:00:00.000Z"),
          author: "operator",
          kind: "chat",
          text: "what is happening?",
          addressedTo: "hermes",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
        },
        {
          id: "hermes-1",
          ts: Date.parse("2026-06-01T10:01:00.000Z"),
          author: "hermes",
          kind: "status",
          text: "Contract test X is red.",
          addressedTo: "codex",
          hermesMode: "live",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
        },
        {
          id: "codex-1",
          ts: Date.parse("2026-06-01T10:02:00.000Z"),
          author: "codex",
          kind: "chat",
          text: "Fixing via Y.",
          addressedTo: "hermes",
          relatedPr: { repo: "depre-dev/agent", number: 548 },
        },
        {
          id: "claude-unrelated",
          ts: Date.parse("2026-06-01T10:03:00.000Z"),
          author: "claude",
          kind: "chat",
          text: "Different card.",
          addressedTo: "hermes",
          relatedPr: { repo: "depre-dev/agent", number: 999 },
        },
      ],
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const card = snap.cards.find((c) => c.id === "agent #548");
    expect(card?.discussion).toEqual([
      {
        id: "hermes-1",
        ts: Date.parse("2026-06-01T10:01:00.000Z"),
        author: "hermes",
        kind: "status",
        text: "Contract test X is red.",
        addressedTo: "codex",
        hermesMode: "live",
      },
      {
        id: "codex-1",
        ts: Date.parse("2026-06-01T10:02:00.000Z"),
        author: "codex",
        kind: "chat",
        text: "Fixing via Y.",
        addressedTo: "hermes",
      },
    ]);
  });

  it("promotes a blocked high-risk reviewer panel to needs-attention for the D4 bridge", () => {
    const raw = {
      active: [
        {
          title: "Change settlement deploy path",
          status: "needs_review",
          intent: "operator_review",
          ageLabel: "4m",
          summary: {
            pullRequest: { repo: "depre-dev/agent", number: 601, state: "open" },
            currentPullRequest: { repo: "depre-dev/agent", number: 601, state: "open" },
            finalVerdict: "operator_review",
          },
        },
      ],
      recent: [],
      reviewRequests: [
        {
          id: "review-hermes",
          relatedPr: { repo: "depre-dev/agent", number: 601 },
          requestedBy: "hermes",
          reviewer: "hermes",
          reason: "High-risk reviewer panel.",
          status: "responded",
          reviewMode: "panel",
          panelId: "panel-601",
          panelSize: 3,
          response: {
            verdict: "pass",
            reasoning: "Checks are green.",
            respondedAt: "2026-05-31T12:04:00.000Z",
          },
          createdAt: "2026-05-31T12:00:00.000Z",
          updatedAt: "2026-05-31T12:04:00.000Z",
        },
        {
          id: "review-codex",
          relatedPr: { repo: "depre-dev/agent", number: 601 },
          requestedBy: "hermes",
          reviewer: "codex",
          reason: "High-risk reviewer panel.",
          status: "responded",
          reviewMode: "panel",
          panelId: "panel-601",
          panelSize: 3,
          response: {
            verdict: "block",
            reasoning: "Settlement rollback proof is missing.",
            respondedAt: "2026-05-31T12:05:00.000Z",
          },
          createdAt: "2026-05-31T12:00:00.000Z",
          updatedAt: "2026-05-31T12:05:00.000Z",
        },
        {
          id: "review-claude",
          relatedPr: { repo: "depre-dev/agent", number: 601 },
          requestedBy: "hermes",
          reviewer: "claude",
          reason: "High-risk reviewer panel.",
          status: "requested",
          reviewMode: "panel",
          panelId: "panel-601",
          panelSize: 3,
          createdAt: "2026-05-31T12:00:00.000Z",
          updatedAt: "2026-05-31T12:00:00.000Z",
        },
      ],
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const card = snap.cards.find((c) => c.id === "agent #601");
    expect(card).toMatchObject({
      lane: "needs-attention",
      isAction: true,
      waitingOn: { actor: "operator", tone: "warn" },
    });
    expect(card?.summary).toContain("Codex blocked agent #601");
    expect(card?.riskSignals?.some((signal) => signal.code === "review_panel_blocked")).toBe(true);
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

  it("keeps completed mission runs as mission cards and attaches their report", () => {
    const raw = {
      active: [],
      recent: [],
      testbedMissions: [
        {
          id: "mission-completed-1",
          status: "completed",
          title: "Fresh-agent browser mission",
          targetUrl: "https://app.averray.com",
          createdAt: "2026-06-01T22:01:00.000Z",
          updatedAt: "2026-06-01T22:03:00.000Z",
          statusReason: "gold path completed",
          freshMemory: true,
          allowTestMutations: false,
          result: {
            structuredReport: {
              verdict: "pass",
              confidence: 0.94,
              mode: "gold_path",
              scores: { success: 5, clarity: 4, latency: 4 },
              blockers: [],
              confusingMoments: [],
              mutationBoundaryNotes: ["Read-only mission completed without mutation."],
              stoppedBeforeMutation: true,
              completedPath: ["Loaded app shell", "Opened the work lane"],
              recommendations: ["Keep this as the baseline before changing the page again."],
              evidence: ["trace: /tmp/mission-completed-1/trace.zip"],
            },
          },
        },
      ],
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const mission = snap.cards.find((c) => c.correlationId === "mission-completed-1");
    expect(mission?.lane).toBe("done");
    expect(mission?.type).toBe("mission");
    expect(mission?.missionStatus).toBe("completed");
    expect(mission?.mission?.verdict).toBe("OK");
    expect(mission?.mission?.target).toBe("https://app.averray.com");
    expect(mission?.summary).toBe("PASS · gold-path · 0 blockers");
  });

  it("names Hermes as working now for a running mission backed by a mission run", () => {
    const raw = {
      active: [
        {
          correlationId: "mission-running-1",
          repo: "testbed/mission",
          intent: "testbed_agent_mission",
          title: "Verify settings flow mission",
          summary: { kind: "testbed_mission_run" },
        },
      ],
      recent: [],
      testbedMissions: [
        {
          id: "mission-running-1",
          status: "running",
          runnerId: "hermes-browser-runner",
          targetUrl: "https://staging.averray.com/settings",
          startedAt: "2026-05-31T10:01:00.000Z",
        },
      ],
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const mission = snap.cards.find((c) => c.correlationId === "mission-running-1");
    expect(mission?.workingNow).toEqual({
      agent: "hermes",
      label: "Hermes reviewing",
      source: "mission",
      taskId: "mission-running-1",
      runnerId: "hermes-browser-runner",
      since: "2026-05-31T10:01:00.000Z",
    });
  });

  it("surfaces requested tester missions as board-gated operator approvals", () => {
    const raw = {
      active: [],
      recent: [],
      testbedMissions: [
        {
          schemaVersion: 1,
          kind: "testbed_mission_run",
          id: "testbed-mission-requested-1",
          status: "requested",
          title: "Tester run requested",
          targetUrl: "https://staging.averray.com/onboarding",
          goal: "check onboarding",
          agentName: "Hermes",
          requesterAgent: "codex",
          freshMemory: true,
          allowTestMutations: false,
          mission: {},
          history: [],
          createdAt: "2026-05-31T10:00:00.000Z",
          updatedAt: "2026-05-31T10:00:00.000Z",
          statusReason: "Tester run requested by codex; it has not started and remains board-gated until the operator approves it.",
        },
      ],
      generatedAt: "2026-05-31T10:02:00.000Z",
    };

    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent", now: () => new Date("2026-05-31T10:02:00.000Z") });
    const mission = snap.cards.find((c) => c.type === "mission");

    expect(mission).toMatchObject({
      title: "Tester run requested",
      lane: "operator-review",
      waitingOn: { actor: "operator" },
      verdict: "Tester run requested",
      missionStatus: "requested",
      summary: expect.stringContaining("not started"),
    });
    expect(mission?.mission).toBeUndefined();
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
      { n: 1, status: "ok", desc: "Loaded onboarding page" },
      { n: 2, status: "ok", desc: "Clicked Connect wallet" },
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
    expect(m.path[0]).not.toHaveProperty("lat");
    expect(m.blockers[0]).not.toHaveProperty("body");
  });

  it("maps real mission step latencies, blocker body, run count, and total latency when reported", () => {
    const m = mapMissionReport({
      ...run,
      result: {
        verdict: "partial",
        confidence: 0.81,
        scores: { success: 4 },
        blockers: [{ head: "Sign-message modal latency", body: "The modal stayed pending for 4.2s." }],
        confusingMoments: [],
        mutationBoundaryNotes: ["No transactions submitted"],
        stoppedBeforeMutation: true,
        completedPath: [
          { desc: "Loaded onboarding page", latencyMs: 180 },
          { desc: "Clicked Connect wallet", durationMs: 4200 },
        ],
        recommendations: [],
        evidence: ["trace: browser-trace"],
        runs: 2,
        durationMs: 4380,
      },
    })!;

    expect(m.path).toEqual([
      { n: 1, status: "ok", desc: "Loaded onboarding page", lat: "180ms" },
      { n: 2, status: "ok", desc: "Clicked Connect wallet", lat: "4.2s" },
    ]);
    expect(m.blockers).toEqual([
      { head: "Sign-message modal latency", body: "The modal stayed pending for 4.2s." },
    ]);
    expect(m.runs).toBe(2);
    expect(m.latency).toBe("4.38s");
  });

  it("returns undefined when the run has no result yet (mission still running)", () => {
    expect(mapMissionReport({ id: "m", targetUrl: "https://x.test" })).toBeUndefined();
  });
});

describe("synthesizeTaskCards (O3 — surface queued tasks)", () => {
  const proposedClaude = {
    id: "claude-task-x1",
    status: "proposed",
    agent: "claude",
    repo: "averray-agent/agent",
    title: "Add a HEALTHCHECK.md",
    prompt: "Add a top-level HEALTHCHECK.md.",
    reason: "operator delegated",
  };

  it("surfaces a proposed greenfield task as a codex-needed card with its agent + status", () => {
    const decisionRecord = createHermesDecisionRecord({
      kind: "routing",
      subject: { type: "task", id: "claude-task-x1", repo: "averray-agent/agent" },
      decision: "routed to claude",
      reasons: ["Claude had the strongest UI evidence."],
      outcome: { summary: "Task proposed." },
      safety: { readOnly: true, mutates: false },
      generatedAt: "2026-05-31T12:00:00.000Z",
    });
    const events = [
      { at: "2026-05-31T12:00:00.000Z", status: "proposed", message: "Hermes proposed a bounded Claude task." },
    ];
    const [card, ...rest] = synthesizeTaskCards({
      codexTasks: { items: [{ ...proposedClaude, decisionRecord, events }] },
    }, undefined);
    expect(rest).toHaveLength(0);
    expect(card).toMatchObject({
      id: "claude-task-x1",
      lane: "codex-needed",
      type: "task",
      agentType: "claude",
      taskStatus: "proposed",
      repo: "averray-agent/agent",
      prompt: "Add a top-level HEALTHCHECK.md.",
      decisionRecord: {
        kind: "routing",
        decision: "routed to claude",
      },
    });
    expect(card?.taskEvents).toEqual(events);
    // proposed → waiting on the operator to approve
    expect(card?.waitingOn).toEqual({ actor: "operator", tone: "warn" });
  });

  it("names the active runner on an in-flight task card only when heartbeat matches", () => {
    const [card] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "running-claude-task",
            status: "running",
            agent: "claude",
            repo: "a/b",
            prompt: "x",
            startedAt: "2026-05-31T11:55:00.000Z",
            workingNow: {
              agent: "claude",
              runnerId: "claude-task-runner",
              label: "Claude fixing",
              since: "2026-05-31T11:55:00.000Z",
            },
          }],
        },
      },
      {
        status: "running",
        runnerId: "claude-task-runner",
        activeTaskId: "running-claude-task",
        updatedAt: "2026-05-31T12:00:00.000Z",
      },
      { now: new Date("2026-05-31T12:00:00.000Z") },
    );

    expect(card).toMatchObject({
      id: "running-claude-task",
      state: "running",
      workingNow: {
        agent: "claude",
        label: "Claude fixing",
        source: "runner",
        taskId: "running-claude-task",
        runnerId: "claude-task-runner",
      },
    });

    const [mismatched] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "running-claude-task",
            status: "running",
            agent: "claude",
            repo: "a/b",
            prompt: "x",
            startedAt: "2026-05-31T11:55:00.000Z",
          }],
        },
      },
      {
        status: "running",
        runnerId: "claude-task-runner",
        activeTaskId: "other-task",
        updatedAt: "2026-05-31T12:00:00.000Z",
      },
      { now: new Date("2026-05-31T12:00:00.000Z") },
    );
    expect(mismatched?.workingNow).toBeUndefined();
  });

  it("skips PR-bound tasks (they surface via their PR card) and terminal tasks", () => {
    const cards = synthesizeTaskCards(
      {
        codexTasks: {
          items: [
            { id: "a", status: "proposed", agent: "codex", repo: "a/b", pullRequestNumber: 5, prompt: "x" },
            { id: "b", status: "completed", agent: "claude", repo: "a/b", prompt: "x" },
            { id: "c", status: "cancelled", agent: "claude", repo: "a/b", prompt: "x" },
          ],
        },
      },
      undefined,
    );
    expect(cards).toHaveLength(0);
  });

  it("defaults a missing agent to codex and tolerates an absent task list", () => {
    const [card] = synthesizeTaskCards({ codexTasks: { items: [{ id: "z", status: "approved", repo: "a/b", prompt: "x" }] } }, undefined);
    expect(card?.agentType).toBe("codex");
    expect(card?.taskStatus).toBe("approved");
    expect(synthesizeTaskCards({}, undefined)).toEqual([]);
    expect(synthesizeTaskCards(undefined, undefined)).toEqual([]);
  });

  it("surfaces test-writer task cards with specialist attribution", () => {
    const [card] = synthesizeTaskCards({
      codexTasks: {
        items: [{
          id: "test-writer-task-x1",
          status: "proposed",
          agent: "test-writer",
          repo: "a/b",
          prompt: "add parser tests",
        }],
      },
    }, undefined);

    expect(card).toMatchObject({
      id: "test-writer-task-x1",
      agentType: "test-writer",
      title: "test-writer task",
      taskStatus: "proposed",
    });
  });

  it("hides operator-dismissed task cards across reloads", () => {
    const cards = synthesizeTaskCards({
      codexTasks: {
        items: [{
          ...proposedClaude,
          operatorDismissedAt: "2026-05-31T11:55:00.000Z",
          operatorDismissedBy: "operator",
        }],
      },
    }, undefined, { now: new Date("2026-05-31T12:00:00.000Z") });

    expect(cards).toEqual([]);
  });

  it("hides snoozed task cards until the snooze timestamp expires", () => {
    const raw = {
      codexTasks: {
        items: [{
          ...proposedClaude,
          operatorSnoozedUntil: "2026-05-31T12:30:00.000Z",
          operatorSnoozedBy: "operator",
        }],
      },
    };

    expect(synthesizeTaskCards(raw, undefined, { now: new Date("2026-05-31T12:00:00.000Z") })).toEqual([]);
    expect(synthesizeTaskCards(raw, undefined, { now: new Date("2026-05-31T12:31:00.000Z") })[0]).toMatchObject({
      id: "claude-task-x1",
      taskStatus: "proposed",
    });
  });

  it("humanizes persisted self-healing titles so the doubled surface namespace doesn't leak", () => {
    const [card] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "self-heal-x1",
            status: "proposed",
            agent: "claude",
            repo: "a/b",
            prompt: "fix it",
            // Stored by an older build: "testbed:" namespace doubled with the
            // "testbed-mission-…" key. The board must present it cleanly.
            title: "Self-healing fix: testbed:testbed-mission-mpmo4ff2-1",
          }],
        },
      },
      undefined,
    );
    expect(card?.title).toBe("Self-healing fix: testbed-mission-mpmo4ff2-1");
    expect(card?.title).not.toContain("testbed:testbed");
  });

  it("promotes failed greenfield tasks to needs-attention with retry context", () => {
    const [card] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "failed-task",
            status: "failed",
            agent: "codex",
            repo: "a/b",
            prompt: "x",
            attemptCount: 2,
            failedAt: "2026-05-31T11:45:00.000Z",
            updatedAt: "2026-05-31T11:45:00.000Z",
            failureReason: "tests failed",
          }],
        },
      },
      { status: "idle", updatedAt: "2026-05-31T11:59:30.000Z" },
      { now: new Date("2026-05-31T12:00:00.000Z") },
    );

    expect(card).toMatchObject({
      id: "failed-task",
      lane: "needs-attention",
      isAction: true,
      state: "stale",
      waitingOn: { actor: "operator", tone: "warn" },
      risk: ["workflow"],
      freshness: 15,
      riskSignals: [
        {
          severity: "high",
          code: "task_failed_repeatedly",
        },
      ],
    });
    expect(card?.summary).toContain("failed after 2 runner attempt");
    expect(card?.riskSignals?.[0]?.message).toContain("tests failed");
  });

  it("keeps failed tasks with a scheduled O5 retry out of action-needed until backoff expires", () => {
    const [card] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "failed-waiting-retry",
            status: "failed",
            agent: "codex",
            repo: "a/b",
            prompt: "x",
            attemptCount: 1,
            failedAt: "2026-05-31T11:55:00.000Z",
            updatedAt: "2026-05-31T11:55:00.000Z",
            retryAfter: "2026-05-31T12:05:00.000Z",
          }],
        },
      },
      { status: "idle", updatedAt: "2026-05-31T11:59:30.000Z" },
      { now: new Date("2026-05-31T12:00:00.000Z") },
    );

    expect(card).toMatchObject({
      id: "failed-waiting-retry",
      lane: "codex-needed",
      waitingOn: { actor: "agent", tone: "info" },
      risk: [],
    });
    expect(card?.isAction).toBeUndefined();
    expect(card?.summary).toContain("scheduled a bounded retry in 5m");
  });

  it("promotes stale approved tasks when no runner can claim them", () => {
    const [card] = synthesizeTaskCards(
      {
        codexTasks: {
          items: [{
            id: "approved-stale",
            status: "approved",
            agent: "claude",
            repo: "a/b",
            prompt: "x",
            approvedAt: "2026-05-31T11:00:00.000Z",
            updatedAt: "2026-05-31T11:00:00.000Z",
          }],
        },
      },
      { status: "misconfigured", updatedAt: "2026-05-31T11:59:50.000Z" },
      { now: new Date("2026-05-31T12:00:00.000Z") },
    );

    expect(card).toMatchObject({
      lane: "needs-attention",
      state: "source-offline",
      agentType: "claude",
      sourceFailure: {
        source: "runner",
        code: "MISCONFIGURED",
        message: "runner is misconfigured",
        lastGoodAt: "2026-05-31T11:59:50.000Z",
      },
      riskSignals: [
        {
          severity: "high",
          code: "runner_unavailable_for_approved_task",
        },
      ],
    });
    expect(card?.summary).toContain("runner is misconfigured");
  });

  it("promotes running tasks with stale progress or mismatched heartbeat", () => {
    const health = taskHealthForBoard(
      {
        id: "running-stale",
        status: "running",
        progressAt: "2026-05-31T11:35:00.000Z",
        updatedAt: "2026-05-31T11:35:00.000Z",
      },
      { status: "running", activeTaskId: "other-task", updatedAt: "2026-05-31T11:59:50.000Z" },
      new Date("2026-05-31T12:00:00.000Z"),
    );

    expect(health).toMatchObject({
      lane: "needs-attention",
      state: "stale",
      isAction: true,
      riskSignal: {
        severity: "high",
        code: "runner_active_task_mismatch",
      },
    });
  });

  it("buildV2BoardSnapshot appends synthesized task cards", () => {
    const snap = buildV2BoardSnapshot({ active: [], recent: [], codexTasks: { items: [proposedClaude] } }, { repo: "averray-agent/agent" });
    const task = snap.cards.find((c) => c.id === "claude-task-x1");
    expect(task?.type).toBe("task");
    expect(task?.taskStatus).toBe("proposed");
    expect(snap.automationHealth).toMatchObject({
      selfHealingOpen: 0,
      dispatchPerDayCap: 10,
    });
  });

  it("derives a quiet automation-health gauge from real task queue capacity", () => {
    const raw = {
      codexTasks: {
        items: [
          {
            id: "self-heal-open",
            status: "proposed",
            requester: "hermes-self-healing",
            createdAt: "2026-06-01T09:00:00.000Z",
          },
          {
            id: "self-heal-done",
            status: "completed",
            requester: "hermes-self-healing",
            createdAt: "2026-06-01T08:00:00.000Z",
          },
          {
            id: "hermes-proposed",
            status: "proposed",
            requester: "hermes",
            createdAt: "2026-06-01T07:00:00.000Z",
          },
          {
            id: "o5-approved",
            status: "approved",
            approvedBy: "o5-self-management",
            createdAt: "2026-06-01T06:00:00.000Z",
          },
          {
            id: "operator-task",
            status: "proposed",
            requester: "operator",
            createdAt: "2026-06-01T05:00:00.000Z",
          },
          {
            id: "old-hermes-task",
            status: "proposed",
            requester: "hermes",
            createdAt: "2026-05-31T23:00:00.000Z",
          },
        ],
      },
    };

    expect(automationHealthForBoard(raw, new Date("2026-06-01T12:00:00.000Z"), {
      HERMES_DISPATCH_PER_DAY_MAX: "5",
    })).toEqual({
      selfHealingOpen: 1,
      dispatchUsedToday: 4,
      dispatchPerDayCap: 5,
      quietSignalCount: 0,
      selfHealingCapacitySignals: 0,
      taskHealthCapacitySignals: 0,
    });
  });

  it("dedupes self-healing handoff cards when an actionable task exists for the same correlation", () => {
    const correlationId = "self-heal:testbed:failed-mission";
    const snap = buildV2BoardSnapshot(
      {
        active: [{
          title: "Self-healing: failed browser mission",
          status: "failed",
          intent: "self_healing",
          reason: "dispatch_budget_exhausted",
          correlationId,
          ageLabel: "1m",
        }],
        recent: [],
        codexTasks: {
          items: [{
            id: "codex-task-self-heal-1",
            status: "proposed",
            agent: "codex",
            repo: "depre-dev/averray-reference-agent",
            title: "Self-healing: failed browser mission",
            prompt: "Investigate and propose the smallest fix.",
            correlationId,
            reason: "routed_fix",
          }],
        },
      },
      { repo: "depre-dev/averray-reference-agent" },
    );

    const correlated = snap.cards.filter((card) => card.correlationId === correlationId);
    expect(correlated).toHaveLength(1);
    expect(correlated[0]).toMatchObject({
      id: "codex-task-self-heal-1",
      type: "task",
      taskStatus: "proposed",
      waitingOn: { actor: "operator", tone: "warn" },
    });
  });

  it("does not render self-healing capacity handoff events as cards", () => {
    const snap = buildV2BoardSnapshot(
      {
        active: [{
          title: "Self-healing cap reached",
          status: "needs_review",
          intent: "self_healing",
          reason: "Escalated to operator: open_fix_cap_reached",
          correlationId: "self-heal:testbed:overview",
          ageLabel: "1m",
          summary: { kind: "self_healing", action: "escalate" },
        }],
        recent: [],
      },
      { repo: "depre-dev/averray-reference-agent" },
    );

    expect(snap.cards).toEqual([]);
    expect(snap.automationHealth).toMatchObject({
      quietSignalCount: 1,
      selfHealingCapacitySignals: 1,
      taskHealthCapacitySignals: 0,
    });
  });

  it("does not synthesize task-health capacity escalations as board cards", () => {
    const snap = buildV2BoardSnapshot(
      {
        active: [],
        recent: [],
        codexTasks: {
          items: [{
            id: "codex-task-retry-exhausted",
            status: "failed",
            agent: "codex",
            repo: "depre-dev/averray-reference-agent",
            title: "Retry exhausted",
            prompt: "Investigate this task.",
            selfManagementEscalatedAt: "2026-06-01T09:58:00.000Z",
            selfManagementEscalationReason: "retry_budget_exhausted",
            updatedAt: "2026-06-01T09:58:00.000Z",
          }],
        },
      },
      { repo: "depre-dev/averray-reference-agent" },
    );

    expect(snap.cards).toEqual([]);
    expect(snap.automationHealth).toMatchObject({
      quietSignalCount: 1,
      selfHealingCapacitySignals: 0,
      taskHealthCapacitySignals: 1,
    });
  });

  it("still renders ordinary failed tasks that need operator triage", () => {
    const snap = buildV2BoardSnapshot(
      {
        active: [],
        recent: [],
        codexTasks: {
          items: [{
            id: "codex-task-real-failure",
            status: "failed",
            agent: "codex",
            repo: "depre-dev/averray-reference-agent",
            title: "Real failed task",
            prompt: "Investigate this task.",
            failureReason: "Claude work failed on a code change.",
            updatedAt: "2026-06-01T09:58:00.000Z",
          }],
        },
      },
      { repo: "depre-dev/averray-reference-agent" },
    );

    expect(snap.cards).toHaveLength(1);
    expect(snap.cards[0]).toMatchObject({
      id: "codex-task-real-failure",
      lane: "needs-attention",
      type: "task",
    });
    expect(snap.automationHealth).toMatchObject({
      quietSignalCount: 0,
      selfHealingCapacitySignals: 0,
      taskHealthCapacitySignals: 0,
    });
  });

  it("collapses a failed testbed mission and its self-healing task into one actionable card", () => {
    const missionId = "testbed-mission-failed-1";
    const snap = buildV2BoardSnapshot(
      {
        active: [],
        recent: [],
        testbedMissions: [{
          schemaVersion: 1,
          kind: "testbed_mission_run",
          id: missionId,
          status: "failed",
          title: "Fresh-agent browser mission",
          targetUrl: "https://averray.com/",
          goal: "Test the main flow like a new outside agent.",
          agentName: "Hermes",
          freshMemory: true,
          allowTestMutations: false,
          createdAt: "2026-06-01T10:00:00.000Z",
          updatedAt: "2026-06-01T10:05:00.000Z",
          failedAt: "2026-06-01T10:05:00.000Z",
          statusReason: "Browser-agent report returned fail.",
          failureReason: "Browser-agent report returned fail.",
          result: {
            verdict: "fail",
            confidence: 0.4,
            stoppedBeforeMutation: true,
            blockers: ["primary action unclear"],
            confusingMoments: [],
            evidence: [],
            scores: {},
            recommendations: [],
          },
        }],
        codexTasks: {
          items: [{
            id: "codex-task-self-heal-averray",
            status: "proposed",
            agent: "codex",
            repo: "depre-dev/averray-reference-agent",
            title: "Self-healing fix: testbed:averray.com",
            prompt: "Investigate the failed mission and propose the smallest fix.",
            requester: "hermes-self-healing",
            correlationId: "self-heal:testbed_mission:testbed:averray.com",
            reason: "Hermes self-healing proposal for a testbed_mission failure",
          }],
        },
      },
      { repo: "depre-dev/averray-reference-agent", now: () => new Date("2026-06-01T10:06:00.000Z") },
    );

    expect(snap.cards).toHaveLength(1);
    expect(snap.cards[0]).toMatchObject({
      id: "codex-task-self-heal-averray",
      lane: "codex-needed",
      type: "task",
      taskStatus: "proposed",
      waitingOn: { actor: "operator", tone: "warn" },
    });
  });

  it("surfaces a failed testbed mission as operator-waiting triage, not agent work", () => {
    const missionId = "testbed-mission-surface-sweep-1";
    const snap = buildV2BoardSnapshot(
      {
        active: [],
        recent: [],
        testbedMissions: [{
          schemaVersion: 1,
          kind: "testbed_mission_run",
          id: missionId,
          status: "failed",
          title: "Surface sweep (T1)",
          targetUrl: "https://averray.com/",
          goal: "Sweep the public surface.",
          agentName: "Hermes",
          freshMemory: true,
          allowTestMutations: false,
          createdAt: "2026-06-01T10:00:00.000Z",
          updatedAt: "2026-06-01T10:05:00.000Z",
          failedAt: "2026-06-01T10:05:00.000Z",
          statusReason: "Browser-agent report returned fail.",
          failureReason: "Browser-agent report returned fail.",
          result: {
            verdict: "fail",
            confidence: 0.4,
            stoppedBeforeMutation: true,
            blockers: ["primary action unclear"],
            confusingMoments: [],
            evidence: [],
            scores: {},
            recommendations: ["Fix the visible call to action, then rerun the mission."],
          },
        }],
        codexTasks: { items: [] },
      },
      { repo: "depre-dev/averray-reference-agent", now: () => new Date("2026-06-01T10:06:00.000Z") },
    );

    expect(snap.cards).toHaveLength(1);
    expect(snap.cards[0]).toMatchObject({
      lane: "needs-attention",
      type: "mission",
      missionStatus: "failed",
      waitingOn: { actor: "operator", tone: "warn" },
      isAction: true,
    });
    expect(snap.cards.some((card) => card.type === "task")).toBe(false);
  });
});

describe("enrichBoardCard — task status", () => {
  it("carries the task lifecycle status onto a task card", () => {
    const base = toBoardCard(slim({ lane: "Codex needed", owner: "Hermes", title: "Reduce log noise" }));
    expect(base.type).toBe("task");
    const enriched = enrichBoardCard(base, slim({ lane: "Codex needed" }), {
      codexTask: { status: "approved", prompt: "do it" },
    });
    expect(enriched.taskStatus).toBe("approved");
  });
});

describe("diffBoardSnapshots", () => {
  function card(overrides: Partial<BoardCard> = {}): BoardCard {
    return {
      id: "agent #548",
      lane: "codex-needed",
      type: "pr",
      agentType: "codex",
      title: "Fix failing workflow",
      summary: "CI is still running.",
      repo: "depre-dev/agent",
      freshness: 1,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      ...overrides,
    };
  }

  function snapshot(cards: BoardCard[], at: string) {
    return {
      cards,
      at,
      repo: "depre-dev/agent",
      llmUsage: {
        status: "not_recorded",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: null,
        costStatus: "not_recorded",
        runs: 0,
        byModel: [],
        byDay: [],
      },
    };
  }

  it("emits a moved event with the full fresh card when the lane changes", () => {
    const previous = snapshot([card({ lane: "codex-needed", summary: "Fix assigned." })], "2026-06-01T10:00:00Z");
    const nextCard = card({
      lane: "hermes-checking",
      summary: "Fix returned; Hermes is re-reviewing the current head.",
      freshness: 0,
      checks: { total: 5, pass: 5, fail: 0, running: 0, pending: 0 },
    });
    const next = snapshot([nextCard], "2026-06-01T10:00:02Z");

    expect(diffBoardSnapshots(previous, next)).toEqual([
      {
        type: "board.card.moved",
        id: "agent #548",
        fromLane: "codex-needed",
        toLane: "hermes-checking",
        card: nextCard,
        at: "2026-06-01T10:00:02Z",
      },
    ]);
  });

  it("emits add/update/archive events from real snapshot differences", () => {
    const previous = snapshot([
      card({ id: "agent #1", summary: "old" }),
      card({ id: "agent #2", lane: "operator-review" }),
    ], "2026-06-01T10:00:00Z");
    const updated = card({ id: "agent #1", summary: "new evidence arrived" });
    const added = card({ id: "agent #3", lane: "release-queue" });
    const next = snapshot([updated, added], "2026-06-01T10:00:02Z");

    expect(diffBoardSnapshots(previous, next)).toEqual([
      { type: "board.card.archived", id: "agent #2", fromLane: "operator-review", at: "2026-06-01T10:00:02Z" },
      { type: "board.card.updated", id: "agent #1", partial: updated, card: updated, at: "2026-06-01T10:00:02Z" },
      { type: "board.card.added", card: added, at: "2026-06-01T10:00:02Z" },
    ]);
  });
});
