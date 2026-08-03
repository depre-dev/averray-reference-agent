import { describe, expect, test } from "vitest";

import {
  CROSSCHECK_OVERDUE_MS,
  SAFE_HEAD_LAG_BLOCKS,
  crossCheckNeverRun,
  decideCrossCheck,
  endpointHost,
  pinnedCompareRange,
} from "../../src/payout-crosscheck.js";

const NOW = 1_785_700_000_000;
const A = { host: "services.polkadothub-rpc.com", count: 18 };
const B = { host: "eth-rpc.polkadot.io", count: 18 };
const base = { configured: true, lastAgreedAtMs: NOW - 1000, nowMs: NOW };

describe("agreement and disagreement", () => {
  test("same count is a quiet agreement that names both endpoints", () => {
    const v = decideCrossCheck({ ...base, primary: A, secondary: B });
    expect(v.status).toBe("agree");
    expect(v.detail).toContain("services.polkadothub-rpc.com");
    expect(v.detail).toContain("eth-rpc.polkadot.io");
    expect(v.overdue).toBe(false);
    expect(v.lastAgreedAtMs).toBe(NOW);
  });

  test("a disagreement names BOTH counts, or the alarm has no next step", () => {
    const v = decideCrossCheck({
      ...base,
      primary: A,
      secondary: { ...B, count: 15 },
      range: { fromBlock: 18_959_091, toBlock: 19_000_000 },
    });
    expect(v.status).toBe("disagree");
    expect(v.detail).toContain("reads 18");
    expect(v.detail).toContain("reads 15");
    expect(v.detail).toContain("18,959,091");
    expect(v.detail).toContain("not reliable");
  });

  test("a disagreement does not silently refresh the agreement clock", () => {
    const v = decideCrossCheck({ ...base, primary: A, secondary: { ...B, count: 15 } });
    expect(v.lastAgreedAtMs).toBe(base.lastAgreedAtMs);
  });
});

describe("a tick must never age silently", () => {
  test("an agreement older than the budget reports overdue when the check fails", () => {
    const v = decideCrossCheck({
      configured: true,
      primary: A,
      secondary: null,
      secondaryReason: "second endpoint unreachable (ETIMEDOUT)",
      lastAgreedAtMs: NOW - CROSSCHECK_OVERDUE_MS - 1,
      nowMs: NOW,
    });
    expect(v.status).toBe("unavailable");
    expect(v.overdue).toBe(true);
    expect(v.detail).toContain("ETIMEDOUT");
  });

  test("a recent agreement is not overdue merely because one run failed", () => {
    const v = decideCrossCheck({
      configured: true,
      primary: A,
      secondary: null,
      secondaryReason: "429 rate limited",
      lastAgreedAtMs: NOW - 60_000,
      nowMs: NOW,
    });
    expect(v.overdue).toBe(false);
  });

  test("never having agreed is overdue the moment a run fails", () => {
    // Otherwise a check that has NEVER succeeded renders identically to one
    // that succeeded yesterday.
    const v = decideCrossCheck({
      configured: true, primary: A, secondary: null,
      secondaryReason: "unreachable", lastAgreedAtMs: null, nowMs: NOW,
    });
    expect(v.overdue).toBe(true);
  });
});

describe("absence is not a fault, and never-run is not a pass", () => {
  test("no second endpoint configured is not overdue and says what is missing", () => {
    // A check nobody enabled is not a check that broke. Rendering it as one
    // puts a permanent amber on the panel, which trains the operator past it.
    const v = decideCrossCheck({
      configured: false, primary: A, secondary: null, lastAgreedAtMs: null, nowMs: NOW,
    });
    expect(v.status).toBe("not-configured");
    expect(v.overdue).toBe(false);
    expect(v.detail).toContain("one provider");
    expect(v.detail).toContain("PRODUCT_HEALTH_PAYOUT_CROSSCHECK_RPC_URL");
  });

  test("configured but not yet run borrows none of an agreement's wording", () => {
    const v = crossCheckNeverRun(true);
    expect(v.status).toBe("never-run");
    expect(v.detail).not.toContain("agree");
    expect(v.lastAgreedAtMs).toBeNull();
  });

  test("a null count on either side is unavailable, never a disagreement", () => {
    // "could not read" and "read something different" are different findings
    // and only one of them impugns the instrument.
    expect(
      decideCrossCheck({ ...base, primary: A, secondary: { host: B.host, count: null } }).status,
    ).toBe("unavailable");
    expect(
      decideCrossCheck({ ...base, primary: { host: A.host, count: null }, secondary: B }).status,
    ).toBe("unavailable");
  });
});

describe("pinnedCompareRange — compare behind the head", () => {
  test("the compared range ends well behind the tip", () => {
    // Two honest endpoints legitimately disagree at the tip. Comparing there
    // would fire most times it ran, and an alarm that is usually wrong is the
    // failure mode this whole exercise exists to avoid.
    const r = pinnedCompareRange({ latestBlock: 19_000_000, lookbackBlocks: 40_909 })!;
    expect(r.toBlock).toBe(19_000_000 - SAFE_HEAD_LAG_BLOCKS);
    expect(r.fromBlock).toBe(r.toBlock - 40_909);
  });

  test("both sides are pinned, so the same question is asked twice", () => {
    const r = pinnedCompareRange({ latestBlock: 19_000_000, lookbackBlocks: 100 })!;
    expect(Number.isInteger(r.fromBlock)).toBe(true);
    expect(Number.isInteger(r.toBlock)).toBe(true);
    expect(r.toBlock).toBeGreaterThan(r.fromBlock);
  });

  test("a chain too shallow for the margin yields no range rather than a bad one", () => {
    expect(pinnedCompareRange({ latestBlock: 50, lookbackBlocks: 40_000 })).toBeNull();
  });
});

describe("endpointHost — the URL never reaches the screen", () => {
  test("host only, because provider URLs carry API keys", () => {
    // Echoing a full URL onto a board (or into a screenshot, or a Buzz
    // message) is a credential leak, and the host is all the line needs.
    expect(endpointHost("https://rpc.example.com/v1/SECRET-KEY?apikey=abc123")).toBe("rpc.example.com");
    expect(endpointHost("https://services.polkadothub-rpc.com/mainnet/")).toBe("services.polkadothub-rpc.com");
  });

  test("an unparseable value yields null, never the raw string", () => {
    // Returning the raw string here would defeat the redaction above the
    // moment someone configured a URL the parser did not like.
    expect(endpointHost("not a url with ?apikey=leak")).toBeNull();
    expect(endpointHost("")).toBeNull();
    expect(endpointHost(undefined)).toBeNull();
  });
});
