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

  it("asserts when the injected classifier violates the routing taxonomy", () => {
    expect(() => planAndRouteWork(input({
      backlog: [item("Escrow settlement proof", "chain/settlement", "Verify invariants")],
      classify: () => ({ agent: "claude", riskTier: "low", reason: "wrong agent" }),
    }))).toThrow(/routing_taxonomy_violation/);
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
