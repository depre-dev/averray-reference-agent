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
  /**
   * The observer's state machine value, DELIBERATELY not a closed union.
   *
   * The four known phases are listed in `KNOWN_PHASES`, but the observer owns
   * this vocabulary and may extend it — `recovery-pending` is plausible given
   * the recovery bucket. A board that hard-failed or silently dropped an
   * unrecognized phase would hide precisely the unusual request, which is the
   * one worth seeing. Unknown values are rendered verbatim and flagged.
   */
  phase: string;
  /** How long it has been in flight, per the observer. */
  ageSeconds: number;
  /** Past its observer deadline. THE stuck-pending alarm. */
  overdue: boolean;
}

/** The observer's vocabulary as of today. Not exhaustive by construction. */
export const KNOWN_PHASES = [
  "leg1-dispatched",
  "leg2-dispatched",
  "pending-finalize",
  "terminal",
] as const;

export function isKnownPhase(phase: string): boolean {
  return (KNOWN_PHASES as readonly string[]).includes(phase);
}

/**
 * The request table, WITH its own provenance.
 *
 * A bare array cannot distinguish "no requests in flight" from "the request
 * table could not be read" — the absence-is-not-zero problem, sitting on the
 * one tile whose entire job is the stuck-pending alarm. An unreadable table
 * rendering as "all clear" is the worst version of this failure on this lane.
 */
export interface BankRequests {
  items: BankRequest[];
  /** Epoch ms of the request read. Null ⇒ never read; the tile says so. */
  readAtMs: number | null;
  lastError?: string | null;
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
  requests: BankRequests;
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

/**
 * The producer's own word for "this feature is switched off here".
 *
 * Emitted verbatim by the backend's `disabledFeed()` on every read when
 * `BANK_LANE_FEED_ENABLED` is not set, alongside `raw: null` and
 * `source: "unconfigured:<field>"`. Observed live on 2026-08-04.
 */
export const BANK_FEED_DISABLED_SENTINEL = "bank_lane_feed_disabled";

/**
 * Is this an ENTIRELY switched-off feed, rather than a working one with broken
 * instruments?
 *
 * The distinction is the whole point. A disabled feed is a valid payload full
 * of read errors, which is shaped exactly like four failed reads — and rendered
 * as such it produced an amber BANK lane for a feature nobody had turned on.
 * That is the permanently-lit panel this board keeps removing: a false amber
 * teaches an operator to ignore the real one just as reliably as a false red.
 *
 * The test is deliberately strict, and the strictness runs toward showing more
 * rather than less. A PARTIALLY disabled feed — which today's producer cannot
 * emit, and which is therefore the interesting case if it ever appears — does
 * NOT collapse: it keeps its rows and its honest degraded tone, because a feed
 * that half-works is a fault and hiding it behind "switched off" would be the
 * false green on the other side of the same mistake.
 */
export function bankFeedIsDisabled(feed: BankFeed): boolean {
  const reads = [feed.position, feed.float, feed.postage];
  // Every balance read reports the producer's sentinel — not merely "an error".
  if (!reads.every((r) => r.lastError === BANK_FEED_DISABLED_SENTINEL)) return false;
  // And the request table is not claiming to have read anything. Checked
  // separately, and NOT by its lastError: the alarm tile is the one place where
  // assuming the disabled shape would let real in-flight requests disappear
  // behind a "switched off" line.
  return feed.requests.readAtMs === null && feed.requests.items.length === 0;
}

/** DOT below which the postage account can no longer pay for an epoch. */
export const POSTAGE_FLOOR_DOT = 0.07;

/** Planck per DOT — postage arrives as raw units like everything else. */
export const PLANCK_PER_DOT = 10 ** 10;
