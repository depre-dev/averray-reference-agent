import { describe, expect, test } from "vitest";

import {
  normalizeArrivalsFeed,
  readArrivalsFeed,
} from "../../src/arrivals-feed.js";

const good = {
  schemaVersion: "averray.arrivals.v1",
  generatedAtMs: 1_786_100_000_000,
  observingSinceMs: 1_786_000_000_000,
  funnel: {
    reached: 20,
    browsed: 12,
    evaluated: 7,
    identified: 3,
    authenticated: 2,
    claimed: 1,
    submitted: 1,
  },
  funnelExternal: {
    reached: 12,
    browsed: 6,
    evaluated: 3,
    identified: 1,
    authenticated: 0,
    claimed: 0,
    submitted: 0,
  },
  funnelSelf: {
    reached: 8,
    browsed: 6,
    evaluated: 4,
    identified: 2,
    authenticated: 2,
    claimed: 1,
    submitted: 1,
  },
  distinct: {
    declared: 4,
    anonymous: 9,
    self: 1,
    furthest: "submitted",
    furthestExternal: "identified",
  },
  clients: [{
    key: "client:outside-agent@1.2.3",
    name: "outside-agent",
    version: "1.2.3",
    era: "2026-07-28",
    self: false,
    firstSeenMs: 1_786_000_000_000,
    lastSeenMs: 1_786_100_000_000,
    furthestStage: "submitted",
    calls: 9,
    tools: { listJobs: 2, submitWork: 1 },
  }],
};

describe("readArrivalsFeed", () => {
  test("reads the public platform route from the configured API base", async () => {
    let requested = "";
    const result = await readArrivalsFeed({
      baseUrl: "https://api.averray.com/",
      fetchImpl: (async (url: RequestInfo | URL) => {
        requested = String(url);
        return { ok: true, status: 200, json: async () => good } as Response;
      }) as typeof fetch,
    });

    expect(requested).toBe("https://api.averray.com/monitor/arrivals");
    expect("distinct" in result && result.distinct).toEqual({
      declared: 4,
      anonymous: 9,
      self: 1,
      furthest: "submitted",
      furthestExternal: "identified",
    });
  });

  test("a configured feed failure is explicit, never an empty snapshot", async () => {
    const result = await readArrivalsFeed({
      baseUrl: "https://api.averray.com",
      fetchImpl: (async () => ({ ok: false, status: 503 })) as typeof fetch,
    });

    expect("unavailable" in result && result.unavailable).toContain("unreachable");
    expect("unavailable" in result && result.unavailable).toContain("HTTP 503");
  });

  test("missing platform configuration is also a named non-reading", async () => {
    const result = await readArrivalsFeed({
      fetchImpl: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
    });

    expect(result).toEqual({
      unavailable: "arrivals feed unreachable — platform API base URL is not configured",
    });
  });
});

describe("normalizeArrivalsFeed", () => {
  test("preserves every funnel stage and client field", () => {
    const result = normalizeArrivalsFeed(good);
    expect("funnel" in result && result.funnel).toEqual(good.funnel);
    expect("funnelExternal" in result && result.funnelExternal).toEqual(good.funnelExternal);
    expect("funnelSelf" in result && result.funnelSelf).toEqual(good.funnelSelf);
    expect("clients" in result && result.clients).toEqual(good.clients);
  });

  // A producer too old to split the funnel cannot answer "did an OUTSIDER
  // browse?". Reading `funnel` in its place would answer a different question
  // with the same confident number, which is the defect this contract exists
  // to close — so the whole block becomes a named non-reading instead.
  test("a producer without the external split is a non-reading, never the total", () => {
    const { funnelExternal, ...withoutSplit } = good;
    const result = normalizeArrivalsFeed(withoutSplit);

    expect("unavailable" in result && result.unavailable).toContain("funnelExternal is missing");
    expect("funnel" in result).toBe(false);
  });

  test("a client whose self mark is missing is refused, not assumed external", () => {
    const [client] = good.clients;
    const { self, ...unmarked } = client;
    const result = normalizeArrivalsFeed({ ...good, clients: [unmarked] });

    expect("unavailable" in result && result.unavailable).toContain("client entry has invalid fields");
  });

  // External, self and ambiguous are disjoint subsets of the total. A producer
  // claiming more outsiders than calls is describing a funnel we cannot
  // interpret, and the safe reading of a funnel we cannot interpret is none.
  test("a split that exceeds its own total is refused", () => {
    const result = normalizeArrivalsFeed({
      ...good,
      funnelExternal: { ...good.funnelExternal, browsed: good.funnel.browsed + 1 },
    });

    expect("unavailable" in result && result.unavailable).toContain(
      "browsed external plus self plus ambiguous exceeds",
    );
  });

  test("the producer's own unavailable state stays unavailable, not seven zeroes", () => {
    const result = normalizeArrivalsFeed({
      ...good,
      unavailable: "arrival state could not be read",
      funnel: Object.fromEntries(Object.keys(good.funnel).map((stage) => [stage, null])),
      funnelExternal: Object.fromEntries(Object.keys(good.funnel).map((stage) => [stage, null])),
      funnelSelf: Object.fromEntries(Object.keys(good.funnel).map((stage) => [stage, null])),
      distinct: { declared: null, anonymous: null, self: null, furthest: null, furthestExternal: null },
      clients: [],
    });

    expect("unavailable" in result && result.unavailable).toContain("arrival state could not be read");
  });

  test("malformed counts are refused instead of coerced to zero", () => {
    const result = normalizeArrivalsFeed({
      ...good,
      funnel: { ...good.funnel, identified: "3" },
    });

    expect("unavailable" in result && result.unavailable).toContain("funnel.identified");
  });

  test("a schema drift is visible by version", () => {
    const result = normalizeArrivalsFeed({ ...good, schemaVersion: "averray.arrivals.v2" });
    expect("unavailable" in result && result.unavailable).toContain("schemaVersion averray.arrivals.v1");
  });
});

// AMBIGUOUS — traffic under a client name the platform itself uses. Our Claude
// session and a stranger's both declare `Anthropic/ClaudeAI`, so the funnel
// structurally cannot separate them and neither side may be claimed.
describe("normalizeArrivalsFeed — the ambiguous bucket", () => {
  const withAmbiguous = {
    ...good,
    funnelAmbiguous: {
      reached: 0,
      browsed: 3,
      evaluated: 0,
      identified: 0,
      authenticated: 0,
      claimed: 0,
      submitted: 0,
    },
    // The base fixture spends its whole `browsed` total on external and self,
    // so the third bucket needs room in the total to be coherent at all.
    funnel: { ...good.funnel, browsed: 15 },
    distinct: { ...good.distinct, ambiguous: 1, furthestAmbiguous: "browsed" },
  };

  test("the third bucket is carried through when the platform reports it", () => {
    const result = normalizeArrivalsFeed(withAmbiguous);

    expect("funnelAmbiguous" in result && result.funnelAmbiguous).toEqual(withAmbiguous.funnelAmbiguous);
    expect("distinct" in result && result.distinct.ambiguous).toBe(1);
    expect("distinct" in result && result.distinct.furthestAmbiguous).toBe("browsed");
  });

  // Unlike the external split, absence here is not a producer we cannot read —
  // it is one deployed before the bucket existed, whose `funnelExternal` is the
  // number this panel has always rendered. Blanking the board over a
  // deploy-order skew would be strictly worse than showing it.
  test("a platform without the bucket still reads, it does not blank the board", () => {
    const result = normalizeArrivalsFeed(good);

    expect("unavailable" in result).toBe(false);
    expect("funnelExternal" in result && result.funnelExternal).toEqual(good.funnelExternal);
  });

  // Absent and zero are different claims. Zero-filling would have the board
  // state that no unattributable traffic arrived, which nobody measured.
  test("an absent bucket stays absent rather than becoming a zero reading", () => {
    const result = normalizeArrivalsFeed(good);

    expect("funnelAmbiguous" in result).toBe(false);
    expect("distinct" in result && "ambiguous" in result.distinct).toBe(false);
    expect("distinct" in result && "furthestAmbiguous" in result.distinct).toBe(false);
  });

  test("optional does not mean unchecked — a malformed bucket is still refused", () => {
    const result = normalizeArrivalsFeed({
      ...withAmbiguous,
      funnelAmbiguous: { ...withAmbiguous.funnelAmbiguous, browsed: "3" },
    });

    expect("unavailable" in result && result.unavailable).toContain("funnelAmbiguous.browsed");
  });

  test("a malformed distinct ambiguous figure is refused", () => {
    const result = normalizeArrivalsFeed({
      ...withAmbiguous,
      distinct: { ...withAmbiguous.distinct, furthestAmbiguous: "loitering" },
    });

    expect("unavailable" in result && result.unavailable).toContain("distinct ambiguous figures");
  });

  // The invariant this bucket had to be added to. All three are subsets of the
  // total, so together they still cannot exceed it.
  test("the three buckets together may not exceed the total", () => {
    const result = normalizeArrivalsFeed({
      ...withAmbiguous,
      funnelAmbiguous: { ...withAmbiguous.funnelAmbiguous, browsed: good.funnel.browsed },
    });

    expect("unavailable" in result && result.unavailable).toContain(
      "browsed external plus self plus ambiguous exceeds",
    );
  });

  // An INEQUALITY on purpose: calls counted before the platform split its
  // funnel restore into the total alone, so the parts legitimately fall short.
  // Requiring them to add up would reject every producer with real history.
  test("buckets falling short of the total is history, not incoherence", () => {
    const result = normalizeArrivalsFeed({
      ...withAmbiguous,
      funnel: { ...good.funnel, browsed: good.funnel.browsed + 40 },
    });

    expect("unavailable" in result).toBe(false);
  });

  test("a client may carry the ambiguous mark, and need not", () => {
    const [client] = good.clients;
    const marked = normalizeArrivalsFeed({
      ...withAmbiguous,
      clients: [{ ...client, ambiguous: true }],
    });
    expect("clients" in marked && marked.clients[0].ambiguous).toBe(true);

    const unmarked = normalizeArrivalsFeed(good);
    expect("clients" in unmarked && "ambiguous" in unmarked.clients[0]).toBe(false);

    const malformed = normalizeArrivalsFeed({
      ...withAmbiguous,
      clients: [{ ...client, ambiguous: "yes" }],
    });
    expect("unavailable" in malformed && malformed.unavailable).toContain("client entry has invalid fields");
  });
});
