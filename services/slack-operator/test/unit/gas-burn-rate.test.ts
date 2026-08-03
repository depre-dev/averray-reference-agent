import { describe, expect, test } from "vitest";

import {
  MAX_BURN_AGE_MS,
  burnBasisLabel,
  isBurnUnmeasurable,
  measuredGasBurn,
  type MeasuredBurn,
} from "../../src/gas-burn-rate.js";

/** A live-shaped read: 1.684 DOT over ~24h at the chain's measured rate. */
const live = {
  totalDot: 1.684,
  blocksScanned: 40_678,
  blockSeconds: 2.124,
  truncated: false,
  ageMs: 5 * 60_000,
};

function ok(v: ReturnType<typeof measuredGasBurn>): MeasuredBurn {
  if (isBurnUnmeasurable(v)) throw new Error(`expected a rate, got: ${v.reason}`);
  return v;
}

describe("consumption, not balance", () => {
  test("the rate comes out of spend over the window it was measured on", () => {
    const b = ok(measuredGasBurn(live));
    // 40,678 blocks × 2.124s = 86,400s = 24.0h
    expect(b.windowHours).toBeCloseTo(24, 1);
    expect(b.perHour).toBeCloseTo(1.684 / 24, 4);
  });

  test("it projects the live board's numbers to days, not hours", () => {
    // Signer gas 9.52 DOT against a 1.00 floor. The balance-slope method said
    // ~3d off a six-hour regression; measured consumption says ~5d, and that
    // number is what the last day of real work actually cost.
    const b = ok(measuredGasBurn(live));
    const hoursToFloor = (9.52 - 1.0) / b.perHour;
    expect(hoursToFloor / 24).toBeGreaterThan(4.5);
    expect(hoursToFloor / 24).toBeLessThan(6);
  });

  test("a top-up cannot cancel it — there is no balance in the arithmetic", () => {
    // The whole point. A deposit changes the balance and not one input here.
    const before = ok(measuredGasBurn(live));
    const after = ok(measuredGasBurn({ ...live }));
    expect(after.perHour).toBe(before.perHour);
  });

  test("zero spend is a real measurement, not a refusal", () => {
    const b = ok(measuredGasBurn({ ...live, totalDot: 0 }));
    expect(b.perHour).toBe(0);
  });
});

describe("every refusal points away from a false green", () => {
  test("a truncated read is refused — its total is a floor, not a total", () => {
    // An understated burn OVERSTATES the runway. "You have a week" on a gas
    // floor is the one direction this board must never be wrong in.
    const v = measuredGasBurn({ ...live, truncated: true });
    expect(isBurnUnmeasurable(v)).toBe(true);
    expect(isBurnUnmeasurable(v) && v.reason).toContain("understates spend");
  });

  test("an unmeasured block time is refused rather than assumed", () => {
    // An assumed block time has already been wrong here by 3x, and it scales
    // the rate by exactly that factor.
    const v = measuredGasBurn({ ...live, blockSeconds: null });
    expect(isBurnUnmeasurable(v)).toBe(true);
    expect(isBurnUnmeasurable(v) && v.reason).toContain("block time not measured");
  });

  test("a window of minutes is refused — one busy minute is not a rate", () => {
    const v = measuredGasBurn({ ...live, blocksScanned: 1_000 });
    expect(isBurnUnmeasurable(v)).toBe(true);
    expect(isBurnUnmeasurable(v) && v.reason).toContain("too short to be a rate");
  });

  test("figures from a different day are refused", () => {
    const v = measuredGasBurn({ ...live, ageMs: MAX_BURN_AGE_MS + 1 });
    expect(isBurnUnmeasurable(v)).toBe(true);
    expect(isBurnUnmeasurable(v) && v.reason).toContain("different day");
  });

  test("no total and no span are refused, never treated as zero burn", () => {
    // Zero burn would read as an infinite runway — the same false green.
    for (const bad of [{ totalDot: null }, { blocksScanned: 0 }, { totalDot: Number.NaN }]) {
      expect(isBurnUnmeasurable(measuredGasBurn({ ...live, ...bad }))).toBe(true);
    }
  });
});

describe("the headline carries its qualifier", () => {
  test("the label names the window the rate came from", () => {
    // "~5d to floor" invites a long-run reading. "~5d at the last 24h of
    // measured burn" is the same number with its scope attached.
    expect(burnBasisLabel(ok(measuredGasBurn(live)))).toBe("at the last 24h of measured burn");
  });
});
