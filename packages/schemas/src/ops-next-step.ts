// What to DO about a probe — the one place the answer is written.
//
// The board's co-pilot has always computed a pre-drafted remediation for each
// incident class (`opsSuggestions`), but that lives on a screen. Since mobile
// pairing landed, the alerts reach a phone at 3am — and they carried the
// problem without the next move, so the operator had to open a laptop to learn
// what the board already knew.
//
// ── WHY THIS IS A SEPARATE MODULE, AND NOT COPIED INTO THE ALERT ──────────
//
// Two surfaces now answer "what should I do about money_path?": the board's
// suggestion box and the pushed alert. Written twice they drift, and the first
// time they disagree is the last time either is believed — the same rule that
// put deriveOpsVerdict here rather than in each renderer. So the phrase lives
// once, in the package both sides already import, and each surface decides
// only how to present it.
//
// ── THESE ARE POINTERS, NOT INSTRUCTIONS ──────────────────────────────────
//
// Every phrase names what to FIND OUT or what to DO, and deliberately asserts
// no cause. "Check the last deploy" would be a diagnosis, and a wrong one
// shouted at 3am is worse than silence — the bank-overdue suggestion already
// learned this the hard way, when its first wording said "check whether leg 2
// landed" and the first live overdue had never dispatched a leg at all.
//
// Absence is meaningful: a probe with no entry gets NO appended step, because
// inventing a plausible-sounding action for an incident class nobody has
// thought through is exactly how an operator is sent down the wrong path.

/**
 * Short imperative next step per probe, or undefined when we have nothing
 * honest to add. Kept to one clause — this renders on a lock screen.
 */
export const OPS_NEXT_STEP: Readonly<Record<string, string>> = {
  // Funds. Both are operator-only: the step is to top up, never to move money
  // automatically. Wording matches the board's suggestion box verbatim.
  signer_liquidity: "Top up before the next payout.",
  treasury_liquidity: "Refill (operator action).",
  // Settlement. Names the object to trace, not a suspected cause.
  money_path: "Trace the stuck settlements.",
  // Config-shaped by construction: a capability drops when a credential or
  // setting is missing, so this one can be specific without diagnosing.
  capabilities: "Check config.",
  // Latency: the useful first move is measuring where the time goes.
  api_latency: "Profile the slow path.",
  // The product's own health check failing is the one case where confirming
  // from outside comes first — the probe itself may be what is wrong.
  product_api: "Confirm from outside, then check recent deploys.",
} as const;

/**
 * The next step for a probe, or undefined when none is defined.
 *
 * Deliberately keyed on the probe NAME only, not its detail: a step that
 * changes with the wording of a detail string is a step nobody can test, and
 * the detail is already carried verbatim beside it.
 */
export function opsNextStep(probeName: string): string | undefined {
  return OPS_NEXT_STEP[probeName];
}
