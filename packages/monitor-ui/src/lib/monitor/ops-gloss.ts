// What the numbers mean, for the reader who did not build them.
//
// The operator's verdict on 2026-08-04, reading the live board: "much of the
// number just dont say much without context". He was right in a specific way:
// every figure here is faithful, and half of them presume the reader already
// knows what a floor is, what "window fit" protects against, or why one extra
// on-chain payout is not a discrepancy. The board explained nothing because
// its authors needed no explanation.
//
// ── DEFINITIONS, NOT DATA ─────────────────────────────────────────────────
//
// Everything in this file is a statement about the DESIGN — what a floor is,
// what the funnel gaps mean. Nothing here is a claim about live state, which
// is why a frontend constant is honest: a definition cannot go stale the way
// a written expiry date does. Live facts (blocks read, endpoints, ages) stay
// in the server-derived view models and are never restated here.
//
// ── ONE MAP, RENDERED AS `title` ──────────────────────────────────────────
//
// Attached where each term is rendered, as title + aria terms — the same
// mechanism the by-hour bars already use. Hover carries it on the desk; the
// phone board needs none of this because it already speaks in full sentences
// (detail-only-when-not-ok is its explainer). Keyed and central so a gloss is
// written once, tested for existence, and greppable when its wording ages.

export const OPS_GLOSS = {
  /** The ×N figure beside each floored pool's name. */
  margin:
    "Balance ÷ floor. ×1.0 is the floor itself — below that, the product stops settling until the pool is topped up.",

  /** The tick and `floor N` label on a pool meter. */
  floor:
    "The balance below which settlement halts. Chosen per pool; the tick marks it on the meter so distance-to-trouble is visible at a glance.",

  /** The BURN sub-fact under signer gas. */
  burn:
    "What is draining this pool: gas spent settling payouts over the window, with the average cost per settlement.",

  /** The RUNWAY sub-fact under the reward bank. */
  runway:
    "How much longer this pool lasts: payouts it can still fund at the recent average, and the trend-projected time to its floor.",

  /** The funnel's first gap. */
  inflight:
    "Claimed but not yet submitted — work in progress. Nonzero is the normal state of a busy board, not a queue.",

  /** The funnel's second gap. */
  backlog:
    "Submitted but not settled — finished work awaiting payment. Zero is the healthy state; anything else is a real payout queue.",

  /** The `N self-posted Xs, slowest Ys` timing line. */
  selfPosted:
    "Posting-to-settlement time for jobs Averray posted itself. External jobs are posted by outside posters and settle on their own clock.",

  /** The `N beyond the ledger window` clause in the funnel header. */
  beyondWindow:
    "Confirmed on-chain right at the edge of the 24h comparison window, where the chain read and the settlement ledger can legitimately differ by a payout or two. A window-boundary artefact, not missing money.",

  /** The `window fit` clause on the payout evidence. */
  windowFit:
    "Whether the chain was read over at least the same 24h the settlement ledger is counted over. A shorter read window could miss real payouts and report a false shortfall — this line is the guard against comparing unlike windows.",

  /** The bank lane's POSTAGE row. */
  postage:
    "DOT committed to pay XCM delivery fees for the bank lane's transfers. Spendable only as postage — there is no withdraw path back to the treasury.",

  /** The bank lane's POSITION row when it reads UNVERIFIED. */
  positionUnverified:
    "The read returned zero from a path that has never observed funds, so it cannot distinguish an empty position from a wrong address. Grey because the instrument is blind — not because money is missing.",
} as const;

export type OpsGlossKey = keyof typeof OPS_GLOSS;
