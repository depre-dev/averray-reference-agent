// A zero is not a reading until the path has proven it can see funds.
//
// ── THE FAILURE THIS EXISTS FOR ────────────────────────────────────────────
//
// Hydration's `AssetRegistry.assets(1003)` declares `assetType: "Erc20"`, so
// `Tokens.accounts(…, 1003)` returns ZERO BY DESIGN — the position lives in the
// ERC-20 ledger at `balanceOf(truncate20(convertedAccount))`. A tile pointed at
// the wrong ledger reads 0 and renders "0.00 aUSDC", which on screen is
// indistinguishable from a drained position.
//
// The same shape has already shipped twice on this board's payout instrument:
// once watching the signer EOA instead of AgentAccountCore ("12 unaccounted
// for" on a live money board), once watching for an ERC-20 Transfer the USDC
// precompile never emits. Both times a misconfigured reader produced a
// confident zero.
//
// So the rule, which is a rule about EVIDENCE and not about this asset:
//
//     A zero from a read path that has never observed a non-zero value
//     renders as UNVERIFIED. A real zero may only render after the path
//     has proven, at least once, that it can see funds.
//
// ── CALIBRATION IS AN EVENT, NOT A HOPE ───────────────────────────────────
//
// The dust cycle places exactly 100,000 raw aUSDC at the observed address. That
// is the calibration: point the read path at it, watch it display 100,000, and
// the tile has earned the right to display zeros afterwards. Scheduled proof
// rather than proof by luck.
//
// ── AND THE PROOF MUST OUTLIVE THE PROCESS ────────────────────────────────
//
// "Has this path ever seen funds" cannot live in memory. The monitor restarts
// on every deploy — `uptimeSpanMs` was under a minute after the last one — so
// an in-memory flag would un-calibrate the tile several times a week and the
// rule would read as a permanent fault. This is exactly the defect that made
// the liquidity runway unable to project after a restart.
//
// The flag is therefore a durable record with provenance: WHEN the path proved
// itself and WHAT it saw. A tile that displays zeros should be able to say why
// it is allowed to.

/** What a read path has proven about itself, persisted across restarts. */
export interface PositionCalibration {
  /** Epoch ms the path first observed a non-zero value. */
  provenAtMs: number;
  /** The value it saw, as a decimal string — provenance, not arithmetic. */
  provenRaw: string;
  /** Which address/ledger proved it, so a retarget invalidates the proof. */
  provenSource: string;
}

export type PositionStatus =
  /** Funds observed. */
  | "funded"
  /** A REAL zero — the path has proven it can see funds and sees none now. */
  | "empty"
  /** Not evidence: unreadable, stale, or never calibrated. */
  | "unverified";

export interface PositionView {
  status: PositionStatus;
  /** Raw units when readable; null whenever the status is unverified. */
  raw: string | null;
  /** One sentence. On `unverified` it says which of the three reasons applies. */
  detail: string;
}

/** Past this the reading describes a different moment. */
export const POSITION_STALE_AFTER_MS = 15 * 60 * 1000;

export function decidePositionDisplay(input: {
  /** Raw units read, as a decimal string. Null when the read failed. */
  raw: string | null;
  /** Why the read failed, when it did. */
  readError?: string | null;
  /** The address + ledger this figure came from. */
  source: string;
  /** The durable proof, when this path has one. */
  calibration?: PositionCalibration | null;
  /** When the underlying read happened — the observer's own clock. */
  readAtMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}): PositionView {
  const src = input.source || "an unnamed source";

  if (input.readError) {
    return { status: "unverified", raw: null, detail: `position unreadable — ${input.readError}` };
  }
  if (input.raw === null || input.readAtMs === null) {
    return { status: "unverified", raw: null, detail: `no position read from ${src} yet` };
  }
  const ageMs = input.nowMs - input.readAtMs;
  const staleAfter = input.staleAfterMs ?? POSITION_STALE_AFTER_MS;
  if (ageMs > staleAfter) {
    // The cached number is NOT shown. A stale balance rendered as current is
    // the same lie as any other stale money figure on this board.
    const mins = Math.round(ageMs / 60_000);
    return { status: "unverified", raw: null, detail: `position read is ${mins}m old — not current` };
  }

  let value: bigint;
  try {
    value = BigInt(input.raw);
  } catch {
    return { status: "unverified", raw: null, detail: `position read from ${src} was not a number` };
  }

  if (value > 0n) {
    return { status: "funded", raw: value.toString(), detail: `read from ${src}` };
  }

  // Zero. Whether that is a fact depends entirely on whether this path has
  // ever been shown to work — and on it being the SAME path that was proven.
  const cal = input.calibration;
  if (!cal) {
    return {
      status: "unverified",
      raw: null,
      detail: `zero from ${src}, and this read path has never observed funds — not yet evidence of an empty position`,
    };
  }
  if (cal.provenSource !== input.source) {
    // A retarget invalidates the proof: the old path's calibration says nothing
    // about a new address or a different ledger.
    return {
      status: "unverified",
      raw: null,
      detail: `zero from ${src}, but the proof was taken against ${cal.provenSource} — recalibrate before believing a zero here`,
    };
  }
  return {
    status: "empty",
    raw: "0",
    detail: `zero from ${src} — path proven against ${cal.provenRaw} raw`,
  };
}

/**
 * The calibration a successful read establishes, or null when it proves nothing.
 *
 * Only a non-zero observation proves a path can see funds. Deliberately
 * separate from the display decision so the caller persists a FACT rather than
 * a rendering.
 */
export function calibrationFrom(input: {
  raw: string | null;
  source: string;
  nowMs: number;
}): PositionCalibration | null {
  if (input.raw === null) return null;
  let value: bigint;
  try {
    value = BigInt(input.raw);
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  return { provenAtMs: input.nowMs, provenRaw: value.toString(), provenSource: input.source };
}
