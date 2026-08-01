import { describe, expect, it } from "vitest";

import {
  CLAIM_EXPIRY_WARN_MS,
  DISPUTE_HALT_MS,
  DISPUTE_WARN_MS,
  REVIEW_STALE_WARN_MS,
  bucketFor,
  decideExternalFunnel,
  disputeWindowFrom,
  type ExternalJobRow,
} from "../../services/slack-operator/src/external-funnel.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
// Real mainnet job id — ids are 66 chars, and a short fixture would make
// shortJobId a silent no-op and hide whether the verdict names the item.
const REAL_ID = "0xaa4b7b03420974aae368952b6499ec264efa79060e2a6cb8b9417dc3eace1cd7";
const id = (tag: string) => `0x${tag}${"0".repeat(64 - tag.length)}`;
const HOUR = 3_600_000;
const WINDOW = 604800; // seconds — the live mainnet value, read not assumed

const iso = (ms: number) => new Date(ms).toISOString();
const decide = (over: Partial<Parameters<typeof decideExternalFunnel>[0]> = {}) =>
  decideExternalFunnel({
    rows: [],
    disputeWindowSeconds: WINDOW,
    nowMs: NOW,
    haltStatus: "red",
    ...over,
  });

describe("bucketFor", () => {
  it("maps the four lifecycle states", () => {
    expect(bucketFor({ state: "open", effectiveState: "claimable" })).toBe("open_claimable");
    expect(bucketFor({ state: "claimed" })).toBe("claimed_active");
    expect(bucketFor({ state: "submitted" })).toBe("submitted_awaiting_review");
    expect(bucketFor({ state: "rejected" })).toBe("rejected_window_running");
  });

  it("puts an unrecognised state in `other` rather than forcing it into a bucket", () => {
    // The LIVE catalog already returns `exhausted`, which is none of the four.
    // Folding unknown states into a counted bucket would misreport the funnel
    // the first time a new state ships.
    expect(bucketFor({ state: "exhausted", effectiveState: "exhausted" })).toBe("other");
    expect(bucketFor({})).toBe("other");
  });
});

describe("decideExternalFunnel — truth rules", () => {
  it("a FETCH FAILURE is unknown, never an empty green funnel", () => {
    // #477: silent rate-limit 403s let the monitor draw confident conclusions
    // from absent data. Absence of rows must not read as absence of risk.
    const r = decide({ rows: null, fetchError: "HTTP 503" });
    expect(r.probe.status).toBe("degraded");
    expect(r.probe.detail).toContain("unreadable");
    expect(r.probe.detail).toContain("not empty");
    expect(r.probe.detail).toContain("503");
  });

  it("an EMPTY catalog is an honest green with zeros", () => {
    const r = decide({ rows: [] });
    expect(r.probe.status).toBe("ok");
    expect(r.buckets.open_claimable.count).toBe(0);
    expect(r.buckets.rejected_window_running.count).toBe(0);
    expect(r.probe.detail).toContain("0 claimable");
  });

  it("counts the live catalog shape correctly", () => {
    // The two rows actually on mainnet 2026-08-01: one open, one exhausted.
    const rows: ExternalJobRow[] = [
      { id: REAL_ID, state: "open", effectiveState: "claimable" },
      { id: id("a436"), state: "exhausted", effectiveState: "exhausted" },
    ];
    const r = decide({ rows });
    expect(r.probe.status).toBe("ok");
    expect(r.buckets.open_claimable.count).toBe(1);
    expect(r.buckets.other.count).toBe(1);
    expect(r.probe.detail).toContain("1 other");
  });
});

describe("decideExternalFunnel — rejected dispute window", () => {
  const rejected = (id: string): ExternalJobRow => ({ id, state: "rejected" });

  it("names the item and the time in the verdict", () => {
    const rejectedAtMs = new Map([[REAL_ID, NOW + 9 * HOUR - WINDOW * 1000]]);
    const r = decide({ rows: [rejected(REAL_ID)], rejectedAtMs });
    expect(r.probe.status).toBe("red");
    expect(r.probe.detail).toContain("0xaa4b…");
    expect(r.probe.detail).toContain("slashes in 9h");
  });

  it("escalates to halt severity inside 12h and only degrades inside 48h", () => {
    const at = (remaining: number) => new Map([[id("j"), NOW + remaining - WINDOW * 1000]]);
    expect(decide({ rows: [rejected(id("j"))], rejectedAtMs: at(DISPUTE_HALT_MS - HOUR) }).probe.status).toBe("red");
    expect(decide({ rows: [rejected(id("j"))], rejectedAtMs: at(DISPUTE_WARN_MS - HOUR) }).probe.status).toBe("degraded");
    expect(decide({ rows: [rejected(id("j"))], rejectedAtMs: at(DISPUTE_WARN_MS + HOUR) }).probe.status).toBe("ok");
  });

  it("follows chainHaltStatus — a testnet halt is degraded, not red", () => {
    const rejectedAtMs = new Map([[id("j"), NOW + HOUR - WINDOW * 1000]]);
    expect(decide({ rows: [rejected(id("j"))], rejectedAtMs, haltStatus: "degraded" }).probe.status).toBe("degraded");
  });

  it("says LAPSED rather than a negative countdown once the window has passed", () => {
    const rejectedAtMs = new Map([[id("j"), NOW - 2 * HOUR - WINDOW * 1000]]);
    const r = decide({ rows: [rejected(id("j"))], rejectedAtMs });
    expect(r.probe.status).toBe("red");
    expect(r.probe.detail).toContain("LAPSED");
    expect(r.probe.detail).toContain("slashable now");
  });

  it("computes the deadline from the LIVE window, not a hardcoded 7 days", () => {
    // Same rejectedAt, a shorter window → sooner deadline. If 604800 were baked
    // in, this would not move.
    const rejectedAt = NOW - 6 * HOUR;
    const rejectedAtMs = new Map([[id("j"), rejectedAt]]);
    const short = decide({ rows: [rejected(id("j"))], rejectedAtMs, disputeWindowSeconds: 8 * 3600 });
    expect(short.probe.status).toBe("red");
    expect(short.probe.detail).toContain("slashes in 2h");
    const long = decide({ rows: [rejected(id("j"))], rejectedAtMs, disputeWindowSeconds: WINDOW });
    expect(long.probe.status).toBe("ok");
  });

  it("rejected rows with UNREADABLE deadlines are degraded, never green", () => {
    // The live gap: `rejectedAt`'s word offset in the EscrowCore struct is not
    // yet calibrated. A bond may be counting down; reporting silence as safety
    // would be the exact failure this probe exists to prevent.
    const r = decide({ rows: [rejected(id("j"))], rejectedAtMs: new Map() });
    expect(r.probe.status).toBe("degraded");
    expect(r.probe.detail).toContain("UNREADABLE");
    expect(r.probe.detail).toContain("PRODUCT_HEALTH_ESCROW_REJECTED_AT_WORD");
  });

  it("does not invent a deadline when the window itself is unreadable", () => {
    const r = decide({
      rows: [rejected(id("j"))],
      rejectedAtMs: new Map([[id("j"), NOW - HOUR]]),
      disputeWindowSeconds: null,
    });
    expect(r.probe.status).toBe("degraded");
    expect(r.probe.detail).toContain("UNREADABLE");
  });
});

describe("decideExternalFunnel — review and claim queues", () => {
  it("flags a submission nobody has reviewed past the stale threshold", () => {
    const rows: ExternalJobRow[] = [
      { id: id("5ab"), state: "submitted", claimedAt: iso(NOW - REVIEW_STALE_WARN_MS - HOUR) },
    ];
    const r = decide({ rows });
    expect(r.probe.status).toBe("degraded");
    expect(r.probe.detail).toContain("unreviewed");
    expect(r.probe.detail).toContain(`${id("5ab").slice(0, 6)}…`);
  });

  it("leaves a fresh submission green", () => {
    const rows: ExternalJobRow[] = [{ id: id("5ab"), state: "submitted", claimedAt: iso(NOW - HOUR) }];
    expect(decide({ rows }).probe.status).toBe("ok");
  });

  it("flags a claim about to expire and reports the soonest one", () => {
    const rows: ExternalJobRow[] = [
      { id: id("1a7e"), state: "claimed", claimExpiresAt: iso(NOW + 20 * HOUR) },
      { id: id("500"), state: "claimed", claimExpiresAt: iso(NOW + CLAIM_EXPIRY_WARN_MS - 60_000) },
    ];
    const r = decide({ rows });
    expect(r.probe.status).toBe("degraded");
    expect(r.probe.detail).toContain(`${id("500").slice(0, 6)}…`);
    expect(r.buckets.claimed_active.count).toBe(2);
  });

  it("ranks a slashing deadline above a stale review", () => {
    // Both conditions true at once: the money-losing one must win the headline.
    const rows: ExternalJobRow[] = [
      { id: id("5ab"), state: "submitted", claimedAt: iso(NOW - REVIEW_STALE_WARN_MS - HOUR) },
      { id: id("re7"), state: "rejected" },
    ];
    const r = decide({ rows, rejectedAtMs: new Map([[id("re7"), NOW + 3 * HOUR - WINDOW * 1000]]) });
    expect(r.probe.status).toBe("red");
    expect(r.probe.detail).toContain("slashes in 3h");
  });

  it("tolerates rows with missing or malformed timestamps", () => {
    const rows: ExternalJobRow[] = [
      { id: id("a"), state: "claimed" },
      { id: id("b"), state: "claimed", claimExpiresAt: "not-a-date" },
      { state: "submitted" },
    ];
    const r = decide({ rows });
    expect(r.probe.status).toBe("ok");
    expect(r.buckets.claimed_active.count).toBe(2);
  });
});

describe("disputeWindowFrom", () => {
  it("reads the live value", () => {
    // Verbatim shape from https://api.averray.com/poster/onboarding, 2026-08-01.
    expect(
      disputeWindowFrom({
        workerFacts: { disputeWindow: { available: true, seconds: 604800, duration: "7 days" } },
      }),
    ).toBe(604800);
  });

  it("returns null when the endpoint says the live read failed", () => {
    // A stale constant is worse than no number: the deadline computed from it
    // would look every bit as authoritative as a real one.
    expect(disputeWindowFrom({ workerFacts: { disputeWindow: { available: false, seconds: 604800 } } })).toBeNull();
  });

  it("returns null for absent, malformed, or nonsense values", () => {
    expect(disputeWindowFrom(undefined)).toBeNull();
    expect(disputeWindowFrom({})).toBeNull();
    expect(disputeWindowFrom({ workerFacts: {} })).toBeNull();
    expect(disputeWindowFrom({ workerFacts: { disputeWindow: { seconds: "604800" } } })).toBeNull();
    expect(disputeWindowFrom({ workerFacts: { disputeWindow: { seconds: 0 } } })).toBeNull();
  });
});
