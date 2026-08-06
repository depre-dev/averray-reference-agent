// A reading can be fresh, sourced, persisted — and about the wrong subject.
//
// 2026-08-04: the BANK lane's first live values were reads of a wrapper retired
// that morning. float 149,412 at the RETIRED converted account while the live
// one held 149,475 with a request staged for leg 2; postage from the old
// wrapper image; an empty request table because the observer had never seen the
// live wrapper. Every tile was fresh, correctly sourced and honestly rendered.
//
// Two checks were run against the request tile at the time and BOTH passed:
// readAtMs was recent, and the state was Redis-backed so it had survived the
// restart. Freshness and persistence. Neither asks WHAT was read, so two sound
// checks produced a false all-clear on the stuck-pending alarm.

import { describe, expect, test } from "vitest";

import { bankSubjectIsCurrent, type BankFeed } from "../../src/bank-feed.js";
import { bankLaneView } from "../../src/bank-lane.js";
import { normalizeBankFeed } from "../../src/bank-feed-fetch.js";

const NOW = 1_785_900_000_000;
const V21 = "0x2AF394fA95f75D3ca1C786128f4dfA1eB0c9675D";
const V20 = "0x8d1a1De9F5C4C8b4C0eB1a3f2D9a7B6c5E4d3C2b";
const V221 = "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc";

const evaluatedSubject = (over: Record<string, unknown> = {}) => ({
  configuredWrapper: V221,
  uniqueArmedWrapper: null,
  matches: true,
  status: "paused",
  reason: "administratively_paused",
  candidates: [
    { version: "2.2", wrapper: V21, dispatchPaused: true, lastError: null },
    { version: "2.2.1", wrapper: V221, dispatchPaused: true, lastError: null },
  ],
  readAtMs: NOW,
  lastError: null,
  ...over,
});

/** The retired generation's numbers, exactly as the board showed them. */
const feed = (over: Partial<BankFeed> = {}): BankFeed => ({
  position: { raw: "0", source: "erc20:0x2ec4…fa93.balanceOf(0x98f0…b68e)", readAtMs: NOW - 30_000 },
  float: { raw: "149412", source: "substrate_tokens:22", readAtMs: NOW - 30_000 },
  postage: { raw: "14794550000", source: "substrate_system:15Xbeap…", readAtMs: NOW - 30_000 },
  requests: { items: [], readAtMs: NOW - 30_000 },
  ...over,
});

const feedThroughNetwork = (subject: unknown): BankFeed => {
  const base = feed();
  const parsed = normalizeBankFeed({ ...base, subject });
  expect(parsed.reason).toBeUndefined();
  expect(parsed.feed?.subject).toBeDefined();
  return parsed.feed!;
};

describe("the subject line is decided, never blank", () => {
  test("silence is NOT agreement — an undeclared subject says so out loud", () => {
    // The morning this exists for looked exactly like a lane with nothing to
    // say. A producer that does not declare its subject gets an explicit
    // "cannot confirm", not an empty space that reads as fine.
    const v = bankLaneView({ feed: feed(), nowMs: NOW })!;
    expect(v.subject.text).toContain("cannot confirm which wrapper generation");
    // Awaiting, not red: not knowing is not the same as knowing it is wrong.
    expect(v.subject.tone).toBe("awaiting");
  });

  test("...but it must NOT degrade the lane, or every healthy lane goes amber", () => {
    // Caught by an existing test rather than by design: the first cut degraded
    // on an undeclared subject, which is true of EVERY lane until the producer
    // ships the field — a permanently-lit strip for "the other service has not
    // been upgraded yet". Position-unverified earns its degrade because it is
    // temporary and resolves on the next dust cycle. A missing producer
    // capability does not.
    const v = bankLaneView({
      feed: feed({
        calibration: {
          provenAtMs: NOW - 86_400_000,
          provenRaw: "100000",
          provenSource: "erc20:0x2ec4…fa93.balanceOf(0x98f0…b68e)",
        },
      }),
      nowMs: NOW,
    })!;
    expect(v.subject.tone).toBe("awaiting");
    expect(v.tone).toBe("ok");
  });

  test("a matching subject is stated plainly, and costs the lane nothing", () => {
    const v = bankLaneView({
      feed: feed({ subject: { derivedFrom: V21, declared: V21, label: "bank-xcm-v2.1" } }),
      nowMs: NOW,
    })!;
    expect(v.subject.tone).toBe("ok");
    expect(v.subject.text).toContain("bank-xcm-v2.1");
    expect(v.float.tone).toBe("ok");
  });
});

describe("the producer's evaluated subject contract", () => {
  const calibrated = {
    provenAtMs: NOW - 86_400_000,
    provenRaw: "100000",
    provenSource: "erc20:0x2ec4…fa93.balanceOf(0x98f0…b68e)",
  };

  test("paused is a calm third state, with the configured generation and reason", () => {
    const parsed = normalizeBankFeed({
      position: feed().position,
      float: feed().float,
      postage: feed().postage,
      requests: feed().requests,
      calibration: calibrated,
      subject: evaluatedSubject(),
    });
    expect(parsed.feed?.subject).toMatchObject({
      status: "paused",
      reason: "administratively_paused",
      matches: true,
      uniqueArmedWrapper: null,
    });

    const view = bankLaneView({ feed: parsed.feed!, nowMs: NOW })!;
    expect(view.subject).toEqual({
      text: "lane administratively paused (configured generation v2.2.1) — reason: administratively_paused",
      tone: "paused",
      status: "paused",
      reason: "administratively_paused",
    });
    expect(view.tone).toBe("paused");
  });

  test("an unknown status survives verbatim and renders neutral with its reason", () => {
    const view = bankLaneView({
      feed: {
        ...feedThroughNetwork(evaluatedSubject({ status: "future_custody_handoff", reason: "governance_window" })),
        calibration: calibrated,
      },
      nowMs: NOW,
    })!;
    expect(view.subject.text).toContain("future_custody_handoff");
    expect(view.subject.text).toContain("reason: governance_window");
    expect(view.subject.tone).toBe("neutral");
    expect(view.subject.status).toBe("future_custody_handoff");
    expect(view.subject.reason).toBe("governance_window");
    expect(view.tone).toBe("neutral");
  });

  test("a producer error passes through as red with its reason", () => {
    const view = bankLaneView({
      feed: {
        ...feedThroughNetwork(evaluatedSubject({
          status: "error",
          matches: false,
          reason: "multiple_armed_wrappers",
          lastError: "multiple_armed_wrappers",
        })),
        calibration: calibrated,
      },
      nowMs: NOW,
    })!;
    expect(view.subject.text).toContain("lane error");
    expect(view.subject.text).toContain("reason: multiple_armed_wrappers");
    expect(view.subject.tone).toBe("red");
    expect(view.tone).toBe("red");
  });
});

describe("a stale subject invalidates every value below it", () => {
  const stale = () =>
    bankLaneView({
      feed: feed({ subject: { derivedFrom: V20, declared: V21, label: "bank-xcm-v2.1" } }),
      nowMs: NOW,
    })!;

  test("the lane goes RED — above an overdue request, not below it", () => {
    // An overdue request costs money while you watch it. A stale subject means
    // you are not watching at all, and the empty request table is the proof:
    // it read as an all-clear while a real request sat staged on the live
    // wrapper. Being blind outranks seeing something bad.
    expect(stale().tone).toBe("red");
  });

  test("no value tile may render ok — a green float about an abandoned account is the lie", () => {
    const v = stale();
    for (const line of [v.float, v.postage, v.requests]) {
      expect(line.tone).not.toBe("ok");
    }
  });

  test("but the numbers are KEPT, because the retired account's dust is real money", () => {
    // Withholding them would lose a balance somebody still has to reconcile.
    // The fix is to say what they are about, not to hide them.
    const v = stale();
    expect(v.float.text).toContain("149,412 raw");
    expect(v.postage.text).toContain("14,794,550,000 raw");
  });

  test("both addresses render IN FULL", () => {
    // Two generations of the same deploy script can share a prefix and a
    // suffix. The one line whose entire job is telling them apart must not be
    // the line that elides the difference.
    const v = stale();
    expect(v.subject.text).toContain(V20);
    expect(v.subject.text).toContain(V21);
  });

  test("a real overdue request still names itself — the alarm is not swallowed", () => {
    const v = bankLaneView({
      feed: feed({
        subject: { derivedFrom: V20, declared: V21 },
        requests: {
          items: [{ id: "req-9c2f", kind: "deposit", phase: "leg2-dispatched", ageSeconds: 3600, overdue: true }],
          readAtMs: NOW - 30_000,
        },
      }),
      nowMs: NOW,
    })!;
    expect(v.overdueRequestId).toBe("req-9c2f");
    expect(v.tone).toBe("red");
  });
});

describe("checksum casing is not a retarget", () => {
  test("the same address in different EIP-55 casing agrees", () => {
    // A manifest written by a deploy script and an env var typed by a human
    // differ in casing routinely. Reporting that as a stale subject would make
    // this the false alarm it exists to prevent being.
    expect(bankSubjectIsCurrent({ derivedFrom: V21.toLowerCase(), declared: V21.toUpperCase() })).toBe(true);
    expect(bankSubjectIsCurrent({ derivedFrom: ` ${V21} `, declared: V21 })).toBe(true);
  });

  test("genuinely different addresses disagree", () => {
    expect(bankSubjectIsCurrent({ derivedFrom: V20, declared: V21 })).toBe(false);
  });
});

describe("a malformed subject is dropped, never guessed at", () => {
  const payload = {
    position: { raw: "0", source: "erc20:x", readAtMs: NOW },
    float: { raw: "149412", source: "substrate_tokens:22", readAtMs: NOW },
    postage: { raw: "14794550000", source: "substrate_system:x", readAtMs: NOW },
    requests: { items: [], readAtMs: NOW },
  };

  test("half a subject cannot answer the question, so it is discarded", () => {
    // derivedFrom with nothing to compare against is not evidence of anything.
    const r = normalizeBankFeed({ ...payload, subject: { derivedFrom: V21 } });
    expect(r.feed).toBeDefined();
    expect(r.feed!.subject ?? null).toBeNull();
  });

  test("dropping it costs the visible 'cannot confirm' line — the conservative direction", () => {
    // Inventing a match would be the confident green about an abandoned
    // account; inventing a mismatch would RED a lane that is fine.
    const r = normalizeBankFeed({ ...payload, subject: { garbage: true } });
    expect(r.feed!.subject ?? null).toBeNull();
    expect(bankLaneView({ feed: r.feed!, nowMs: NOW })!.subject.tone).toBe("awaiting");
  });

  test("a good subject survives the network boundary intact", () => {
    const r = normalizeBankFeed({ ...payload, subject: { derivedFrom: V20, declared: V21, label: "bank-xcm-v2.1" } });
    expect(r.feed!.subject).toMatchObject({ derivedFrom: V20, declared: V21, label: "bank-xcm-v2.1" });
  });
});
