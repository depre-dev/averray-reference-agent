import { describe, expect, test } from "vitest";

import { doorJourneys } from "./arrivals-view.js";
import type { ArrivalOperatorView } from "./product-health.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function view(over: Partial<ArrivalOperatorView["doors"]["http"]> = {}): ArrivalOperatorView {
  const callRow = (stage: string, outsider: number) => ({
    stage: stage as never,
    unit: "calls" as const,
    instrumentation: `${stage} route/tool calls`,
    outsider,
    ours: 0,
    unknown: 0,
  });
  const walletRow = (stage: string, outsider: number) => ({
    stage: stage as never,
    unit: "agents" as const,
    instrumentation: "distinct SIWE wallets reaching at least this stage",
    outsider,
    ours: 0,
    unknown: 0,
  });
  return {
    version: "averray.arrivals.operator.v1",
    generatedAtMs: NOW,
    outsiders: {
      furthestEver: null,
      lastActivity: null,
      week: { window: "7d", identified: 0, worked: 0 },
      postedWork: { window: "all-time", status: "never", count: null, firstAtMs: null },
    },
    ours: { day: { window: "24h", agents: 0, canaryRuns: 0, acceptanceRuns: 0, adminConsoleAgents: 0, operatorAgents: 0 } },
    unknown: { window: "all-time", sharedClientNames: 0, preSplitCalls: 0 },
    doors: {
      mcp: {
        window: "all-time",
        sinceMs: NOW - 8 * 86_400_000,
        rows: [callRow("reached", 2000), walletRow("identified", 1), walletRow("claimed", 1), walletRow("submitted", 0)],
      },
      http: {
        window: "all-time",
        sinceMs: NOW - 5 * 86_400_000,
        rows: [
          callRow("reached", 15_000),
          callRow("browsed", 400),
          walletRow("identified", 164),
          walletRow("authenticated", 164),
          walletRow("claimed", 162),
          walletRow("submitted", 162),
        ],
        ...over,
      },
    },
  };
}

describe("doorJourneys — the wallet half only, per-door scale", () => {
  test("call rows never enter the journey — the un-charted counters stay un-charted", () => {
    const [mcp, http] = doorJourneys(view());
    expect(mcp!.stages.map((s) => s.stage)).toEqual(["identified", "claimed", "submitted"]);
    expect(http!.stages.map((s) => s.stage)).toEqual(["identified", "authenticated", "claimed", "submitted"]);
    // The 15,000-call reached row must not have become a fill anywhere.
    for (const door of [mcp!, http!]) {
      expect(door.stages.every((s) => s.count < 1000)).toBe(true);
    }
  });

  test("each door scales to its own maximum — doors are never comparable", () => {
    const [mcp, http] = doorJourneys(view());
    // MCP's single wallet fills MCP's own scale; HTTP's 162 sits just under
    // HTTP's 164. Equal fills for unequal counts is the point: no cross-door
    // comparison is encoded.
    expect(mcp!.stages[0]!.fillPct).toBe(100);
    expect(http!.stages[0]!.fillPct).toBe(100);
    expect(http!.stages[2]!.fillPct).toBe(99);
  });

  test("zero draws no fill; a tiny nonzero always draws one", () => {
    const [mcp] = doorJourneys(view());
    const submitted = mcp!.stages.find((s) => s.stage === "submitted")!;
    expect(submitted.fillPct).toBe(0);
    const identified = mcp!.stages.find((s) => s.stage === "identified")!;
    expect(identified.fillPct).toBeGreaterThanOrEqual(5);
  });

  test("a door with no wallet-unit rows yields an empty journey, not zeros", () => {
    const v = view({ rows: [] });
    const [, http] = doorJourneys(v);
    expect(http!.stages).toEqual([]);
  });
});
