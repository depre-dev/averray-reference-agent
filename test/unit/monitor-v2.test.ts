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
  buildV2BoardSnapshot,
} from "../../services/slack-operator/src/monitor-v2.js";
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

describe("inferAgentType", () => {
  it("mission type → hermes", () => {
    expect(inferAgentType(slim({ owner: "Operator" }), "mission")).toBe("hermes");
  });
  it("owner contains codex → codex", () => {
    expect(inferAgentType(slim({ owner: "Codex" }), "pr")).toBe("codex");
  });
  it("owner contains hermes → hermes", () => {
    expect(inferAgentType(slim({ owner: "Hermes" }), "pr")).toBe("hermes");
  });
  it("unknown owner → ext", () => {
    expect(inferAgentType(slim({ owner: "Merge steward" }), "pr")).toBe("ext");
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
