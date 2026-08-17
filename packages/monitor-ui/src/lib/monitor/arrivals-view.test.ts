import { describe, expect, test } from "vitest";

import { doorLadders, recencyBand, weekPair } from "./arrivals-view.js";
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

describe("doorLadders — the wallet half only, per-door scale", () => {
  test("call rows never enter the ladder — the un-charted counters stay un-charted", () => {
    const [mcp, http] = doorLadders(view());
    expect(mcp!.stages.map((s) => s.stage)).toEqual(["identified", "claimed", "submitted"]);
    expect(http!.stages.map((s) => s.stage)).toEqual(["identified", "authenticated", "claimed", "submitted"]);
    // The 15,000-call reached row must not have become a bar anywhere.
    for (const door of [mcp!, http!]) {
      expect(door.stages.every((s) => s.count < 1000)).toBe(true);
    }
  });

  test("each door scales to its own maximum — doors are never comparable", () => {
    const [mcp, http] = doorLadders(view());
    // MCP's single wallet fills MCP's own scale; HTTP's 162 sits just under
    // HTTP's 164. Equal fills for unequal counts is the point: no cross-door
    // comparison is encoded.
    expect(mcp!.stages[0]!.fillPct).toBe(100);
    expect(http!.stages[0]!.fillPct).toBe(100);
    expect(http!.stages[2]!.fillPct).toBe(99);
  });

  test("zero draws no bar; a tiny nonzero always draws one", () => {
    const [mcp] = doorLadders(view());
    const submitted = mcp!.stages.find((s) => s.stage === "submitted")!;
    expect(submitted.fillPct).toBe(0);
    const identified = mcp!.stages.find((s) => s.stage === "identified")!;
    expect(identified.fillPct).toBeGreaterThanOrEqual(5);
  });

  test("a door with no wallet-unit rows yields an empty ladder, not zeros", () => {
    const v = view({ rows: [] });
    const [, http] = doorLadders(v);
    expect(http!.stages).toEqual([]);
  });
});

describe("recencyBand — fixed rungs against the snapshot clock", () => {
  test("bands split at 1h / 24h / 7d", () => {
    expect(recencyBand(NOW - 2 * 60_000, NOW)).toBe("1h");
    expect(recencyBand(NOW - 5 * 3_600_000, NOW)).toBe("24h");
    expect(recencyBand(NOW - 3 * 86_400_000, NOW)).toBe("7d");
    expect(recencyBand(NOW - 30 * 86_400_000, NOW)).toBe("older");
  });

  test("no activity ever → null, so no strip renders at all", () => {
    expect(recencyBand(null, NOW)).toBeNull();
    expect(recencyBand(undefined, NOW)).toBeNull();
    expect(recencyBand(Number.NaN, NOW)).toBeNull();
  });
});

describe("weekPair — one shared scale, no containment claim", () => {
  test("both counts fill against the larger of the two", () => {
    const pair = weekPair({ identified: 18, worked: 16 })!;
    expect(pair.identified.fillPct).toBe(100);
    expect(pair.worked.fillPct).toBe(89);
    expect(pair.worked.count).toBe(16);
  });

  test("a zero week renders no bars — the words already say it", () => {
    expect(weekPair({ identified: 0, worked: 0 })).toBeNull();
  });

  test("worked can exceed identified without breaking the scale", () => {
    // Nothing in the payload proves worked ⊆ identified; the scale must not
    // assume it.
    const pair = weekPair({ identified: 2, worked: 5 })!;
    expect(pair.worked.fillPct).toBe(100);
    expect(pair.identified.fillPct).toBe(40);
  });
});
