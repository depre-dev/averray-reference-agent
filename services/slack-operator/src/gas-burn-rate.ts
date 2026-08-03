// How fast the signer's gas is ACTUALLY being consumed.
//
// ── WHY NOT THE BALANCE ────────────────────────────────────────────────────
//
// The runway projection fits a slope to balance samples. A balance is not
// consumption: TOP-UPS LAND IN THE SAME NUMBER. On 2026-08-02 a ~5 DOT top-up
// inside the window made the signer's balance rise while gas was being spent,
// and the arithmetic only worked out because the top-up was found by hand:
//
//     1.9622728 + 5 − 2.049685 = 4.9125877
//
// Fitted to a slope, that window reads as REFILLING — burn ≤ 0, `hoursToFloor`
// null, "stable". The burn does not shrink; it vanishes. A projection that
// disappears the moment someone tops up is worst exactly when the operator is
// most engaged with the pool.
//
// The slope has two more problems on this signer. The window is six hours, and
// six hours of a bursty workload is mostly noise. And the samples live in the
// monitor's memory, so every deploy resets them — after a restart there are not
// enough samples to estimate anything at all.
//
// Gas spend read from receipts has none of these properties. It is consumption,
// it cannot be cancelled by a deposit, and it is re-read from chain rather than
// accumulated in a process that restarts.
//
// ── WHEN IT REFUSES ────────────────────────────────────────────────────────
//
// Every refusal here points the same way: if the burn figure might UNDERSTATE
// spend, it is not used, because an understated burn OVERSTATES the runway —
// and a false "you have a week" on a gas floor is the one direction this board
// must never be wrong in. `gas-spend-read.ts` makes the same argument about its
// own transaction cap.
//
// A refusal is not a gap: the caller falls back to the balance trend and the
// board says which basis it used, so a reader can tell a measured projection
// from an inferred one.

export interface MeasuredBurn {
  /** Units per hour, from actual consumption. */
  perHour: number;
  /** Hours the measurement covers — the qualifier the headline must carry. */
  windowHours: number;
}

export interface BurnUnmeasurable {
  reason: string;
}

export function isBurnUnmeasurable(v: MeasuredBurn | BurnUnmeasurable): v is BurnUnmeasurable {
  return (v as BurnUnmeasurable).reason !== undefined;
}

/**
 * A rate needs enough hours behind it to be a rate.
 *
 * Under this, one busy minute dominates and the projection swings wildly
 * between reads — which is how an operator learns to ignore it.
 */
export const MIN_BURN_WINDOW_HOURS = 4;

/** Past this the snapshot describes a different day, not this one. */
export const MAX_BURN_AGE_MS = 6 * 60 * 60 * 1000;

export function measuredGasBurn(input: {
  /** Total spend observed over the window. */
  totalDot: number | null | undefined;
  /** Blocks the read covered. */
  blocksScanned: number | null | undefined;
  /** MEASURED seconds per block — never an assumed one. */
  blockSeconds: number | null | undefined;
  /** True when the transaction cap bit and some spend is NOT counted. */
  truncated: boolean;
  ageMs: number;
  minWindowHours?: number;
  maxAgeMs?: number;
}): MeasuredBurn | BurnUnmeasurable {
  if (input.truncated) {
    // The total is a floor, not a total. Dividing it into a runway produces a
    // number that is too LONG, which is the dangerous direction.
    return { reason: "gas read hit its transaction cap — the total understates spend" };
  }
  if (input.totalDot == null || !Number.isFinite(input.totalDot) || input.totalDot < 0) {
    return { reason: "no gas total to divide" };
  }
  if (input.blockSeconds == null || !(input.blockSeconds > 0)) {
    // Same rule as everywhere else on this board: an assumed block time has
    // already been wrong here by 3x, and it would scale the rate by that factor.
    return { reason: "block time not measured — the window cannot be converted to hours" };
  }
  if (input.blocksScanned == null || !(input.blocksScanned > 0)) {
    return { reason: "gas read reported no block span" };
  }

  const windowHours = (input.blocksScanned * input.blockSeconds) / 3600;
  const minHours = input.minWindowHours ?? MIN_BURN_WINDOW_HOURS;
  if (windowHours < minHours) {
    return { reason: `gas window spans only ${windowHours.toFixed(1)}h — too short to be a rate` };
  }
  const maxAge = input.maxAgeMs ?? MAX_BURN_AGE_MS;
  if (input.ageMs > maxAge) {
    const hours = Math.round(input.ageMs / 3_600_000);
    return { reason: `gas figures are ${hours}h old — they describe a different day` };
  }

  // Zero is a real measurement — nothing ran — and the caller renders it as
  // stable rather than as an infinite countdown.
  return { perHour: input.totalDot / windowHours, windowHours };
}

/** "the last 24h's burn" — the qualifier that keeps the number honest. */
export function burnBasisLabel(burn: MeasuredBurn): string {
  const h = Math.round(burn.windowHours);
  return `at the last ${h}h of measured burn`;
}
