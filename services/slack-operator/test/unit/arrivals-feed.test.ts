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
  distinct: { declared: 4, anonymous: 9, furthest: "submitted" },
  clients: [{
    key: "client:outside-agent@1.2.3",
    name: "outside-agent",
    version: "1.2.3",
    era: "2026-07-28",
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
    expect("distinct" in result && result.distinct).toEqual({ declared: 4, anonymous: 9, furthest: "submitted" });
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
    expect("clients" in result && result.clients).toEqual(good.clients);
  });

  test("the producer's own unavailable state stays unavailable, not seven zeroes", () => {
    const result = normalizeArrivalsFeed({
      ...good,
      unavailable: "arrival state could not be read",
      funnel: Object.fromEntries(Object.keys(good.funnel).map((stage) => [stage, null])),
      distinct: { declared: null, anonymous: null, furthest: null },
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
