import { describe, expect, test } from "vitest";

import { BANK_STALE_AFTER_MS, bankLaneView } from "../../src/bank-lane.js";
import type { BankFeed, BankRequest } from "../../src/bank-feed.js";

const NOW = 1_785_900_000_000;
// v2.1 converted account, truncate20'd for the aUSDC balanceOf. Used
// symmetrically as the calibration proven-source, so the retarget tests below
// exercise the mechanism regardless of which generation it names.
const POS_SRC = "aUSDC 0x2ec48840…fa93 · balanceOf(0x85663dfd…99f8f4)";

const feed = (over: Partial<BankFeed> = {}): BankFeed => ({
  position: { raw: "0", source: POS_SRC, readAtMs: NOW - 30_000 },
  float: { raw: "28463", source: "asset 22 · Tokens.accounts(convertedAccount)", readAtMs: NOW - 30_000 },
  // 0.2697 DOT at the v2.1 wrapper image — 0.3 committed at the arming
  // ceremony, less leg 1's delivery fees. The v2.0 image (15Xbeap…SMAK, 1.51
  // DOT) is retired and written off; reading it was the 2026-08-04 incident.
  postage: { raw: "2697000000", source: "1yKNU414…UKBaZ", readAtMs: NOW - 30_000 },
  requests: { items: [], readAtMs: NOW - 30_000 },
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
    expect(v.float.text).toBe("0.028463 USDC · 28,463 raw");
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
      expect(v.float.text, "raw must be shown for reconciliation").toContain("raw");
    }
  });

  test("a true zero is still allowed to print as zero", () => {
    const v = bankLaneView({ feed: feed({ float: { raw: "0", source: "asset 22", readAtMs: NOW } }), nowMs: NOW })!;
    expect(v.float.text).toBe("0 USDC · 0 raw");
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
  test("0.2697 DOT reads as committed postage with no withdraw path", () => {
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.postage.text).toContain("0.2697 DOT");
    expect(v.postage.text).toContain("no withdraw path");
    expect(v.postage.tone).toBe("ok");
  });

  test("below the floor the wrapper cannot pay delivery — that stops the lane", () => {
    const v = bankLaneView({
      feed: feed({ postage: { raw: "600000000", source: "1yKNU414…UKBaZ", readAtMs: NOW } }), // 0.06 DOT
      nowMs: NOW,
    })!;
    expect(v.postage.tone).toBe("red");
    expect(v.postage.text).toContain("BELOW POSTAGE FLOOR");
    expect(v.tone).toBe("red");
  });
});

describe("an unreadable request table is never 'all clear'", () => {
  test("a read error does NOT render as no requests in flight", () => {
    // The worst version of absence-is-not-zero on this lane: the tile whose
    // entire job is the stuck-pending alarm, reporting all clear because
    // nobody could read the table.
    const v = bankLaneView({
      feed: feed({ requests: { items: [], readAtMs: NOW, lastError: "indexer 502" } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("unreadable");
    expect(v.requests.text).not.toContain("no requests");
    expect(v.tone).toBe("degraded");
  });

  test("never read yet says the in-flight state is unknown", () => {
    const v = bankLaneView({ feed: feed({ requests: { items: [], readAtMs: null } }), nowMs: NOW })!;
    expect(v.requests.text).toContain("unknown");
    expect(v.requests.tone).toBe("awaiting");
  });

  test("a stale table is not current, and says which", () => {
    const v = bankLaneView({
      feed: feed({ requests: { items: [], readAtMs: NOW - BANK_STALE_AFTER_MS - 1 } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("not current");
    expect(v.requests.tone).toBe("degraded");
  });

  test("a genuinely empty table IS all clear", () => {
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.requests.text).toBe("no requests in flight");
    expect(v.requests.tone).toBe("ok");
  });
});

describe("an unrecognised phase is surfaced, never dropped", () => {
  test("an unknown phase is counted, named verbatim, and flagged", () => {
    // The observer owns this vocabulary and may extend it. A request in a phase
    // this board has never heard of is the most unusual one in the table, which
    // makes hiding it exactly backwards.
    // "recovery-pending" used to be the specimen here; it is DOCUMENTED
    // vocabulary now (feed-synthesized, per Codex's 2026-08-05 contract
    // answer), so the specimen must be a genuine stranger.
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ id: "req-77", phase: "phase-from-the-future" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("1 in flight");
    expect(v.requests.text).toContain('unrecognised — investigate: phase "phase-from-the-future"');
    expect(v.requests.text).toContain("req-77");
    expect(v.requests.tone).toBe("degraded");
  });

  test("an unknown phase is NOT treated as terminal", () => {
    // Fail toward visibility: treating it as finished would silently retire a
    // request nobody has accounted for.
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "something-new" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).not.toBe("no requests in flight");
  });

  test("an overdue unknown-phase request still raises the alarm", () => {
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ id: "req-x", phase: "weird", overdue: true })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.tone).toBe("red");
    expect(v.overdueRequestId).toBe("req-x");
  });
});

describe("an overdue request is the stuck-pending alarm, named", () => {
  test("it goes red and names the request id", () => {
    // Named, or the alarm has no next step.
    const v = bankLaneView({
      feed: feed({ requests: { items: [req(), req({ id: "req-9f02", ageSeconds: 5400, overdue: true })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.tone).toBe("red");
    expect(v.requests.text).toContain("req-9f02");
    expect(v.overdueRequestId).toBe("req-9f02");
    expect(v.tone).toBe("red");
  });

  test("terminal requests are not in flight", () => {
    const v = bankLaneView({ feed: feed({ requests: { items: [req({ phase: "terminal" })], readAtMs: NOW } }), nowMs: NOW })!;
    expect(v.requests.text).toBe("no requests in flight");
  });

  test("the five 2026-08-14 finalize-error recalls render closed with their failure reason", () => {
    const items = Array.from({ length: 5 }, (_, index) => req({
      id: `recall-2026-08-14-${index + 1}`,
      phase: "finalize-error",
      status: "error",
      finalization: {
        status: "error",
        attemptCount: 1,
        lastError: "FAILED: XCM destination rejected the recall",
        lastTriedAt: null,
        nextAttemptAt: null,
      },
    }));
    const v = bankLaneView({ feed: feed({ requests: { items, readAtMs: NOW } }), nowMs: NOW })!;

    expect(v.requests.text).toContain("5 CLOSED ERROR");
    expect(v.requests.text).toContain("XCM destination rejected the recall");
    expect(v.requests.text).not.toContain("in flight");
    expect(v.requests.text).not.toContain("pending");
  });

  test("FAILED is terminal while a genuinely pending request remains pending", () => {
    const failed = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "pending-finalize", status: "FAILED", reason: "remote failed" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    const pending = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "pending-finalize", status: "pending" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;

    expect(failed.requests.text).toContain("1 CLOSED FAILED");
    expect(failed.requests.text).toContain("remote failed");
    expect(pending.requests.text).toContain("1 in flight");
  });

  test("terminal failure renders the five-line reconciliation and artifact label", () => {
    const v = bankLaneView({
      feed: feed({
        requests: {
          items: [req({
            phase: "terminal",
            status: "failed",
            reconciliation: {
              stagedRaw: "150000",
              actualTreasuryReturnRaw: "130200",
              leg1TransferFeeRaw: "525",
              trappedWriteOff3Raw: "17932",
              recoveryReturnFeeRaw: "1343",
              unexplainedRaw: "0",
              finalRawRecoverySlotResidueRaw: "19800",
              artifactLabel: "v2.1 accounting artifact, known-unrecoverable",
            },
          })],
          readAtMs: NOW,
        },
      }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("150000 staged = 130200 treasury");
    expect(v.requests.text).toContain("17932 trapped write-off #3");
    expect(v.requests.text).toContain("1343 recovery fee");
    expect(v.requests.text).toContain("0 unexplained");
    expect(v.requests.text).toContain("19800 residue");
    expect(v.requests.text).toContain("v2.1 accounting artifact, known-unrecoverable");
    expect(v.requests.text).not.toContain("recoveryAssetsOutstanding");
    expect(v.requests.tone).toBe("degraded");
  });

  test("overdue is the OBSERVER's judgement — never recomputed from the age", () => {
    // Two services deriving one deadline eventually disagree, and then there
    // are two answers to a question that must have one.
    const ancientButNotOverdue = bankLaneView({
      feed: feed({ requests: { items: [req({ ageSeconds: 999_999, overdue: false })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(ancientButNotOverdue.requests.tone).toBe("ok");
    expect(ancientButNotOverdue.overdueRequestId).toBeNull();
  });
});

// ── THE v2.2 CONTRACT, LEARNED THE EXPENSIVE WAY ──────────────────────────
//
// On 2026-08-05 a staged v2.2 request read `1 in flight · staged-on-chain-
// backfill for 11.2h`, calm, while its on-chain dispatch deadline ran down.
// It needed an OPERATOR to dispatch it; nobody knew; it lapsed with 19 minutes
// of warning available and none rendered. Codex's contract answer settled the
// semantics these tests pin.
describe("the documented v2.2 vocabulary is recognised", () => {
  test("staged-on-chain-backfill no longer trips the stranger flag", () => {
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "staged-on-chain-backfill" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).not.toContain("unrecognised");
  });

  test("the first v2.2 dispatch phase will not cry wolf either", () => {
    // "Merely adding this one label will fail again at the first v2.2
    // dispatch" — Codex, answering why there is no closed enum. The whole
    // documented set is in, so the flag is reserved for genuine strangers.
    for (const phase of ["registered", "staged-on-chain", "leg-0-dispatched-on-chain", "leg-3-dispatched-on-chain", "scope-unknown", "snapshot-invalid"]) {
      const v = bankLaneView({
        feed: feed({ requests: { items: [req({ phase })], readAtMs: NOW } }),
        nowMs: NOW,
      })!;
      expect(v.requests.text, phase).not.toContain("unrecognised");
    }
  });
});

describe("a staged request names who it is waiting for", () => {
  test("staged phases carry 'awaiting operator dispatch'", () => {
    // The producer's contract: staged requests do not dispatch autonomously —
    // an operator must act. A calm "in flight" hid exactly that.
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "staged-on-chain-backfill" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("awaiting operator dispatch");
  });

  test("autonomous phases do not claim to wait on anyone", () => {
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "leg-1-dispatched-on-chain" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).not.toContain("awaiting operator");
  });
});

describe("the deadline clock renders when the feed sends it — and never otherwise", () => {
  test("a future deadline is shown as time remaining", () => {
    const v = bankLaneView({
      feed: feed({
        requests: {
          items: [req({ phase: "staged-on-chain-backfill", deadlineAtMs: NOW + 19 * 60_000 })],
          readAtMs: NOW,
        },
      }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).toContain("deadline in 19m");
  });

  test("an overdue request shows how long ago its deadline lapsed", () => {
    const v = bankLaneView({
      feed: feed({
        requests: {
          items: [req({ phase: "staged-on-chain-backfill", overdue: true, deadlineAtMs: NOW - 2 * 3_600_000 })],
          readAtMs: NOW,
        },
      }),
      nowMs: NOW,
    })!;
    expect(v.requests.tone).toBe("red");
    // formatAge renders hours with one decimal ("2.0h") — same as the age.
    expect(v.requests.text).toContain("deadline lapsed 2.0h ago");
  });

  test("no field, no clock — a deadline nobody sent is not displayed", () => {
    // The producer computes overdue FROM deadlineAt but does not emit it yet.
    // Until it ships, rendering any deadline would be inventing one.
    const v = bankLaneView({
      feed: feed({ requests: { items: [req({ phase: "leg2-dispatched" })], readAtMs: NOW } }),
      nowMs: NOW,
    })!;
    expect(v.requests.text).not.toContain("deadline");
  });
});
