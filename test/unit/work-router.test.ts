import { describe, expect, it, vi } from "vitest";

import type { RoutingInput } from "../../packages/averray-mcp/src/dispatch-routing.js";
import {
  planAndRouteWork,
  type PlanAndRouteWorkInput,
  type WorkRouterBacklogItem,
  type WorkRouterClassifier,
  type WorkRouterPolicySnapshot,
} from "../../packages/averray-mcp/src/work-router.js";

const POLICY: WorkRouterPolicySnapshot = {
  allowedRepos: ["depre-dev/averray-reference-agent"],
  allowedAgents: ["codex", "claude"],
  perDayMax: 10,
  perRepoPerDayMax: 5,
  todayCount: 0,
  todayRepoCounts: {},
};

const classify: WorkRouterClassifier = (input: RoutingInput) => {
  const haystack = [input.area, input.prompt, input.repo, ...(input.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/chain|settlement|escrow|contract|polkadot/.test(haystack)) {
    return { agent: "codex", riskTier: "high", reason: "chain/settlement taxonomy -> codex" };
  }
  return { agent: "claude", riskTier: "low", reason: "UI/docs taxonomy -> claude" };
};

describe("planAndRouteWork", () => {
  it("routes chain/settlement gaps to Codex and UI gaps to Claude with rationales", () => {
    const proposals = planAndRouteWork(input({
      backlog: [
        item("Escrow settlement proof", "chain/settlement", "Verify escrow settlement invariants"),
        item("Monitor drawer polish", "ui", "Tighten the running mission drawer"),
      ],
    }));

    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      repo: "depre-dev/averray-reference-agent",
      surface: "chain/settlement",
      agent: "codex",
      riskTier: "high",
      why: "Fills uncovered backlog gap: Escrow settlement proof.",
      whyAgent: "chain/settlement taxonomy -> codex",
    });
    expect(proposals[1]).toMatchObject({
      surface: "ui",
      agent: "claude",
      riskTier: "low",
      whyAgent: "UI/docs taxonomy -> claude",
    });
    expect(proposals.every((proposal) => proposal.dedupeKey.length > 0 && proposal.taskPrompt.length > 0)).toBe(true);
  });

  it("keeps hard taxonomy authoritative when the classifier or learned memory disagrees", () => {
    const proposals = planAndRouteWork(input({
      backlog: [item("Escrow settlement proof", "chain/settlement", "Verify invariants")],
      classify: () => ({ agent: "claude", riskTier: "low", reason: "wrong agent" }),
      routingScores: {
        "chain/settlement": {
          claude: { status: "baseline_available", score: 99, samples: 4 },
          codex: { status: "baseline_available", score: 10, samples: 4 },
        },
      },
    }));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      surface: "chain/settlement",
      agent: "codex",
    });
    expect(proposals[0]?.whyAgent).toContain("Hard taxonomy kept chain/settlement with codex");
  });

  it("does not re-propose gaps covered by in-flight or recently-done tasks", () => {
    const proposals = planAndRouteWork(input({
      backlog: [
        item("Monitor drawer polish", "ui", "Tighten the running mission drawer"),
        item("Docs quickstart copy", "docs", "Improve quickstart wording"),
        item("Escrow settlement proof", "chain/settlement", "Verify escrow settlement invariants"),
      ],
      inFlight: [{
        repo: "depre-dev/averray-reference-agent",
        status: "running",
        surface: "ui",
        title: "Monitor drawer polish",
      }],
      recentlyDone: [{
        repo: "depre-dev/averray-reference-agent",
        status: "completed",
        surface: "docs",
        title: "Docs quickstart copy",
      }],
    }));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ surface: "chain/settlement", agent: "codex" });
  });

  it("drops proposals beyond global budget, per-repo cap, and allowlists", () => {
    expect(planAndRouteWork(input({
      backlog: [item("Monitor drawer polish", "ui", "Tighten drawer")],
      policy: { ...POLICY, perDayMax: 1, todayCount: 1 },
    }))).toEqual([]);

    expect(planAndRouteWork(input({
      backlog: [item("Monitor drawer polish", "ui", "Tighten drawer")],
      policy: { ...POLICY, perRepoPerDayMax: 1, todayRepoCounts: { "depre-dev/averray-reference-agent": 1 } },
    }))).toEqual([]);

    expect(planAndRouteWork(input({
      backlog: [item("Monitor drawer polish", "ui", "Tighten drawer")],
      policy: { ...POLICY, allowedRepos: ["other/repo"] },
    }))).toEqual([]);

    expect(planAndRouteWork(input({
      backlog: [item("Monitor drawer polish", "ui", "Tighten drawer")],
      policy: { ...POLICY, allowedAgents: ["codex"] },
    }))).toEqual([]);
  });

  it("prefers the higher learned score on soft surfaces only", () => {
    const proposals = planAndRouteWork(input({
      backlog: [item("Ops hygiene", "ops hygiene", "Tighten the routine guard")],
      routingScores: {
        "ops hygiene": {
          codex: { status: "baseline_available", score: 88, samples: 3 },
          claude: { status: "baseline_available", score: 42, samples: 3 },
        },
      },
    }));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      surface: "ops hygiene",
      agent: "codex",
    });
    expect(proposals[0]?.whyAgent).toContain("Learned routing preferred codex");
  });

  it("falls back to static routing when learned surface data is sparse", () => {
    const proposals = planAndRouteWork(input({
      backlog: [item("Ops hygiene", "ops hygiene", "Tighten the routine guard")],
      routingScores: {
        "ops hygiene": {
          codex: { status: "baseline_available", score: 88, samples: 3 },
          claude: { status: "insufficient_data", score: null, samples: 1 },
        },
      },
    }));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      surface: "ops hygiene",
      agent: "claude",
    });
    expect(proposals[0]?.whyAgent).toContain("insufficient ops hygiene data");
  });

  it("does not route around dispatch policy when learned memory picks a blocked agent", () => {
    const proposals = planAndRouteWork(input({
      backlog: [item("Ops hygiene", "ops hygiene", "Tighten the routine guard")],
      policy: { ...POLICY, allowedAgents: ["claude"] },
      routingScores: {
        "ops hygiene": {
          codex: { status: "baseline_available", score: 88, samples: 3 },
          claude: { status: "baseline_available", score: 42, samples: 3 },
        },
      },
    }));

    expect(proposals).toEqual([]);
  });

  it("returns an empty array when there are no real gaps", () => {
    const backlog = [item("Monitor drawer polish", "ui", "Tighten the running mission drawer")];
    const proposals = planAndRouteWork(input({
      backlog,
      inFlight: [{
        repo: "depre-dev/averray-reference-agent",
        status: "approved",
        surface: "ui",
        title: "Monitor drawer polish",
      }],
    }));

    expect(proposals).toEqual([]);
  });

  it("caps proposals to maxProposals deterministically", () => {
    const proposals = planAndRouteWork(input({
      backlog: [
        item("Monitor drawer polish", "ui", "Tighten drawer"),
        item("Docs quickstart copy", "docs", "Improve wording"),
        item("Board filter labels", "ui", "Clarify filters"),
      ],
      maxProposals: 2,
    }));

    expect(proposals.map((proposal) => proposal.surface)).toEqual(["ui", "docs"]);
    expect(proposals).toHaveLength(2);
  });

  it("is pure for the same injected inputs", () => {
    const classifier = vi.fn(classify);
    const routeInput = input({
      backlog: [
        item("Monitor drawer polish", "ui", "Tighten drawer"),
        item("Escrow settlement proof", "chain/settlement", "Verify invariants"),
      ],
      classify: classifier,
    });

    const first = planAndRouteWork(routeInput);
    const second = planAndRouteWork(routeInput);

    expect(second).toEqual(first);
    expect(classifier).toHaveBeenCalledTimes(4);
  });
});

describe("planAndRouteWork — Hermes soft-surface agent suggestion (B)", () => {
  // "Soft" = surfaces the hard taxonomy pins to NEITHER agent (not chain/settlement/etc.
  // → codex, not ui/docs/monitor/board → claude). Hermes may pick the agent only there.
  it("honors Hermes's suggested agent on a residual soft surface, above classifier/learned routing", () => {
    const proposals = planAndRouteWork(input({
      backlog: [{ ...item("Add retry-path coverage", "test-coverage", "Cover the EACCES retry"), suggestedAgent: "codex" }],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.agent).toBe("codex"); // classifier defaulted claude; Hermes's suggestion wins on the soft surface
    expect(proposals[0]!.whyAgent).toContain("Hermes suggested codex");
    expect(proposals[0]!.whyAgent).toContain("leaned claude"); // transparency: notes the divergence
  });

  it("lets the hard taxonomy override Hermes's suggestion on a dangerous surface", () => {
    const proposals = planAndRouteWork(input({
      backlog: [{ ...item("Escrow settlement proof", "chain/settlement", "Verify invariants"), suggestedAgent: "claude" }],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.agent).toBe("codex"); // hard taxonomy forces codex despite the claude suggestion
    expect(proposals[0]!.whyAgent).not.toContain("Hermes suggested"); // suggestion ignored on the hard surface
  });

  it("now lets Hermes override the agent on ui/docs (a soft default, no longer a hard pin)", () => {
    const proposals = planAndRouteWork(input({
      backlog: [{ ...item("Restructure the drawer internals", "ui", "Refactor drawer internals"), suggestedAgent: "codex" }],
    }));
    expect(proposals[0]!.agent).toBe("codex"); // ui defaults to claude but Hermes's suggestion wins
    expect(proposals[0]!.whyAgent).toContain("Hermes suggested codex");
  });

  it("keeps dangerous surfaces (deploy/secrets/migrations) walled to Codex despite a claude suggestion", () => {
    for (const surface of ["deploy verification", "secret rotation", "db migration"]) {
      const proposals = planAndRouteWork(input({
        backlog: [{ ...item(`Handle ${surface}`, surface, "do it"), suggestedAgent: "claude" }],
      }));
      expect(proposals[0]!.agent).toBe("codex");
      expect(proposals[0]!.whyAgent).not.toContain("Hermes suggested");
    }
  });

  it("falls back to classifier/learned routing when no agent is suggested (soft surface)", () => {
    const proposals = planAndRouteWork(input({
      backlog: [item("Add retry-path coverage", "test-coverage", "Cover the EACCES retry")],
    }));
    expect(proposals[0]!.agent).toBe("claude");
    expect(proposals[0]!.whyAgent).not.toContain("Hermes suggested");
  });
});

function input(overrides: Partial<PlanAndRouteWorkInput> = {}): PlanAndRouteWorkInput {
  return {
    backlog: [],
    inFlight: [],
    recentlyDone: [],
    policy: POLICY,
    classify,
    ...overrides,
  };
}

function item(title: string, surface: string, description: string): WorkRouterBacklogItem {
  return {
    repo: "depre-dev/averray-reference-agent",
    title,
    surface,
    shortDescription: description,
    prompt: `Build ${title}: ${description}`,
  };
}
