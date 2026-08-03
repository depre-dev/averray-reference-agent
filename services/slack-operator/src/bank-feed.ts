// THE BANK LANE FEED — a cross-repo contract.
//
// Hermes does not read Hydration. Two protocols live behind this data — the
// aToken position is `balanceOf` on Hydration's EVM ledger, the operating float
// is `Tokens.accounts(…, 22)` over Substrate — and putting both, plus an
// `@polkadot/api` dependency, inside a read-only display process is the wrong
// place for them.
//
// The observer (#910) already performs both reads. The backend exposes them on
// a READ-ONLY, NON-SECRET, internal-network endpoint shaped like
// /monitor/product-health rather than like the admin surface. Not
// `/admin/status`: that route is `requireRole: "admin"`, and minting a third
// rotating credential chain so a display can watch a position is a real
// key-surface increase for a display concern.
//
// So: one reader of the chain, Hermes renders. Everything here is what the
// tiles show and nothing more.
//
// ── STALENESS KEYS OFF THE OBSERVER'S CLOCK, NOT HERMES'S ─────────────────
//
// Every figure carries the moment ITS OWN read happened and the error that
// stopped it. A feed that arrived a second ago can still carry a position read
// that failed an hour ago, and collapsing those into one "as of" is how a stale
// balance gets rendered as current. Per-source, always.
//
// ── ABSENCE IS NOT ZERO, AND NOT A LANE OF EMPTY TILES ────────────────────
//
// When the endpoint is not configured the lane does not render as a row of
// "awaiting" tiles — that is a permanently-lit panel nobody reads. It states
// once, quietly, that the feed is not configured. Same treatment as the payout
// cross-check, and for the same reason.

import type { PositionCalibration } from "./position-display.js";

/** One chain figure, with the provenance needed to decide whether to believe it. */
export interface SourcedRead {
  /** Raw units as a decimal string — never a float; these are token amounts. */
  raw: string | null;
  /** The address AND ledger this came from. Changing it invalidates a proof. */
  source: string;
  /** Epoch ms of THIS read, from the observer's clock. */
  readAtMs: number | null;
  /** Why this read failed, when it did. Null is not "fine" — see readAtMs. */
  lastError?: string | null;
}

/**
 * A wrapper request in flight.
 *
 * `phase` is the observer's own state machine, not a Hermes interpretation, and
 * `overdue` is the observer's own deadline judgement. Hermes must not compute
 * either: a board that re-derives a deadline from a timestamp will disagree
 * with the service that owns it, and then there are two answers.
 */
export interface BankRequest {
  /** Short id — enough to name the request in an alert. */
  id: string;
  kind: string;
  phase: "leg1-dispatched" | "leg2-dispatched" | "pending-finalize" | "terminal";
  /** How long it has been in flight, per the observer. */
  ageSeconds: number;
  /** Past its observer deadline. THE stuck-pending alarm. */
  overdue: boolean;
}

export interface BankFeed {
  /** aToken position — `balanceOf(truncate20(convertedAccount))`. */
  position: SourcedRead;
  /**
   * The residual asset-22 operating float at the converted account.
   *
   * Displayed, always. It is real money sitting at a real address, and a
   * balance the board declines to show reads as money that vanished.
   */
  float: SourcedRead;
  /**
   * The wrapper postage account — DOT that can only ever be spent as XCM
   * delivery fees, with no withdraw path. Committed postage, not treasury.
   */
  postage: SourcedRead;
  requests: BankRequest[];
  /**
   * What the POSITION read path has proven about itself, owned by the service
   * that performs the read.
   *
   * Deliberately not Hermes-side state. The prover holds the proof: an entity
   * that has never executed the read cannot attest that it works, and a flag
   * held in a process that restarts on every deploy would un-calibrate the tile
   * several times a week — the same defect that stopped the liquidity runway
   * projecting after a restart.
   */
  calibration?: PositionCalibration | null;
}

/** DOT below which the postage account can no longer pay for an epoch. */
export const POSTAGE_FLOOR_DOT = 0.07;

/** Planck per DOT — postage arrives as raw units like everything else. */
export const PLANCK_PER_DOT = 10 ** 10;
