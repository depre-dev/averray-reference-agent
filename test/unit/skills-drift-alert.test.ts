import { describe, expect, it } from "vitest";

import {
  decideDriftAlert,
  initialDriftAlertState,
  type DriftObservation
} from "../../services/skills-observer/src/drift-alert.js";

const CLEAN: DriftObservation = { kind: "in-sync" };
const DOWN: DriftObservation = { kind: "unavailable" };
const DRIFT_A: DriftObservation = {
  kind: "drifted",
  signature: "missing:ops/a/SKILL.md|modified:"
};
const DRIFT_B: DriftObservation = {
  kind: "drifted",
  signature: "missing:ops/a/SKILL.md,ops/b/SKILL.md|modified:"
};

/** Feed a sequence of observations through the state machine. */
function run(observations: DriftObservation[]): string[] {
  let state = initialDriftAlertState;
  return observations.map((observation) => {
    const decision = decideDriftAlert(state, observation);
    state = decision.state;
    return decision.announce;
  });
}

describe("decideDriftAlert", () => {
  it("stays quiet on the first check, which races skills-sync still copying", () => {
    expect(run([DRIFT_A])).toEqual(["none"]);
  });

  it("does not swallow drift that is real: the pass after the first announces it", () => {
    // The boot suppression must not double as a permanent mute. This is the
    // whole reason the first check does not record what it saw.
    expect(run([DRIFT_A, DRIFT_A])).toEqual(["none", "drift"]);
  });

  it("says nothing when the boot race resolves itself", () => {
    // Drifted at startup only because the sync had not finished; no alert, and
    // no "recovered" for a problem that was never announced.
    expect(run([DRIFT_A, CLEAN])).toEqual(["none", "none"]);
  });

  it("announces a standing divergence exactly once", () => {
    expect(run([CLEAN, DRIFT_A, DRIFT_A, DRIFT_A])).toEqual(["none", "drift", "none", "none"]);
  });

  it("re-announces when the divergence widens to more files", () => {
    expect(run([CLEAN, DRIFT_A, DRIFT_B])).toEqual(["none", "drift", "drift"]);
  });

  it("reports recovery only after something was announced", () => {
    expect(run([CLEAN, DRIFT_A, CLEAN])).toEqual(["none", "drift", "recovery"]);
    // Never drifted, so there is nothing to say it recovered from.
    expect(run([CLEAN, CLEAN, CLEAN])).toEqual(["none", "none", "none"]);
  });

  it("recovers once, not on every subsequent clean check", () => {
    expect(run([CLEAN, DRIFT_A, CLEAN, CLEAN])).toEqual(["none", "drift", "recovery", "none"]);
  });

  it("announces again if the same drift returns after a recovery", () => {
    expect(run([CLEAN, DRIFT_A, CLEAN, DRIFT_A])).toEqual([
      "none",
      "drift",
      "recovery",
      "drift"
    ]);
  });
});

describe("decideDriftAlert, when the check itself cannot run", () => {
  it("announces that the check is down — silence would read as 'nothing wrong'", () => {
    // A drift check that has quietly stopped working reproduces the exact
    // failure this mechanism exists to end.
    expect(run([CLEAN, DOWN])).toEqual(["none", "unavailable"]);
  });

  it("says it once, not on every interval it stays down", () => {
    expect(run([CLEAN, DOWN, DOWN, DOWN])).toEqual(["none", "unavailable", "none", "none"]);
  });

  it("stays quiet if the very first check cannot run, then announces on the next", () => {
    expect(run([DOWN, DOWN])).toEqual(["none", "unavailable"]);
  });

  it("re-announces drift seen again after the check recovers", () => {
    // Being unable to look does not confirm the previous verdict, so the alert
    // must not be suppressed as "already reported".
    expect(run([CLEAN, DRIFT_A, DOWN, DRIFT_A])).toEqual([
      "none",
      "drift",
      "unavailable",
      "drift"
    ]);
  });

  it("does not claim recovery for a divergence it merely stopped being able to see", () => {
    // The recovery here closes the "cannot check" alert, and it is backed by an
    // actual in-sync reading rather than by the drift having been forgotten.
    expect(run([CLEAN, DRIFT_A, DOWN, CLEAN, CLEAN])).toEqual([
      "none",
      "drift",
      "unavailable",
      "recovery",
      "none"
    ]);
  });

  it("closes an unavailable alert once the check works again", () => {
    expect(run([CLEAN, DOWN, CLEAN])).toEqual(["none", "unavailable", "recovery"]);
  });

  it("does not announce recovery when the check comes back to find real drift", () => {
    expect(run([CLEAN, DOWN, DRIFT_A])).toEqual(["none", "unavailable", "drift"]);
  });
});

describe("initial state", () => {
  it("treats an in-sync first check as settled without announcing", () => {
    const decision = decideDriftAlert(initialDriftAlertState, CLEAN);
    expect(decision.announce).toBe("none");
    expect(decision.state.settled).toBe(true);
    expect(decision.state.alerted).toBeUndefined();
    expect(decision.state.unavailableAnnounced).toBe(false);
  });
});
