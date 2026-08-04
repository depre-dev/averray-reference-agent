// A switched-off feed is not four broken instruments.
//
// The payload below is the REAL one, copied from the mainnet backend on
// 2026-08-04 while BANK_LANE_FEED_ENABLED was unset:
//
//   {"position":{"raw":null,"source":"unconfigured:position","readAtMs":null,
//     "lastError":"bank_lane_feed_disabled"}, "float":{…}, "postage":{…}}
//
// It parses cleanly — the contract holds — and every read carries an error,
// which is shaped exactly like four instruments that failed. Rendered as a lane
// it lit BANK amber for a feature nobody had turned on.

import { describe, expect, test } from "vitest";

import { BANK_FEED_DISABLED_SENTINEL, bankFeedIsDisabled, type BankFeed } from "../../src/bank-feed.js";
import { bankLaneView } from "../../src/bank-lane.js";
import { normalizeBankFeed } from "../../src/bank-feed-fetch.js";

const NOW = 1_785_900_000_000;

/** Byte-for-byte the disabled producer's shape. */
const DISABLED_PAYLOAD = {
  position: { raw: null, source: "unconfigured:position", readAtMs: null, lastError: "bank_lane_feed_disabled" },
  float: { raw: null, source: "unconfigured:float", readAtMs: null, lastError: "bank_lane_feed_disabled" },
  postage: { raw: null, source: "unconfigured:postage", readAtMs: null, lastError: "bank_lane_feed_disabled" },
  requests: { items: [], readAtMs: null, lastError: "bank_lane_feed_disabled" },
  calibration: null,
};

function disabledFeed(): BankFeed {
  const read = normalizeBankFeed(DISABLED_PAYLOAD);
  // If this ever fails, the contract broke — which is a different bug, and the
  // test should say so rather than quietly test a hand-built object.
  expect(read.reason).toBeUndefined();
  return read.feed!;
}

describe("the real disabled payload", () => {
  test("still parses — a switched-off feed is a VALID feed, not a malformed one", () => {
    const feed = disabledFeed();
    expect(feed.position.raw).toBeNull();
    expect(feed.position.lastError).toBe(BANK_FEED_DISABLED_SENTINEL);
  });

  test("is recognised as disabled", () => {
    expect(bankFeedIsDisabled(disabledFeed())).toBe(true);
  });

  test("WOULD have rendered an amber lane — this is the defect being fixed", () => {
    // Kept deliberately: it documents why the collapse exists. bankLaneView is
    // still correct on its own terms — four failed reads ARE degraded — which is
    // exactly why the judgement has to happen before the lane is built.
    const lane = bankLaneView({ feed: disabledFeed(), nowMs: NOW })!;
    expect(lane.tone).toBe("degraded");
    expect(lane.float.text).toContain("unreadable");
    expect(lane.requests.text).toContain("request table unreadable");
  });
});

describe("what must NOT collapse", () => {
  test("one working read means the feed is live and its errors are real faults", () => {
    // A partially-disabled feed is a fault, and calling it "switched off" would
    // be the false green on the other side of the same mistake.
    const feed = disabledFeed();
    feed.float = { raw: "28463", source: "asset 22 · Tokens.accounts(convertedAccount)", readAtMs: NOW - 30_000 };
    expect(bankFeedIsDisabled(feed)).toBe(false);
  });

  test("a DIFFERENT error on every read is an outage, not a switch", () => {
    // Only the producer's own sentinel counts. "every read failed" is the
    // signature of the platform being down, which must stay visible.
    const feed = disabledFeed();
    for (const key of ["position", "float", "postage"] as const) {
      feed[key] = { ...feed[key], lastError: "ECONNREFUSED" };
    }
    expect(bankFeedIsDisabled(feed)).toBe(false);
  });

  test("requests in flight veto the collapse, whatever the balances say", () => {
    // The request table is the stuck-pending alarm. If it is carrying rows,
    // hiding the lane behind "switched off" would hide the one thing on it
    // where doing nothing costs money.
    const feed = disabledFeed();
    feed.requests = {
      items: [{ id: "req-4a1c", kind: "deposit", phase: "leg2-dispatched", ageSeconds: 900, overdue: true }],
      readAtMs: NOW - 30_000,
    };
    expect(bankFeedIsDisabled(feed)).toBe(false);
    expect(bankLaneView({ feed, nowMs: NOW })!.overdueRequestId).toBe("req-4a1c");
  });

  test("a request table that was genuinely read veto the collapse even when empty", () => {
    // readAtMs set with zero items is a real "no requests in flight" — the
    // producer is running. Collapsing that would drop a working lane.
    const feed = disabledFeed();
    feed.requests = { items: [], readAtMs: NOW - 30_000 };
    expect(bankFeedIsDisabled(feed)).toBe(false);
  });
});
