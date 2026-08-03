import { describe, expect, test } from "vitest";

import {
  DATA_STALE_FALLBACK_MS,
  EVIDENCE_KEY,
  crossCheckLine,
  payoutProvenanceLine,
  METER_RUNGS,
  shortEndpoint,
  staleAfterMs,
  opsVerdict,
  askHermesRow,
  payoutView,
  poolMeter,
  settledByHourReason,
  settledByHourView,
  splitPools,
  trustRows,
  volumeMixNote,
} from "./ops-spec.js";
import type { ProductHealth, SolvencyPool } from "./product-health.js";
import { OPS_FIXTURE_NOMINAL, OPS_FIXTURE_STRESS } from "./ops-fixtures.js";

const NOW = 1_751_500_000_000;

function pool(over: Partial<SolvencyPool> = {}): SolvencyPool {
  return { key: "p", label: "Pool", amount: 10, unit: "USDC", floor: 2, status: "ok", ...over };
}

describe("poolMeter — a meter needs a scale", () => {
  // THE SHIPPED BUG: a deliberately-empty pool with no floor drew a full bar
  // and read as "healthy and full". No floor now means no meter at all.
  test("an unfloored pool gets NO meter", () => {
    expect(poolMeter(pool({ floor: undefined }))).toBeNull();
    expect(poolMeter(pool({ floor: null }))).toBeNull();
    expect(poolMeter(pool({ floor: 0 }))).toBeNull();
  });

  test("an unreadable balance gets NO meter — a bar would be a claim", () => {
    expect(poolMeter(pool({ amount: null }))).toBeNull();
  });

  // The scale is anchored to the FLOOR, not the balance. An auto-fitted bar
  // always looks about two-thirds full — that is fake-green in bar form.
  test("the scale snaps to a floor rung, so the floor tick never moves", () => {
    const gas = poolMeter(pool({ amount: 2.6931, floor: 1 }))!;
    expect(gas.scaleLabel).toBe("4.00");
    expect(gas.floorPct).toBeCloseTo(25, 5);

    const bank = poolMeter(pool({ amount: 15.89, floor: 2 }))!;
    expect(bank.scaleLabel).toBe("20.00");
    expect(bank.floorPct).toBeCloseTo(10, 5);

    const aac = poolMeter(pool({ amount: 26.15, floor: 1 }))!;
    expect(aac.scaleLabel).toBe("30.00");
    expect(aac.floorPct).toBeCloseTo(3.333, 2);
  });

  test("a draining pool visibly drains — same rung, smaller fill", () => {
    const full = poolMeter(pool({ amount: 3.6, floor: 1 }))!;
    const low = poolMeter(pool({ amount: 1.2, floor: 1 }))!;
    expect(full.floorPct).toBe(low.floorPct); // the tick stays put…
    expect(low.fillPct).toBeLessThan(full.fillPct); // …and the bar actually falls
  });

  test("below the floor, the fill is left of the tick — visibly, not just in words", () => {
    const breached = poolMeter(pool({ amount: 1.42, floor: 2 }))!;
    expect(breached.fillPct).toBeLessThan(breached.floorPct);
  });

  test("a balance past the top rung pegs the bar and admits it", () => {
    const huge = poolMeter(pool({ amount: 5_000, floor: 1 }))!;
    expect(huge.overScale).toBe(true);
    expect(huge.fillPct).toBe(100);
    expect(huge.scaleLabel).toBe(String(METER_RUNGS[METER_RUNGS.length - 1]! * 1).concat(".00"));
  });
});

describe("splitPools", () => {
  test("floored pools meter; unfloored ones are listed without a bar", () => {
    const { floored, unfloored } = splitPools([
      pool({ key: "bank", floor: 2 }),
      pool({ key: "reserve", amount: 0, floor: undefined }),
    ]);
    expect(floored.map((v) => v.pool.key)).toEqual(["bank"]);
    expect(unfloored.map((v) => v.pool.key)).toEqual(["reserve"]);
    expect(unfloored[0]!.meter).toBeNull();
  });

  test("an unreadable balance reads '—', never '0.00'", () => {
    const { unfloored } = splitPools([pool({ amount: null })]);
    expect(unfloored[0]!.amountLabel).toBe("—");
    expect(unfloored[0]!.tone).toBe("awaiting");
  });

  test("a breached pool states the shortfall in absolute units", () => {
    const { floored } = splitPools([pool({ amount: 1.42, floor: 2, status: "red" })]);
    expect(floored[0]!.margin).toBe("BELOW FLOOR · short 0.58");
    expect(floored[0]!.marginTone).toBe("red");
  });
});

describe("askHermesRow — can Hermes answer?", () => {
  test("only listening counts as ok", () => {
    // Every other phase means a question asked right now goes unanswered.
    expect(askHermesRow({ phase: "listening", detail: "subscribed", failures: 0 }).tone).toBe("ok");
    for (const phase of ["connecting", "authenticating", "retrying", "misconfigured"] as const) {
      const row = askHermesRow({ phase, detail: "why", failures: 2 });
      expect(row.tone).toBe("degraded");
      expect(row.value).toContain("NOT answering");
    }
  });

  test("off is not a fault", () => {
    // A feature nobody enabled must never render as broken, or the row becomes
    // one more permanently-lit thing to scroll past.
    const row = askHermesRow({ phase: "off", detail: "BUZZ_INBOUND_ENABLED is not set", failures: 0 });
    expect(row.tone).toBe("awaiting");
    expect(row.value).toContain("BUZZ_INBOUND_ENABLED");
  });

  test("an older build says so instead of inventing a status", () => {
    const row = askHermesRow(undefined);
    expect(row.value).toBe("not reported by this build");
    expect(row.tone).toBe("awaiting");
  });

  test("a retrying listener does not look like a quiet one", () => {
    // THE POINT. Without this row a dead listener is found by asking a question
    // and getting silence — indistinguishable from having nothing to say.
    const row = askHermesRow({ phase: "retrying", detail: "relay closed", failures: 3 });
    expect(row.value).toContain("3 failed attempts");
  });
});

describe("payoutView — whether to believe the comparison at all", () => {
  const base = {
    status: "confirmed" as const, detail: "ok",
    confirmedCount: 18, confirmedUsdc: 3.1, settledCount: 18, windowBlocks: 40000,
  };

  test("states the fit even when it is fine, with the numbers behind it", () => {
    // This used to render nothing on a good fit — and on 2026-08-02 the live
    // board showed SHORTFALL −2 with no window information at all, because
    // the fit was ok and therefore silent. A caveat that hides while things
    // look fine is missing every time it would have mattered.
    const view = payoutView({ ...base, window: { status: "ok", detail: "window spans ~24h", blockSeconds: 2.16, spanHours: 24 } });
    expect(view.fit.text).toContain("window fit ok");
    expect(view.fit.text).toContain("40,000 blocks");
    expect(view.fit.text).toContain("2.16s/block");
    // Grey, not green: it is reassurance about the METHOD. Only the money
    // line above is entitled to a status colour.
    expect(view.fit.tone).toBe("awaiting");
  });

  test("a good fit never softens a shortfall above it", () => {
    const view = payoutView({
      ...base,
      status: "shortfall",
      confirmedCount: 19,
      settledCount: 21,
      window: { status: "ok", detail: "window spans ~24h", blockSeconds: 2.22, spanHours: 24 },
    });
    expect(view.status).toBe("SHORTFALL −2");
    expect(view.tone).toBe("red");
    expect(view.emphasised).toBe(true);
    expect(view.fit.text).toContain("window fit ok");
  });

  test("says SUSPECT when the window is not the window it claims to be", () => {
    // A count from an 8h window held against a 24h ledger figure is two
    // different questions rendered as one answer.
    const view = payoutView({
      ...base,
      window: { status: "suspect", detail: "spans ~8.4h, not the 24h it is compared against", blockSeconds: 2.11, spanHours: 8.4 },
    });
    expect(view.fit.text).toContain("WINDOW SUSPECT");
    expect(view.fit.text).toContain("8.4h");
    expect(view.fit.tone).toBe("degraded");
  });

  test("says UNCHECKED rather than implying a pass", () => {
    const view = payoutView({ ...base, window: { status: "unknown", detail: "block time not measured", blockSeconds: null, spanHours: null } });
    expect(view.fit.text).toContain("UNCHECKED");
    expect(view.fit.tone).toBe("degraded");
  });

  test("an older payload with no fit says so, rather than claiming a good one", () => {
    // Absent is not ok. A build that never reported a fit must not render as
    // one that reported a passing fit.
    const view = payoutView(base);
    expect(view.fit.text).toContain("not reported by this build");
    expect(view.fit.text).not.toContain("ok —");
  });

  test("nothing read from the chain is not a passing window", () => {
    expect(payoutView(undefined).fit.text).toContain("no comparison window");
  });
});

describe("provenance — proof without a source is one endpoint's opinion", () => {
  const base = {
    status: "confirmed" as const, detail: "ok", confirmedCount: 18, confirmedUsdc: 3.1,
    settledCount: 18, windowBlocks: 40909,
  };

  test("names the host and the height it was read at", () => {
    const line = payoutProvenanceLine({
      ...base,
      endpoint: { host: "services.polkadothub-rpc.com", block: 19_000_081 },
    });
    expect(line).toBe("proved via services.polkadothub-rpc.com · block 19,000,081");
  });

  test("an older payload claims no source rather than a wrong one", () => {
    expect(payoutProvenanceLine(base)).toBeNull();
    expect(payoutProvenanceLine({ ...base, endpoint: { host: null, block: 19_000_081 } })).toBeNull();
  });
});

describe("crossCheckLine — a tick must never age silently", () => {
  const base = {
    status: "confirmed" as const, detail: "ok", confirmedCount: 18, confirmedUsdc: 3.1,
    settledCount: 18, windowBlocks: 40909,
  };
  const at = (over: Record<string, unknown>) => ({ ...base, crossCheck: { overdue: false, lastAgreedAtMs: null, ...over } as never });

  test("an agreement carries its age, so a stale tick cannot pass as fresh", () => {
    const line = crossCheckLine(
      at({ status: "agree", detail: "A and B agree on 18", lastAgreedAtMs: NOW - 3 * 24 * 3600_000 }),
      NOW,
    )!;
    expect(line.text).toContain("cross-checked ✓");
    expect(line.text).toContain("ago");
    expect(line.tone).toBe("awaiting");
  });

  test("an overdue check says so and goes amber", () => {
    const line = crossCheckLine(
      at({ status: "unavailable", detail: "cross-check could not run — unreachable", overdue: true }),
      NOW,
    )!;
    expect(line.text).toContain("CROSS-CHECK OVERDUE");
    expect(line.tone).toBe("degraded");
  });

  test("a check that failed once is not overdue and stays quiet", () => {
    const line = crossCheckLine(at({ status: "unavailable", detail: "429 rate limited", overdue: false }), NOW)!;
    expect(line.text).not.toContain("OVERDUE");
    expect(line.tone).toBe("awaiting");
  });

  test("not configured is stated, not alarmed", () => {
    // A check nobody enabled is not a check that broke.
    const line = crossCheckLine(at({ status: "not-configured", detail: "no second endpoint configured" }), NOW)!;
    expect(line.tone).toBe("awaiting");
  });

  test("an older payload invents no cross-check state", () => {
    expect(crossCheckLine(base, NOW)).toBeNull();
  });
});

describe("a disagreement suspends the comparison in BOTH directions", () => {
  const disagree = {
    status: "disagree" as const,
    detail: "A reads 18 · B reads 15 — same range, two answers",
    overdue: false,
    lastAgreedAtMs: null,
  };

  test("it overrides CONFIRMED — the instrument cannot vouch for itself", () => {
    const view = payoutView({
      status: "confirmed", detail: "ok", confirmedCount: 18, confirmedUsdc: 3.1,
      settledCount: 18, windowBlocks: 40909, crossCheck: disagree,
    });
    expect(view.status).toBe("ENDPOINTS DISAGREE");
    expect(view.delta).toContain("two answers");
  });

  test("it ALSO overrides SHORTFALL — an unreliable instrument cannot accuse", () => {
    // The same rule that makes a suspect window suppress a shortfall
    // server-side. A shortfall measured by an instrument two providers cannot
    // agree on is not evidence about money.
    const view = payoutView({
      status: "shortfall", detail: "short", confirmedCount: 15, confirmedUsdc: 2.4,
      settledCount: 18, windowBlocks: 40909, crossCheck: disagree,
    });
    expect(view.status).toBe("ENDPOINTS DISAGREE");
    expect(view.status).not.toContain("SHORTFALL");
  });

  test("it is amber and unemphasised — an instrument fault is not a money alarm", () => {
    const view = payoutView({
      status: "confirmed", detail: "ok", confirmedCount: 18, confirmedUsdc: 3.1,
      settledCount: 18, windowBlocks: 40909, crossCheck: disagree,
    });
    expect(view.tone).toBe("degraded");
    expect(view.emphasised).toBe(false);
  });

  test("agreement leaves the verdict entirely alone", () => {
    const view = payoutView({
      status: "shortfall", detail: "short", confirmedCount: 15, confirmedUsdc: 2.4,
      settledCount: 18, windowBlocks: 40909,
      crossCheck: { status: "agree", detail: "A and B agree on 15", overdue: false, lastAgreedAtMs: NOW },
    });
    expect(view.status).toBe("SHORTFALL −3");
    expect(view.tone).toBe("red");
  });

  test("the permanent key names all four states", () => {
    // The key exists so the operator never has to remember which colour meant
    // which. A fourth state that is not in it is a colour with no legend.
    expect(EVIDENCE_KEY).toHaveLength(4);
    expect(EVIDENCE_KEY.map((e) => e.text).join(" ")).toContain("ENDPOINTS DISAGREE");
  });
});

describe("volumeMixNote — self-generated volume must not read as demand", () => {
  const lifecycle = (self: number, external: number) => ({
    selfPosted: { count: self, medianSeconds: 20, slowestSeconds: 79 },
    external: { count: external, medianSeconds: 176, slowestSeconds: 176 },
    externalPct: self + external === 0 ? null : Math.round((external / (self + external)) * 100),
    unmeasurable: 0,
  });

  test("names Averray as the poster, in words a stranger cannot misread", () => {
    // "18 self-posted" needs context the reader may not have. Someone glancing
    // at this — or at a screenshot of it months later — must not read Averray's
    // own pipeline volume as third-party demand.
    const v = volumeMixNote({ lifecycle: lifecycle(18, 0), settledCount: 18 })!;
    expect(v.text).toBe("18 settled — 18 posted by Averray · 0 external");
  });

  test("zero external is stated, never omitted", () => {
    // Dropping an empty bucket is how "no external demand yet" becomes
    // invisible, which is the one fact the line exists to keep visible.
    const v = volumeMixNote({ lifecycle: lifecycle(9, 0), settledCount: 9 })!;
    expect(v.text).toContain("0 external");
  });

  test("the parts sum to the ledger count", () => {
    const v = volumeMixNote({ lifecycle: lifecycle(17, 1), settledCount: 18 })!;
    const nums = [...v.text.matchAll(/(\d+) (?:posted by Averray|external|unclassified)/g)].map((m) => Number(m[1]));
    expect(nums.reduce((a, b) => a + b, 0)).toBe(18);
  });

  test("a job the chain never saw is UNCLASSIFIED, never folded into a bucket", () => {
    // The split comes from the chain, the total from the product's ledger.
    // They can disagree — and "external" is the one number on this board that
    // nobody should be able to inflate by accident.
    const v = volumeMixNote({ lifecycle: lifecycle(17, 1), settledCount: 21 })!;
    expect(v.text).toContain("3 unclassified");
    expect(v.text).toContain("1 external");
    expect(v.tone).toBe("degraded");
  });

  test("a gap of ONE is named but not alarmed — it is the steady state", () => {
    // Seen live on three separate reads: 14/15, 15/16, 17/18, always exactly
    // one. It is the most recently settled job, confirmed by the ledger before
    // its log is inside the block window. Structural and benign — and a line
    // that is amber on every read forever is a line nobody reads, which would
    // cost precisely the case it exists for.
    const v = volumeMixNote({ lifecycle: lifecycle(14, 0), settledCount: 15 })!;
    expect(v.text).toContain("1 unclassified");
    expect(v.tone).toBe("awaiting");
  });

  test("past the tolerance it DOES alarm — the count is never suppressed", () => {
    const v = volumeMixNote({ lifecycle: lifecycle(14, 0), settledCount: 17 })!;
    expect(v.text).toContain("3 unclassified");
    expect(v.tone).toBe("degraded");
  });

  test("more chain settlements than ledger reads as a window edge", () => {
    const v = volumeMixNote({ lifecycle: lifecycle(19, 1), settledCount: 18 })!;
    expect(v.text).toContain("2 beyond the ledger window");
    expect(v.text).not.toContain("unclassified");
  });

  test("a clean reconciliation stays quiet", () => {
    expect(volumeMixNote({ lifecycle: lifecycle(18, 0), settledCount: 18 })!.tone).toBe("awaiting");
  });

  test("no lifecycle, no line — rather than a line claiming zero of everything", () => {
    expect(volumeMixNote({ lifecycle: undefined, settledCount: 18 })).toBeNull();
  });
});

describe("settledByHourView — an unread hour is a hole, not a quiet hour", () => {
  const slices = (spec: Array<[count: number, covered: boolean]>) =>
    spec.map(([count, covered], i) => ({ hoursAgo: i + 1, count, covered }));
  const withHours = (spec: Array<[number, boolean]>, peak: number, total: number) => ({
    status: "confirmed" as const, detail: "ok", confirmedCount: total, confirmedUsdc: 1,
    settledCount: total, windowBlocks: 40909,
    byHour: { slices: slices(spec), total, peak, coveredHours: spec.filter((s) => s[1]).length, blocksPerHour: 1704 },
  });

  test("oldest hour reads leftmost, so the row runs forward in time", () => {
    const view = settledByHourView(withHours([[4, true], [1, true], [0, true]], 4, 5))!;
    expect(view.bars.map((b) => b.hoursAgo)).toEqual([3, 2, 1]);
  });

  test("an unobserved hour gets NO bar and is flagged, not drawn at zero", () => {
    // Zero height beside real hours reads as "nothing paid out then" — a claim
    // the instrument never made, and the exact class of lie this board exists
    // to prevent.
    const view = settledByHourView(withHours([[3, true], [0, false], [0, false]], 3, 3))!;
    const unread = view.bars.filter((b) => !b.covered);
    expect(unread).toHaveLength(2);
    for (const b of unread) {
      expect(b.heightPct).toBe(0);
      expect(b.title).toContain("not read");
    }
    expect(view.gapNote).toBe("2h not read");
  });

  test("a genuinely quiet observed hour is a real zero and says so", () => {
    const view = settledByHourView(withHours([[3, true], [0, true]], 3, 3))!;
    const quiet = view.bars.find((b) => b.hoursAgo === 2)!;
    expect(quiet.covered).toBe(true);
    expect(quiet.heightPct).toBe(0);
    expect(quiet.title).toContain("0 confirmed on-chain");
    expect(view.gapNote).toBe("");
  });

  test("a single-payout hour beside a busy one is still visible", () => {
    // 1/40 rounds to 3% — under a pixel on a 46px row. "Too small to draw" and
    // "did not happen" must not look the same.
    const view = settledByHourView(withHours([[40, true], [1, true]], 40, 41))!;
    expect(view.bars.find((b) => b.hoursAgo === 2)!.heightPct).toBeGreaterThanOrEqual(8);
  });

  test("the caption names the chain, never the ledger", () => {
    // These bars are the independent read. Calling them "settled" would
    // reattribute them to the funnel's own count.
    const view = settledByHourView(withHours([[2, true]], 2, 2))!;
    expect(view.caption).toContain("confirmed on-chain");
    expect(view.caption).not.toContain("settled");
  });

  test("no chart at all when it could not be sliced — with the reason", () => {
    const payout = {
      status: "confirmed" as const, detail: "ok", confirmedCount: 3, confirmedUsdc: 1,
      settledCount: 3, windowBlocks: 40909,
      byHour: { reason: "block time not measured — hours cannot be derived from block numbers" },
    };
    expect(settledByHourView(payout)).toBeNull();
    expect(settledByHourReason(payout)).toContain("block time not measured");
  });

  test("an older payload invents neither a chart nor a fault", () => {
    const payout = {
      status: "confirmed" as const, detail: "ok", confirmedCount: 3, confirmedUsdc: 1,
      settledCount: 3, windowBlocks: 40909,
    };
    expect(settledByHourView(payout)).toBeNull();
    expect(settledByHourReason(payout)).toBeNull();
  });
});

describe("CONFIRMED says what it actually confirmed", () => {
  const base = { status: "confirmed" as const, detail: "ok", confirmedUsdc: 1.8, windowBlocks: 40909 };

  test("no gap is stated as no gap", () => {
    const view = payoutView({ ...base, confirmedCount: 16, settledCount: 16 });
    expect(view.delta).toBe("proof matches ledger — no gap");
    expect(view.tone).toBe("ok");
  });

  test("a TOLERATED gap is not described as no gap", () => {
    // The live board on 2026-08-03: 15 confirmed, 16 settled, status confirmed
    // because the default tolerance is 1 — printed under the words "no gap",
    // with 15 and 16 on the row above it.
    const view = payoutView({ ...base, confirmedCount: 15, settledCount: 16 });
    expect(view.delta).not.toContain("no gap");
    expect(view.delta).toContain("1 settled job not yet proven on-chain");
    expect(view.delta).toContain("not a shortfall");
    // Still sage, still unemphasised: the tolerance exists because a job on the
    // window edge is expected, and paging for it would be a false red.
    expect(view.tone).toBe("ok");
    expect(view.emphasised).toBe(false);
  });

  test("more proof than ledger reads as a window edge, not a discrepancy", () => {
    const view = payoutView({ ...base, confirmedCount: 17, settledCount: 16 });
    expect(view.delta).toContain("1 more payout on-chain than settled");
    expect(view.delta).not.toContain("no gap");
  });

  test("nothing to compare against never claims a match with a ledger", () => {
    const view = payoutView({ ...base, confirmedCount: 15, settledCount: null });
    expect(view.delta).not.toContain("no gap");
  });
});

describe("payoutView — the fee exclusion is explained on screen", () => {
  const base = {
    status: "confirmed" as const, detail: "ok",
    confirmedCount: 19, confirmedUsdc: 3.1, settledCount: 16, windowBlocks: 43200,
  };

  test("names the fee credits that were excluded from the count", () => {
    // Excluding fees moved a number the operator had been reading for weeks.
    // Without this the count silently drops and nothing explains why — which is
    // its own kind of dishonesty about a money figure.
    const view = payoutView({ ...base, feeCount: 1, feeUsdc: 0.05, feesSeparated: true });
    expect(view.line1).toContain("1 fee credit");
    expect(view.line1).toContain("excluded");
  });

  test("says so when fees could NOT be separated", () => {
    // The count may still include fees. Silence here would let a conflated
    // number read as a clean one.
    const view = payoutView({ ...base, feeCount: null, feeUsdc: null, feesSeparated: false });
    expect(view.line1).toContain("fees not separated");
  });

  test("stays quiet when fees were separable and there were none", () => {
    // Nothing to explain. A permanent "0 fees excluded" is the noise that
    // teaches an operator to stop reading the line.
    const view = payoutView({ ...base, feeCount: 0, feeUsdc: 0, feesSeparated: true });
    expect(view.line1).not.toContain("fee");
  });

  test("stays quiet on a payload that predates the split", () => {
    // An older monitor claims nothing either way; inventing a note would be a
    // statement it never made.
    expect(payoutView(base).line1).not.toContain("fee");
  });

  test("does not change the verdict", () => {
    // Fees explain WHICH settlements were counted. They must not affect whether
    // payouts reconcile.
    const view = payoutView({ ...base, feeCount: 3, feeUsdc: 0.105, feesSeparated: true });
    expect(view.status).toBe("CONFIRMED");
    expect(view.tone).toBe("ok");
    expect(view.emphasised).toBe(false);
  });
});

describe("payoutView — instrument broken vs money broken", () => {
  // The distinction the whole row exists for. `unverified` means we cannot see
  // the chain; paging on it is the false red that teaches an operator to ignore
  // the real one.
  test("unverified is warm grey and NOT emphasised", () => {
    const view = payoutView({
      status: "unverified",
      detail: "chain log read failed",
      confirmedCount: null,
      confirmedUsdc: null,
      settledCount: 14,
      windowBlocks: null,
    });
    expect(view.tone).toBe("awaiting");
    expect(view.emphasised).toBe(false);
    expect(view.delta).not.toMatch(/money did not move/i);
  });

  test("shortfall is coral, emphasised, and names the gap", () => {
    const view = payoutView({
      status: "shortfall",
      detail: "",
      confirmedCount: 12,
      confirmedUsdc: 1.44,
      settledCount: 14,
      windowBlocks: 43200,
    });
    expect(view.tone).toBe("red");
    expect(view.emphasised).toBe(true);
    expect(view.status).toBe("SHORTFALL −2");
    expect(view.delta).toMatch(/2 settled jobs have no on-chain proof/);
  });

  test("no payout block at all is unverified, never confirmed", () => {
    const view = payoutView(undefined);
    expect(view.tone).toBe("awaiting");
    expect(view.status).toBe("UNVERIFIED");
  });

  test("confirmed states both sources so the match is checkable", () => {
    const view = payoutView({
      status: "confirmed",
      detail: "",
      confirmedCount: 14,
      confirmedUsdc: 1.7,
      settledCount: 14,
      windowBlocks: 43200,
    });
    expect(view.line1).toContain("14 payouts confirmed on-chain");
    expect(view.line2).toContain("14 marked settled");
  });
});

describe("opsVerdict", () => {
  test("a healthy mainnet read is NOMINAL and says the money is proven", () => {
    const v = opsVerdict({ health: OPS_FIXTURE_NOMINAL, streamDegraded: false, nowMs: OPS_FIXTURE_NOMINAL.at! + 2_000 });
    expect(v.verdict).toBe("NOMINAL");
    expect(v.verdictTone).toBe("ok");
    expect(v.sub).toContain("proven on-chain");
  });

  test("a breached floor outranks everything and names the pool", () => {
    const v = opsVerdict({ health: OPS_FIXTURE_STRESS, streamDegraded: true, nowMs: NOW });
    expect(v.verdict).toContain("REWARD BANK BELOW FLOOR");
    expect(v.verdictTone).toBe("red");
  });

  // A calm verdict over four-minute-old numbers is the exact lie this board
  // exists not to tell. The stream does not invent a verdict — it relabels one.
  test("a degraded stream relabels the verdict as LAST KNOWN STATE", () => {
    const v = opsVerdict({ health: OPS_FIXTURE_NOMINAL, streamDegraded: true, nowMs: OPS_FIXTURE_NOMINAL.at! + 2_000 });
    expect(v.kicker).toContain("LAST KNOWN STATE");
    expect(v.kickerTone).toBe("red");
    // …but the underlying health verdict is still reported honestly.
    expect(v.verdict).toBe("NOMINAL");
  });

  test("stale data alone is enough to relabel, even on an open stream", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const v = opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 6 * 60_000 });
    expect(v.kicker).toContain("DATA STALE");
  });

  // THE FALSE RED, PINNED. The threshold was a flat 3 minutes against a
  // 2-minute heartbeat, so one late check lit "every value below may be wrong"
  // over a healthy mainnet — and it was lit most of the time. An alarm that is
  // always on is one the operator learns to scroll past.
  test("one missed check does NOT raise a stale alarm", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    // 3 minutes old: a late check on a 2-minute cadence. Not an incident.
    const v = opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 3 * 60_000 });
    expect(v.kicker).toContain("OPERATOR VERDICT");
    expect(v.kicker).not.toContain("STALE");
  });

  test("the threshold follows the reported cadence rather than a constant", () => {
    const slow = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 10 * 60_000 };
    // 20 minutes is two intervals on a 10-minute cadence — still not stale…
    expect(
      opsVerdict({ health: slow, streamDegraded: false, nowMs: slow.at! + 20 * 60_000 }).kicker,
    ).toContain("OPERATOR VERDICT");
    // …while the same age on a 2-minute cadence is long past it.
    const fast = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    expect(
      opsVerdict({ health: fast, streamDegraded: false, nowMs: fast.at! + 20 * 60_000 }).kicker,
    ).toContain("DATA STALE");
  });

  // A too-tight guess is what produced the false alarm, so an unknown cadence
  // errs generous rather than crying stale.
  test("an unreported cadence falls back generously, not tightly", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: undefined };
    expect(staleAfterMs(health)).toBe(DATA_STALE_FALLBACK_MS);
    expect(
      opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 5 * 60_000 }).kicker,
    ).toContain("OPERATOR VERDICT");
  });

  // Being unable to SEE the money must not be shouted as money being broken.
  test("unverified payout evidence does not raise the verdict", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      flow: {
        ...OPS_FIXTURE_NOMINAL.flow,
        payout: {
          status: "unverified",
          detail: "chain unreadable",
          confirmedCount: null,
          confirmedUsdc: null,
          settledCount: 9,
          windowBlocks: null,
        },
      },
    };
    const v = opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 2_000 });
    expect(v.verdict).toBe("NOMINAL");
    expect(v.verdictTone).toBe("ok");
  });

  // Mainnet `capabilities` has read "4/7 up · 2 warnings acknowledged" for
  // weeks. Letting it own the headline forever trains the operator to ignore
  // the headline — a false red costs as much as a false green.
  test("an acknowledged degradation does not own the headline, but is still counted", () => {
    const v = opsVerdict({
      health: OPS_FIXTURE_NOMINAL,
      streamDegraded: false,
      nowMs: OPS_FIXTURE_NOMINAL.at! + 2_000,
    });
    expect(v.verdict).toBe("NOMINAL");
    expect(v.sub).toContain("1 degraded (acknowledged)");
  });

  test("an UNacknowledged degradation still takes the headline", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      probes: OPS_FIXTURE_NOMINAL.probes.map((p) =>
        p.name === "capabilities" ? { ...p, detail: "2/2 required up · xcmObserver staged" } : p,
      ),
    };
    const v = opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 2_000 });
    expect(v.verdict).toBe("CAPABILITIES DEGRADED");
  });

  // Acknowledgement must never be able to silence a page.
  test("a red probe is never acknowledgeable", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      solvency: undefined,
      probes: OPS_FIXTURE_NOMINAL.probes.map((p) =>
        p.name === "money_path"
          ? { ...p, status: "red" as const, detail: "6 stuck — acknowledged by nobody" }
          : p,
      ),
    };
    const v = opsVerdict({ health, streamDegraded: false, nowMs: health.at! + 2_000 });
    expect(v.verdict).toContain("MONEY PATH RED");
    expect(v.verdictTone).toBe("red");
  });

  test("monitoring off is NOT WATCHING, not a green board", () => {
    const v = opsVerdict({
      health: { enabled: false, at: null, status: "unknown", checks: 0, probes: [] },
      streamDegraded: false,
      nowMs: NOW,
    });
    expect(v.verdict).toBe("NOT WATCHING");
    expect(v.verdictTone).toBe("awaiting");
  });

  test("no checks yet is NO DATA YET, not nominal", () => {
    const v = opsVerdict({
      health: { enabled: true, at: null, status: "unknown", checks: 0, probes: [] },
      streamDegraded: false,
      nowMs: NOW,
    });
    expect(v.verdict).toBe("NO DATA YET");
  });

  test("the subline counts awaiting probes separately from degraded ones", () => {
    const health: ProductHealth = {
      enabled: true,
      at: NOW,
      status: "degraded",
      checks: 4,
      probes: [
        { name: "product_api", status: "ok", detail: "200", sparkline: [] },
        { name: "treasury_liquidity", status: "degraded", detail: "awaiting /health addresses", sparkline: [] },
      ],
    };
    const v = opsVerdict({ health, streamDegraded: false, nowMs: NOW });
    expect(v.verdict).toBe("NOMINAL"); // an awaiting probe is not a degradation
    expect(v.sub).toContain("1 awaiting data");
  });
});

describe("trustRows", () => {
  test("an unknown monitor build reads unknown, never current", () => {
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, self: undefined };
    const rows = trustRows({ health, streamDegraded: false, streamStatus: "open", nowMs: health.at! });
    const monitor = rows.find((r) => r.key === "MONITOR")!;
    expect(monitor.value).toBe("build unknown");
    expect(monitor.tone).toBe("awaiting");
  });

  test("a behind build says merged work is not live", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      self: { status: "behind", detail: "", runningSha: "abcdef1234", behindBy: 3, oldestUnshippedAt: null },
    };
    const rows = trustRows({ health, streamDegraded: false, streamStatus: "open", nowMs: health.at! });
    const monitor = rows.find((r) => r.key === "MONITOR")!;
    expect(monitor.value).toContain("3 behind main");
    expect(monitor.tone).toBe("degraded");
  });

  test("the last event time comes from the snapshot, not the wall clock", () => {
    const rows = trustRows({
      health: OPS_FIXTURE_NOMINAL,
      streamDegraded: false,
      streamStatus: "open",
      streamAt: "2026-05-28T10:30:00Z",
      nowMs: NOW,
    });
    expect(rows.find((r) => r.key === "STREAM")!.value).toBe("live · last event 10:30:00");
  });

  // Caught on the phone, which cannot hide it behind an ellipsis the way the
  // desktop did: activeEndpoint is a full URL in prod and took the whole line.
  test("the RPC endpoint shows its host, not the whole URL", () => {
    expect(shortEndpoint("https://services.polkadothub-rpc.com/mainnet/")).toBe(
      "services.polkadothub-rpc.com",
    );
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      remediation: {
        state: "armed",
        enabled: true,
        activeEndpoint: "https://services.polkadothub-rpc.com/mainnet/",
        onBackup: false,
        detail: "armed · primary https://services.polkadothub-rpc.com/mainnet/",
      },
    };
    const rpc = trustRows({ health, streamDegraded: false, streamStatus: "open", nowMs: health.at! })
      .find((r) => r.key === "RPC")!;
    expect(rpc.value).toBe("armed · primary services.polkadothub-rpc.com");
    expect(rpc.value).not.toContain("https://");
  });

  test("a short endpoint name is left exactly as it is", () => {
    expect(shortEndpoint("rpc-1")).toBe("rpc-1");
    expect(shortEndpoint("")).toBeNull();
    expect(shortEndpoint(null)).toBeNull();
  });

  test("no failover configured is awaiting, not a green 'armed'", () => {
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, remediation: undefined };
    const rows = trustRows({ health, streamDegraded: false, streamStatus: "open", nowMs: health.at! });
    const rpc = rows.find((r) => r.key === "RPC")!;
    expect(rpc.tone).toBe("awaiting");
    expect(rpc.value).toContain("single endpoint");
  });

  test("a stale snapshot marks DATA AGE red even while the stream is open", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const rows = trustRows({
      health,
      streamDegraded: false,
      streamStatus: "open",
      nowMs: health.at! + 10 * 60_000,
    });
    expect(rows.find((r) => r.key === "DATA AGE")!.tone).toBe("red");
  });

  test("a merely-late check keeps DATA AGE green", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const rows = trustRows({
      health,
      streamDegraded: false,
      streamStatus: "open",
      nowMs: health.at! + 3 * 60_000,
    });
    expect(rows.find((r) => r.key === "DATA AGE")!.tone).toBe("ok");
  });
});
