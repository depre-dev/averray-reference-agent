/**
 * Decide whether a drift check should announce anything.
 *
 * Shared by both of this service's checks — the skills volume against the repo,
 * and the consumers' MCP tool registries against the published bundle
 * (bundle-drift.ts). Each keeps its own state; the three failure modes below
 * are identical for both, and having two copies of this reasoning is how one of
 * them quietly stops obeying it.
 *
 * Logging every result is free and always truthful; a Slack message is not, and
 * three ways of getting this wrong all end with the alert being worthless:
 *
 *   REPEATING. Drift is a standing condition, not an event. Re-posting the same
 *   divergence every interval trains the reader to skim past it.
 *
 *   CRYING WOLF AT BOOT. skills-observer and skills-sync start together, so the
 *   observer's first look can catch the volume mid-copy. That is not drift, it
 *   is a race with the fix. The first check therefore only observes — and it
 *   deliberately does NOT record what it saw, so a divergence that is real is
 *   still announced on the next pass rather than swallowed as "unchanged".
 *
 *   GOING QUIET WHEN IT BREAKS. A check that cannot run says nothing about
 *   whether the trees match, and silence on a notification channel reads as
 *   "nothing wrong". That is the very failure this whole mechanism exists to
 *   remove — a skill sat unreachable for weeks because nothing surfaced it — so
 *   an unavailable check is itself announced, once.
 */

export interface DriftAlertState {
  /** The drift currently announced, if any. Absent means none outstanding. */
  alerted?: string;
  /** Whether an unavailable check has already been announced. */
  unavailableAnnounced: boolean;
  /** False until one check has completed — see CRYING WOLF AT BOOT above. */
  settled: boolean;
}

export type DriftObservation =
  | { kind: "in-sync" }
  /** `signature` is the stable identity of this divergence; see driftSignature(). */
  | { kind: "drifted"; signature: string }
  | { kind: "unavailable" };

export type DriftAnnouncement = "none" | "drift" | "recovery" | "unavailable";

export const initialDriftAlertState: DriftAlertState = {
  settled: false,
  unavailableAnnounced: false
};

export function decideDriftAlert(
  state: DriftAlertState,
  observation: DriftObservation
): { announce: DriftAnnouncement; state: DriftAlertState } {
  if (!state.settled) {
    return { announce: "none", state: { settled: true, unavailableAnnounced: false } };
  }

  if (observation.kind === "unavailable") {
    // Drop any outstanding drift verdict: a check that could not run does not
    // confirm the old one, and re-detecting it later deserves a fresh alert.
    return {
      announce: state.unavailableAnnounced ? "none" : "unavailable",
      state: { settled: true, unavailableAnnounced: true }
    };
  }

  if (observation.kind === "in-sync") {
    const hadSomethingOutstanding = state.alerted !== undefined || state.unavailableAnnounced;
    return {
      announce: hadSomethingOutstanding ? "recovery" : "none",
      state: { settled: true, unavailableAnnounced: false }
    };
  }

  return {
    announce: state.alerted === observation.signature ? "none" : "drift",
    state: { settled: true, unavailableAnnounced: false, alerted: observation.signature }
  };
}
