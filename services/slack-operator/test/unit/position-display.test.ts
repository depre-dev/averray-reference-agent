import { describe, expect, test } from "vitest";

import {
  POSITION_STALE_AFTER_MS,
  calibrationFrom,
  decidePositionDisplay,
  type PositionCalibration,
} from "../../src/position-display.js";

const NOW = 1_785_800_000_000;
/** The real read path: balanceOf(truncate20(convertedAccount)) on the aToken. */
const SRC = "aUSDC 0x2ec48840…fa93 · balanceOf(0x98f0033E…B68E)";
const fresh = { source: SRC, readAtMs: NOW - 30_000, nowMs: NOW };
const proven: PositionCalibration = {
  provenAtMs: NOW - 86_400_000,
  provenRaw: "100000",
  provenSource: SRC,
};

describe("a zero is not a reading until the path has proven itself", () => {
  test("an uncalibrated zero is UNVERIFIED, never 0.00", () => {
    // The failure this exists for: Tokens.accounts(…,1003) returns zero BY
    // DESIGN because asset 1003 is Erc20-type. A tile on the wrong ledger reads
    // 0 and renders a drained position.
    const v = decidePositionDisplay({ ...fresh, raw: "0" });
    expect(v.status).toBe("unverified");
    expect(v.raw).toBeNull();
    expect(v.detail).toContain("never observed funds");
    expect(v.detail).toContain("not yet evidence");
  });

  test("after calibration a zero IS a fact, and cites its proof", () => {
    const v = decidePositionDisplay({ ...fresh, raw: "0", calibration: proven });
    expect(v.status).toBe("empty");
    expect(v.raw).toBe("0");
    expect(v.detail).toContain("100000 raw");
  });

  test("the dust cycle is the calibration event", () => {
    // 100,000 raw aUSDC lands at the observed address. The tile displays it,
    // and that display is what earns it the right to show zeros afterwards.
    const cal = calibrationFrom({ raw: "100000", source: SRC, nowMs: NOW })!;
    expect(cal.provenRaw).toBe("100000");
    expect(cal.provenSource).toBe(SRC);
    const after = decidePositionDisplay({ ...fresh, raw: "0", calibration: cal });
    expect(after.status).toBe("empty");
  });

  test("a zero can never calibrate anything", () => {
    // Otherwise a broken path calibrates itself on its own broken output.
    expect(calibrationFrom({ raw: "0", source: SRC, nowMs: NOW })).toBeNull();
    expect(calibrationFrom({ raw: null, source: SRC, nowMs: NOW })).toBeNull();
  });

  test("funds always display, calibrated or not", () => {
    // The rule gates ZEROS. A non-zero reading is self-evidencing.
    const v = decidePositionDisplay({ ...fresh, raw: "100000" });
    expect(v.status).toBe("funded");
    expect(v.raw).toBe("100000");
  });
});

describe("the proof is bound to the path that earned it", () => {
  test("a retarget invalidates the calibration", () => {
    // A proof taken against one address says nothing about another — and
    // retargeting is exactly how the payout instrument broke, twice.
    const v = decidePositionDisplay({
      ...fresh,
      source: "aUSDC · balanceOf(0xSOMETHING-ELSE)",
      raw: "0",
      calibration: proven,
    });
    expect(v.status).toBe("unverified");
    expect(v.detail).toContain("recalibrate");
  });
});

describe("unreadable and stale are never a number", () => {
  test("a failed read is unverified with its reason", () => {
    const v = decidePositionDisplay({ ...fresh, raw: null, readError: "hydradx rpc timeout" });
    expect(v.status).toBe("unverified");
    expect(v.detail).toContain("hydradx rpc timeout");
  });

  test("a stale read does NOT show its cached number", () => {
    // A balance rendered as current when it is an hour old is the same lie as
    // any other stale money figure here.
    const v = decidePositionDisplay({
      source: SRC,
      raw: "100000",
      readAtMs: NOW - POSITION_STALE_AFTER_MS - 1,
      nowMs: NOW,
      calibration: proven,
    });
    expect(v.status).toBe("unverified");
    expect(v.raw).toBeNull();
    expect(v.detail).toContain("old");
  });

  test("no read yet is unverified, not zero", () => {
    const v = decidePositionDisplay({ source: SRC, raw: null, readAtMs: null, nowMs: NOW });
    expect(v.status).toBe("unverified");
    expect(v.raw).toBeNull();
  });

  test("a non-numeric response is refused rather than coerced", () => {
    const v = decidePositionDisplay({ ...fresh, raw: "0x" });
    expect(v.status).toBe("unverified");
  });
});
