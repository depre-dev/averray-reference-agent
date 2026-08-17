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

// ── the named-identity roster ───────────────────────────────────────────────

import { OPS_FIXTURE_ARRIVALS } from "./ops-fixtures.js";
import { outsiderBand, outsiderLabel, outsiderPresence, outsiderRoster } from "./arrivals-view.js";

describe("outsiderRoster — who showed up, and what they called", () => {
  test("ours and unclaimable never enter the roster", () => {
    // A self-marked canary read as an arrival manufactures demand evidence;
    // an ambiguous caller cannot be claimed by either side.
    const roster = outsiderRoster(OPS_FIXTURE_ARRIVALS)!;
    const keys = roster.rows.map((r) => r.key);
    expect(keys).not.toContain("client:averray-canary@1.0");
    expect(keys).not.toContain("client:Anthropic-ClaudeAI");
    expect(keys).toHaveLength(3);
  });

  test("depth orders the roster — work first, knocks last", () => {
    const roster = outsiderRoster(OPS_FIXTURE_ARRIVALS)!;
    expect(roster.rows.map((r) => r.band)).toEqual(["worked", "engaged", "knocked"]);
    expect(roster.counts).toEqual({ worked: 1, engaged: 1, knocked: 1 });
  });

  test("the routes come through verbatim, busiest first", () => {
    // This is the whole point: a counter cannot tell the gold path from a
    // scanner, and the routes can.
    const roster = outsiderRoster(OPS_FIXTURE_ARRIVALS)!;
    const worker = roster.rows.find((r) => r.band === "worked")!;
    expect(worker.topRoutes[0]).toEqual({ route: "POST /auth/nonce", calls: 39 });
    expect(worker.topRoutes.map((r) => r.route)).toContain("POST /jobs/submit");

    const knocker = roster.rows.find((r) => r.band === "knocked")!;
    expect(knocker.topRoutes.map((r) => r.route)).toContain("GET /wp-login.php");
    // …and it is never characterised — the row carries the route, not a label.
    expect(JSON.stringify(knocker)).not.toMatch(/hostile|attack|malicious|scanner/i);
  });

  test("an identity with no recorded routes says so instead of showing none", () => {
    const bare = {
      ...OPS_FIXTURE_ARRIVALS,
      agents: [{ ...OPS_FIXTURE_ARRIVALS.agents![0]!, tools: {} }],
    };
    const row = outsiderRoster(bare)!.rows[0]!;
    expect(row.routesUnrecorded).toBe(true);
    expect(row.topRoutes).toEqual([]);
  });

  test("no registry is null — never an empty roster", () => {
    // "We cannot see who arrived" and "nobody arrived" are the two states
    // this panel exists to keep apart.
    const { agents: _agents, ...withoutAgents } = OPS_FIXTURE_ARRIVALS;
    expect(outsiderRoster(withoutAgents)).toBeNull();
    expect(outsiderRoster(undefined)).toBeNull();
    expect(outsiderRoster({ unavailable: "feed down" })).toBeNull();
  });

  test("caps the rows and counts the remainder rather than hiding it", () => {
    const roster = outsiderRoster(OPS_FIXTURE_ARRIVALS, 2)!;
    expect(roster.rows).toHaveLength(2);
    expect(roster.more).toBe(1);
    // The band counts still describe EVERY outsider, not just the shown ones.
    expect(roster.counts.knocked).toBe(1);
  });
});

describe("outsiderLabel — named from what the producer gave", () => {
  const base = OPS_FIXTURE_ARRIVALS.agents![0]!;
  test("a declared client name wins, with its version", () => {
    expect(outsiderLabel({ ...base, name: "mcpbeat", version: "0.1" })).toBe("mcpbeat 0.1");
  });
  test("a wallet is shortened the way the board shortens addresses", () => {
    expect(outsiderLabel({ ...base, name: null, wallet: "0x191c000000000000000000000000000000003b0e" }))
      .toBe("0x191c…3b0e");
  });
  test("an unattributed key is called what it is, never dressed up", () => {
    expect(outsiderLabel({ ...base, name: null, wallet: null, key: "anon:7eba341801e4" }))
      .toBe("unattributed caller");
  });
});

describe("outsiderBand", () => {
  test("claimed, submitted and settled are work", () => {
    for (const s of ["claimed", "submitted", "settled"]) expect(outsiderBand(s)).toBe("worked");
  });
  test("an unknown stage falls to the floor, never up", () => {
    expect(outsiderBand("teleported")).toBe("knocked");
  });
});

describe("outsiderPresence — the top-band signal", () => {
  const NOW_P = OPS_FIXTURE_ARRIVALS.generatedAtMs!;
  test("reports the deepest band anyone reached", () => {
    const p = outsiderPresence(OPS_FIXTURE_ARRIVALS, NOW_P)!;
    expect(p.band).toBe("worked");
    expect(p.counts.worked).toBe(1);
    expect(p.live).toBe(true);
  });

  test("ages are measured against the PRODUCER's clock, not the reader's", () => {
    // Two clocks put two ages for one event on one screen — the strip and the
    // roster below it disagreed by a minute the first time they rendered.
    const p = outsiderPresence(OPS_FIXTURE_ARRIVALS, NOW_P + 9 * 60_000)!;
    expect(p.asOfMs).toBe(OPS_FIXTURE_ARRIVALS.generatedAtMs);
    // …so a reader's clock running on is not what decides `live` either.
    expect(p.live).toBe(true);
  });

  test("live is a window against that clock, not a vibe", () => {
    const stale = {
      ...OPS_FIXTURE_ARRIVALS,
      generatedAtMs: OPS_FIXTURE_ARRIVALS.generatedAtMs! + 5 * 3_600_000,
    };
    expect(outsiderPresence(stale, NOW_P)!.live).toBe(false);
  });

  test("the counts carry the window they were measured over", () => {
    const p = outsiderPresence(OPS_FIXTURE_ARRIVALS, NOW_P)!;
    expect(p.observingSinceMs).toBe(OPS_FIXTURE_ARRIVALS.observingSinceMs);
  });

  test("no registry → null, so the strip renders nothing at all", () => {
    const { agents: _drop, ...withoutAgents } = OPS_FIXTURE_ARRIVALS;
    expect(outsiderPresence(withoutAgents, NOW_P)).toBeNull();
  });

  test("a registry with only ours in it reports nobody outside", () => {
    const onlySelf = { ...OPS_FIXTURE_ARRIVALS, agents: OPS_FIXTURE_ARRIVALS.agents!.filter((a) => a.self) };
    const p = outsiderPresence(onlySelf, NOW_P)!;
    expect(p.band).toBeNull();
    expect(p.counts).toEqual({ worked: 0, engaged: 0, knocked: 0 });
  });
});
