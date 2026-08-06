import { describe, expect, it } from "vitest";

import { OPS_NEXT_STEP, opsNextStep } from "./ops-next-step.js";

describe("opsNextStep", () => {
  it("returns the step for a probe that has one", () => {
    expect(opsNextStep("signer_liquidity")).toBe("Top up before the next payout.");
    expect(opsNextStep("money_path")).toBe("Trace the stuck settlements.");
  });

  it("returns undefined for a probe with no considered step", () => {
    // Absence is the safe default: inventing a plausible action for an incident
    // class nobody has thought through is how an operator gets sent down the
    // wrong path at 3am.
    expect(opsNextStep("external_funnel")).toBeUndefined();
    expect(opsNextStep("chain_height")).toBeUndefined();
    expect(opsNextStep("not_a_probe")).toBeUndefined();
  });

  it("never diagnoses a cause — every step is a pointer, not a verdict", () => {
    // The bank-overdue suggestion already paid for this lesson: its first
    // wording asserted "check whether leg 2 landed", and the first live overdue
    // had never dispatched a leg at all.
    for (const [probe, step] of Object.entries(OPS_NEXT_STEP)) {
      expect(step, `${probe} must not assert a cause`).not.toMatch(
        /\b(because|caused by|due to|is failing because)\b/i,
      );
    }
  });

  it("stays short enough for a lock screen, and reads as one instruction", () => {
    for (const [probe, step] of Object.entries(OPS_NEXT_STEP)) {
      expect(step.length, `${probe} step is too long for a phone alert`).toBeLessThanOrEqual(56);
      expect(step.endsWith("."), `${probe} step should be one closed sentence`).toBe(true);
    }
  });

  it("never suggests moving money automatically — funds stay operator-only", () => {
    // The money rail is a hard boundary. A step that reads like an instruction
    // to a machine, rather than to the operator, is the wrong shape entirely.
    expect(OPS_NEXT_STEP.signer_liquidity).toMatch(/top up/i);
    expect(OPS_NEXT_STEP.treasury_liquidity).toMatch(/operator action/i);
    for (const step of Object.values(OPS_NEXT_STEP)) {
      expect(step).not.toMatch(/\b(transfer|send|withdraw|sweep) \d/i);
    }
  });
});
