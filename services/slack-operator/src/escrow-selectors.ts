// Function selectors of the DEPLOYED EscrowCore v2, for naming gas spend.
//
// ── WHY THIS IS A PINNED CONSTANT AND NOT DERIVED ──────────────────────────
//
// `contracts/EscrowCore.sol` in the Polkadot repo does NOT describe the contract
// running on mainnet. It contains zero references to protocolFee, feeBps,
// treasuryAccount or bond, while the deployed contract demonstrably has all
// four. Computing selectors from that source produced ONE match out of five —
// and the four misses were the functions doing most of the work.
//
// The interface was recovered separately (averray-agent/agent#908) and frozen at
// `deployments/interfaces/mainnet-escrow-core-v2.json`. These names come from
// that artifact, not from any source in this repo.
//
// ── VERIFIED, NOT TRUSTED ──────────────────────────────────────────────────
//
// Every entry below was checked by computing keccak256 over the canonical
// signature rebuilt from the frozen ABI and comparing it to the selector
// observed in live mainnet traffic. 5 of 5 reproduced. The handback claimed the
// same thing; this was run independently, because a mapping that is merely
// plausible is exactly the failure mode a wrong label causes — the hex invites
// a look and the name ends it.
//
// To re-verify after any change to the deployed contract:
//   1. confirm the ABI still hashes to ABI_SHA256 below
//   2. keccak256(signature).slice(0,4) must equal each key here
// A selector that stops appearing in traffic is fine; a selector that appears
// and is NOT here renders as raw hex, which is the honest fallback.

/** Deployment this interface was frozen from. */
export const ESCROW_V2_ADDRESS = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
export const ESCROW_V2_DEPLOY_BLOCK = 18809168;
/** sha256 of the frozen ABI — the thing to check before trusting these names. */
export const ESCROW_V2_ABI_SHA256 =
  "sha256:f3b2f31a958402e0139217264dc356406130cbea402094d54bbd9f93343d5165";
/** The contract source the deployment was built from — NOT the file in this repo. */
export const ESCROW_V2_SOURCE_COMMIT = "775a826b0a33d0ec04dd19f0455e69402dc9bbcd";

/**
 * Selector → human name, for the gas breakdown.
 *
 * Deliberately only the operations seen in live traffic. The frozen ABI has 51
 * method identifiers; carrying all of them would be a list nobody maintains and
 * whose staleness nobody would notice, and an unlisted selector already renders
 * as hex rather than as a guess.
 *
 * The comment on each line is the observed 24h cost, so a future reader can see
 * at a glance whether a number has moved — these are the figures that made the
 * per-job unit cost legible in the first place.
 */
export const ESCROW_V2_SELECTORS: Readonly<Record<string, string>> = {
  // 42% of the burn. The single most expensive call in the lifecycle.
  "0xb08c763e": "resolveSinglePayout",
  // 33%. Named for what it does: the pipeline creates jobs with the fee WAIVED,
  // which is why self-posted work yields no protocol revenue. Deliberate, and
  // confirmed at the call site rather than inferred from an absence.
  "0xbcb2689a": "createSinglePayoutJobFeeWaived",
  // 15%
  "0x090cf6d5": "claimJobFor",
  // 5%
  "0x1b2ef921": "submitWorkFor",
  // 4.5%. A separate transaction per job, distinct from the FeeWaived create.
  "0xcca2acd6": "setOnboardingWaiverEligible",
};

/** Selectors observed in live mainnet traffic — what the map has to cover. */
export const OBSERVED_SELECTORS: readonly string[] = [
  "0xb08c763e",
  "0xbcb2689a",
  "0x090cf6d5",
  "0x1b2ef921",
  "0xcca2acd6",
];
