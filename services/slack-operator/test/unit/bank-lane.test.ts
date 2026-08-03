import { describe, expect, test } from "vitest";

import { BANK_STALE_AFTER_MS, bankLaneView } from "../../src/bank-lane.js";
import type { BankFeed, BankRequest } from "../../src/bank-feed.js";

const NOW = 1_785_900_000_000;
const POS_SRC = "aUSDC 0x2ec48840…fa93 · balanceOf(0x98f0033E…B68E)";

const feed = (over: Partial<BankFeed> = {}): BankFeed => ({
  position: { raw: "0", source: POS_SRC, readAtMs: NOW - 30_000 },
  float: { raw: "28463", source: "asset 22 · Tokens.accounts(convertedAccount)", readAtMs: NOW - 30_000 },
  // 1.51 DOT — the wrapper postage account as funded at the arming ceremony.
  postage: { raw: "15100000000", source: "15Xbeap…SMAK", readAtMs: NOW - 30_000 },
  requests: [],
  ...over,
});

const req = (over: Partial<BankRequest> = {}): BankRequest => ({
  id: "req-4a1c", kind: "deposit", phase: "leg2-dispatched", ageSeconds: 120, overdue: false, ...over,
});

describe("absence is one line, not four empty tiles", () => {
  test("no feed renders no lane at all", () => {
    // A permanently-"awaiting" panel is a panel nobody reads, and the lane
    // would be exactly that until the endpoint ships.
    expect(bankLaneView({ feed: undefined, nowMs: NOW })).toBeNull();
  });
});

describe("the position tile under the zero-is-not-a-reading rule", () => {
  test("an uncalibrated zero is unverified — the honest pre-dust state", () => {
    // The dust cycle is blocked on a staging-extrinsic bug, so this is what the
    // tile shows for now. It is also the behaviour under test: it will say
    // unverified for a while and then visibly stop.
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.position!.status).toBe("unverified");
    expect(v.position!.detail).toContain("never observed funds");
    expect(v.tone).toBe("degraded");
  });

  test("once the dust lands, the tile displays and then earns its zeros", () => {
    const funded = bankLaneView({ feed: feed({ position: { raw: "100000", source: POS_SRC, readAtMs: NOW } }), nowMs: NOW })!;
    expect(funded.position!.status).toBe("funded");
    expect(funded.position!.raw).toBe("100000");

    const after = bankLaneView({
      feed: feed({ calibration: { provenAtMs: NOW - 86_400_000, provenRaw: "100000", provenSource: POS_SRC } }),
      nowMs: NOW,
    })!;
    expect(after.position!.status).toBe("empty");
    expect(after.tone).toBe("ok");
  });
});

describe("float is displayed, or it reads as money that vanished", () => {
  test("the residual operating float gets a real number", () => {
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.float.text).toBe("0.028463 USDC");
    expect(v.float.tone).toBe("ok");
  });

  test("a small float NEVER rounds to zero — that is the whole point of the tile", () => {
    // A fixed 2dp turned the live 28,463-raw float into "0.03" and would have
    // turned 4,000 raw into "0.00 USDC": a real balance displayed as an empty
    // one, on the tile that exists because undisplayed float reads as gone.
    for (const raw of ["4000", "1", "999999"]) {
      const v = bankLaneView({
        feed: feed({ float: { raw, source: "asset 22", readAtMs: NOW } }),
        nowMs: NOW,
      })!;
      expect(Number(v.float.text.split(" ")[0]), `${raw} raw must not render as zero`).toBeGreaterThan(0);
    }
  });

  test("a true zero is still allowed to print as zero", () => {
    const v = bankLaneView({ feed: feed({ float: { raw: "0", source: "asset 22", readAtMs: NOW } }), nowMs: NOW })!;
    expect(v.float.text).toBe("0 USDC");
  });

  test("a stale float withholds the number rather than showing it as current", () => {
    const v = bankLaneView({
      feed: feed({ float: { raw: "28463", source: "asset 22", readAtMs: NOW - BANK_STALE_AFTER_MS - 1 } }),
      nowMs: NOW,
    })!;
    expect(v.float.text).toContain("old");
    expect(v.float.text).not.toContain("0.028");
  });
});

describe("postage is committed, and has its own floor", () => {
  test("1.51 DOT reads as committed postage with no withdraw path", () => {
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.postage.text).toContain("1.51 DOT");
    expect(v.postage.text).toContain("no withdraw path");
    expect(v.postage.tone).toBe("ok");
  });

  test("below the floor the wrapper cannot pay delivery — that stops the lane", () => {
    const v = bankLaneView({
      feed: feed({ postage: { raw: "600000000", source: "15Xbeap…SMAK", readAtMs: NOW } }), // 0.06 DOT
      nowMs: NOW,
    })!;
    expect(v.postage.tone).toBe("red");
    expect(v.postage.text).toContain("BELOW POSTAGE FLOOR");
    expect(v.tone).toBe("red");
  });
});

describe("an overdue request is the stuck-pending alarm, named", () => {
  test("it goes red and names the request id", () => {
    // Named, or the alarm has no next step.
    const v = bankLaneView({
      feed: feed({ requests: [req(), req({ id: "req-9f02", ageSeconds: 5400, overdue: true })] }),
      nowMs: NOW,
    })!;
    expect(v.requests.tone).toBe("red");
    expect(v.requests.text).toContain("req-9f02");
    expect(v.overdueRequestId).toBe("req-9f02");
    expect(v.tone).toBe("red");
  });

  test("terminal requests are not in flight", () => {
    const v = bankLaneView({ feed: feed({ requests: [req({ phase: "terminal" })] }), nowMs: NOW })!;
    expect(v.requests.text).toBe("no requests in flight");
  });

  test("overdue is the OBSERVER's judgement — never recomputed from the age", () => {
    // Two services deriving one deadline eventually disagree, and then there
    // are two answers to a question that must have one.
    const ancientButNotOverdue = bankLaneView({
      feed: feed({ requests: [req({ ageSeconds: 999_999, overdue: false })] }),
      nowMs: NOW,
    })!;
    expect(ancientButNotOverdue.requests.tone).toBe("ok");
    expect(ancientButNotOverdue.overdueRequestId).toBeNull();
  });
});
