import { describe, expect, test } from "vitest";

import {
  deriveOpsVerdict,
  isAcknowledgedProbe,
  isAwaitingProbe,
  isUnknownReadingProbe,
  payoutGap,
  probeCensus,
  type VerdictInput,
  type VerdictProbe,
} from "./ops-verdict.js";

const probe = (over: Partial<VerdictProbe> = {}): VerdictProbe => ({
  name: "product_api",
  status: "ok",
  detail: "200",
  ...over,
});

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  enabled: true,
  checks: 12,
  probes: [probe()],
  ...over,
});

describe("classifiers", () => {
  test("awaiting catches the product's forward-compat phrasings", () => {
    expect(isAwaitingProbe(probe({ status: "degraded", detail: "awaiting /health addresses" }))).toBe(true);
    expect(isAwaitingProbe(probe({ status: "degraded", detail: "not exposed by /health yet" }))).toBe(true);
    expect(isAwaitingProbe(probe({ status: "degraded", detail: "does not expose settlement yet" }))).toBe(true);
    expect(isAwaitingProbe(probe({ status: "degraded", detail: "latency 2.4s" }))).toBe(false);
  });

  // A red probe is never "just awaiting" — it is a real failure whatever its
  // wording, and downgrading it to grey would silence a page.
  test("a red probe is never awaiting and never acknowledged", () => {
    expect(isAwaitingProbe(probe({ status: "red", detail: "awaiting data" }))).toBe(false);
    expect(isAcknowledgedProbe(probe({ status: "red", detail: "2 warnings acknowledged" }))).toBe(false);
  });

  // THE REGRESSION. The predicate read `status !== "red"`, which also swept in
  // `ok` — so a healthy probe whose prose happened to contain one of these words
  // was demoted to grey and dropped from the ok count.
  //
  // external_funnel did exactly this in production: `ok`, detail "1 awaiting
  // review", meaning one job genuinely under review. Nothing was missing, and
  // the board greyed it anyway. Renaming the string fixed that probe and left
  // every future one exposed.
  //
  // An ok probe HAS its data. That is what ok means.
  test("an ok probe is NEVER awaiting, whatever its prose says", () => {
    expect(isAwaitingProbe(probe({ status: "ok", detail: "1 awaiting review" }))).toBe(false);
    expect(isAwaitingProbe(probe({ status: "ok", detail: "0 claimable · 2 awaiting settlement" }))).toBe(false);
    expect(isAwaitingProbe(probe({ status: "ok", detail: "no data older than 5m" }))).toBe(false);
    expect(isAwaitingProbe(probe({ status: "ok", detail: "gasSponsor not configured (by design)" }))).toBe(false);
  });

  test("an ok probe with awaiting prose still counts as ok in the census", () => {
    // The consequence that reaches the screen: it was subtracted from green and
    // labelled awaiting, so a fully healthy board read "8 ok · 1 awaiting".
    const census = probeCensus([
      probe({ name: "a", status: "ok", detail: "fine" }),
      probe({ name: "external_funnel", status: "ok", detail: "1 awaiting review" }),
    ]);
    expect(census).toBe("2 ok / 0 red");
    expect(census).not.toContain("awaiting");
  });

  test("acknowledged only applies to a degraded probe that says so", () => {
    expect(isAcknowledgedProbe(probe({ status: "degraded", detail: "4/7 up · 2 warnings acknowledged" }))).toBe(true);
    expect(isAcknowledgedProbe(probe({ status: "degraded", detail: "4/7 up · 2 warnings" }))).toBe(false);
    expect(isAcknowledgedProbe(probe({ status: "ok", detail: "acknowledged" }))).toBe(false);
  });
});

describe("probeCensus — counted, never dropped", () => {
  test("acknowledged degradations are labelled, not hidden", () => {
    const census = probeCensus([
      probe(),
      probe({ name: "capabilities", status: "degraded", detail: "2 warnings acknowledged" }),
      probe({ name: "treasury_liquidity", status: "degraded", detail: "awaiting /health addresses" }),
    ]);
    expect(census).toBe("1 ok / 1 degraded (acknowledged) / 1 awaiting data / 0 red");
  });

  test("a clean board reads plainly", () => {
    expect(probeCensus([probe(), probe({ name: "api_latency" })])).toBe("2 ok / 0 red");
  });
});

describe("deriveOpsVerdict — the hierarchy", () => {
  test("nominal", () => {
    const v = deriveOpsVerdict(input());
    expect(v.reason).toBe("nominal");
    expect(v.headline).toBe("NOMINAL");
    expect(v.tone).toBe("ok");
  });

  test("a breached floor outranks a red probe", () => {
    const v = deriveOpsVerdict(
      input({
        probes: [probe({ name: "money_path", status: "red", detail: "6 stuck" })],
        pools: [{ label: "Reward bank", amount: 1.42, floor: 2, status: "red" }],
      }),
    );
    expect(v.reason).toBe("floor-breach");
    expect(v.headline).toBe("REWARD BANK BELOW FLOOR");
  });

  test("a red probe outranks a payout shortfall", () => {
    const v = deriveOpsVerdict(
      input({
        probes: [probe({ name: "money_path", status: "red", detail: "6 stuck" })],
        payout: { status: "shortfall", confirmedCount: 12, settledCount: 14 },
      }),
    );
    expect(v.reason).toBe("probe-red");
  });

  test("a payout shortfall outranks a degradation, and warns that the funnel disagrees", () => {
    const v = deriveOpsVerdict(
      input({
        probes: [probe({ name: "api_latency", status: "degraded", detail: "1.9s" })],
        payout: { status: "shortfall", confirmedCount: 12, settledCount: 14 },
      }),
    );
    expect(v.reason).toBe("payout-shortfall");
    expect(v.sub).toContain("the funnel reads clean");
    expect(v.sub).toContain("−2");
  });

  // "We cannot see the chain" is an instrument fault. Raising the verdict on it
  // is the false red that teaches an operator to ignore verdicts.
  test("unverified payout evidence does NOT raise the verdict", () => {
    const v = deriveOpsVerdict(
      input({ payout: { status: "unverified", confirmedCount: null, settledCount: 9 } }),
    );
    expect(v.reason).toBe("nominal");
    expect(v.tone).toBe("ok");
  });

  // A pool we cannot read is unknown, and unknown is not a breach.
  test("an unreadable pool is not a floor breach", () => {
    const v = deriveOpsVerdict(
      input({ pools: [{ label: "Reward bank", amount: null, floor: 2, status: "red" }] }),
    );
    expect(v.reason).toBe("nominal");
  });

  test("a pool with no floor cannot breach one", () => {
    const v = deriveOpsVerdict(
      input({ pools: [{ label: "Treasury reserve", amount: 0, status: "red" }] }),
    );
    expect(v.reason).toBe("nominal");
  });

  test("an acknowledged degradation does not own the headline, but is counted", () => {
    const v = deriveOpsVerdict(
      input({
        probes: [probe(), probe({ name: "capabilities", status: "degraded", detail: "4/7 up · 2 warnings acknowledged" })],
      }),
    );
    expect(v.reason).toBe("nominal");
    expect(v.census).toContain("1 degraded (acknowledged)");
  });

  test("an unacknowledged degradation does own it", () => {
    const v = deriveOpsVerdict(
      input({ probes: [probe({ name: "capabilities", status: "degraded", detail: "4/7 up · 2 warnings" })] }),
    );
    expect(v.reason).toBe("probe-degraded");
    expect(v.headline).toBe("CAPABILITIES DEGRADED");
  });

  test("monitoring off and no-data are distinct, and neither is healthy", () => {
    expect(deriveOpsVerdict(input({ enabled: false })).reason).toBe("not-watching");
    expect(deriveOpsVerdict(input({ checks: 0 })).reason).toBe("no-data");
    expect(deriveOpsVerdict(input({ enabled: false })).tone).toBe("awaiting");
    expect(deriveOpsVerdict(input({ checks: 0 })).tone).toBe("awaiting");
  });

  test("multiple reds are counted in the headline, not silently collapsed", () => {
    const v = deriveOpsVerdict(
      input({
        probes: [
          probe({ name: "money_path", status: "red", detail: "6 stuck" }),
          probe({ name: "chain_height", status: "red", detail: "halted" }),
        ],
      }),
    );
    expect(v.headline).toBe("MONEY PATH RED +1");
  });

  // The headline is prose for a human; `reason` is what a machine reads. This
  // test exists to make that contract explicit rather than incidental.
  test("every verdict carries a machine-readable reason", () => {
    const cases: VerdictInput[] = [
      input(),
      input({ enabled: false }),
      input({ checks: 0 }),
      input({ pools: [{ label: "Bank", amount: 1, floor: 2, status: "red" }] }),
      input({ probes: [probe({ status: "red", detail: "down" })] }),
      input({ payout: { status: "shortfall", confirmedCount: 1, settledCount: 3 } }),
      input({ probes: [probe({ status: "degraded", detail: "slow" })] }),
    ];
    const reasons = cases.map((c) => deriveOpsVerdict(c).reason);
    expect(new Set(reasons).size).toBe(cases.length);
  });
});

// ── A probe with no READING ────────────────────────────────────────────────
//
// 2026-08-06: container DNS failed for five minutes. The four probes that read
// out of the product's /health had no reading of anything, and the board turned
// that into "Product API is red" plus three corroborating degradations — a
// unanimous verdict on a product that was serving 200s throughout.
describe("unknown readings", () => {
  const unknown = (over: Partial<VerdictProbe> = {}): VerdictProbe =>
    probe({
      name: "money_path",
      status: "degraded",
      reading: "unknown",
      detail: "settlement state unknown, not stalled — product /health not readable from here — DNS resolution failed (ENOTFOUND)",
      ...over,
    });

  test("is grey, not amber — no reading is not a finding", () => {
    expect(isAwaitingProbe(unknown())).toBe(true);
    expect(isUnknownReadingProbe(unknown())).toBe(true);
  });

  test("cannot take the DEGRADED headline", () => {
    const v = deriveOpsVerdict(input({ probes: [probe(), unknown()] }));
    expect(v.reason).not.toBe("probe-degraded");
  });

  test("but is never laundered into NOMINAL either", () => {
    // The mirror-image failure, and the easier one to ship by accident: grey out
    // the probes that could not read, and the rest of the board is green.
    const v = deriveOpsVerdict(input({ probes: [probe(), unknown()] }));
    expect(v.reason).toBe("probe-unknown");
    expect(v.headline).toContain("UNKNOWN");
    expect(v.tone).toBe("awaiting");
  });

  test("is counted in its own census bucket, apart from awaiting-data", () => {
    // Different facts: awaiting means the product does not publish this yet,
    // unknown means we could not read what it does publish.
    const census = probeCensus([
      probe(),
      unknown(),
      probe({ name: "capabilities", status: "degraded", detail: "not exposed by /health yet" }),
    ]);
    expect(census).toBe("1 ok / 1 awaiting data / 1 unknown / 0 red");
  });

  test("an observed degradation still outranks an unknown", () => {
    // A fault you can see is more actionable than one you cannot.
    const v = deriveOpsVerdict(input({
      probes: [unknown(), probe({ name: "disk_headroom", status: "degraded", detail: "4.1GB free" })],
    }));
    expect(v.reason).toBe("probe-degraded");
  });

  test("a red with no reading is headlined UNREACHABLE, not RED", () => {
    // Same alarm, truthfully named: what persisted is our inability to reach it.
    const v = deriveOpsVerdict(input({
      probes: [probe({ status: "red", reading: "unknown", detail: "probe cannot reach https://api.averray.com/health — DNS resolution failed (ENOTFOUND) · 3 consecutive checks" })],
    }));
    expect(v.reason).toBe("probe-red");
    expect(v.headline).toBe("PRODUCT API UNREACHABLE");
    expect(v.tone).toBe("red");
  });

  test("an ordinary red still says RED", () => {
    const v = deriveOpsVerdict(input({ probes: [probe({ status: "red", detail: "→ HTTP 503" })] }));
    expect(v.headline).toBe("PRODUCT API RED");
  });
});

describe("payoutGap", () => {
  test("names the gap when both sides are known", () => {
    expect(payoutGap({ status: "shortfall", confirmedCount: 12, settledCount: 14 })).toBe("−2");
  });

  test("says so when it cannot compare, instead of implying zero", () => {
    expect(payoutGap({ status: "unverified", confirmedCount: null, settledCount: 14 })).toBe("gap unknown");
    expect(payoutGap(undefined)).toBe("gap unknown");
  });
});
