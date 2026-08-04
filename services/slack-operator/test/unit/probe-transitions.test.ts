// What #Ops is allowed to say, and how often.
//
// This module had NO tests. Its own comments record that production found its
// last two defects — three duplicate money_path alerts after three deploys in
// one night, and a countdown re-alerting every poll. On 2026-08-04 it produced
// a third, in front of the operator:
//
//   10:54  ⚠ capabilities: new capability warning: external_posting_staged
//   10:54  ⚠ … indexer_lagging, external_posting_staged
//   11:14  ✓ capabilities recovered …
//   12:36  ✓ capabilities recovered …
//    1:10  ⚠ … external_posting_staged
//    1:25  ⚠ … indexer_lagging, external_posting_staged
//    1:25  ⚠ … external_posting_staged
//    1:25  ⚠ … indexer_lagging, external_posting_staged
//    1:25  ✓ capabilities recovered …
//
// Eight messages for a condition the same text calls acknowledged and not red.
// Nothing was happening: one warning entered and left the product's array as a
// watcher lag crossed a threshold, and the reason class is built from the
// detail, so each flip read as a new problem.
//
// That channel also carried, twice that day, `model "hermes-agent" not found` —
// the one message that mattered, sitting in the noise this module generated.
import { describe, expect, test } from "vitest";

import { decideProbeTransitions, holdRequired, reasonClass } from "../../src/probe-transitions.js";
import type { ProbeResult } from "../../src/product-health.js";

const probe = (status: ProbeResult["status"], detail: string, name = "capabilities"): ProbeResult =>
  ({ name, status, detail }) as ProbeResult;

/** Feed ticks through the decider, threading state the way index.ts does. */
function run(ticks: ProbeResult[][], opts: { minDegradedTicks?: number } = {}) {
  let previous = new Map<string, ProbeResult>();
  let posted = new Set<string>();
  let streaks = new Map<string, number>();
  const said: string[] = [];
  for (const current of ticks) {
    const d = decideProbeTransitions({
      previous,
      current,
      posted,
      muted: false,
      streaks,
      ...(opts.minDegradedTicks !== undefined ? { minDegradedTicks: opts.minDegradedTicks } : {}),
    });
    said.push(...d.alerts.map((a) => a.text));
    previous = d.next;
    posted = d.keys;
    streaks = d.streaks;
  }
  return said;
}

const A = "new capability warning: external_posting_staged";
const AB = "new capability warning: indexer_lagging, external_posting_staged";
const OK = "2/2 required up · xcmObserver staged";

describe("a flapping warning does not get to speak", () => {
  test("THE 2026-08-04 BURST: eight messages become none", () => {
    // Replayed from the channel. A first tick to establish a prior reading
    // (first sight never alerts), then the alternation that produced the burst.
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", AB)],
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", AB)],
      [probe("degraded", A)],
      [probe("degraded", AB)],
      [probe("ok", OK)],
    ]);
    expect(said).toEqual([]);
  });

  test("but a condition that HOLDS is said, exactly once", () => {
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [probe("degraded", A)], // third consecutive tick — earns the hold
      [probe("degraded", A)],
      [probe("degraded", A)],
    ]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("external_posting_staged");
  });

  test("the hold is consecutive — an interruption resets it", () => {
    // Two ticks, a flip, two ticks. Neither run reaches three, so neither
    // speaks. This is the difference between "persistent" and "frequent".
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [probe("degraded", AB)],
      [probe("degraded", A)],
      [probe("degraded", A)],
    ]);
    expect(said).toEqual([]);
  });
});

describe("red is exempt, because red is the money path", () => {
  test("red speaks on the first tick, with no hold at all", () => {
    const said = run([[probe("ok", OK)], [probe("red", "required capability down: blockchain=missing")]]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("required capability down");
  });

  test("holdRequired says so directly", () => {
    // Guarded at the function rather than only through a scenario: the whole
    // safety argument for this feature is that it cannot delay a red.
    expect(holdRequired("red", 99)).toBe(1);
    expect(holdRequired("degraded", 3)).toBe(3);
    // A misconfigured 0 must not mean "never speak".
    expect(holdRequired("degraded", 0)).toBe(1);
  });

  test("a degraded probe escalating to red is not held back by its own streak", () => {
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("red", "required capability down: blockchain=missing")],
    ]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("required capability down");
  });
});

describe("recovery is only announced for something that was announced", () => {
  test("no all-clear for an alarm nobody was given", () => {
    // Under the hold a flapping class never posts an "opened", so an
    // unconditional recovery would leave the channel carrying ONLY all-clears
    // for problems the operator never heard about.
    const said = run([[probe("ok", OK)], [probe("degraded", A)], [probe("ok", OK)]]);
    expect(said).toEqual([]);
  });

  test("but a real alarm still gets its all-clear", () => {
    // A channel that only reports bad news leaves you guessing whether it is
    // over — the reason recovery alerts exist at all.
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [probe("ok", OK)],
    ]);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("⚠");
    expect(said[1]).toContain("✓");
    expect(said[1]).toContain("recovered");
  });
});

describe("the rules that were already there stay there", () => {
  test("first sight never alerts — a restart is not news", () => {
    expect(run([[probe("red", "required capability down: blockchain=missing")]])).toEqual([]);
  });

  test("a probe that vanishes says nothing — absence is not recovery", () => {
    const said = run([
      [probe("ok", OK)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [probe("degraded", A)],
      [], // the probe stops being reported
    ]);
    expect(said).toHaveLength(1); // the opened alert only
  });

  test("a drifting number is the same alert, not a new one", () => {
    // reasonClass blanks digits, so a countdown does not re-alert. Held from
    // the original module; the hold must not have broken it.
    expect(reasonClass(probe("degraded", "bond slashes in 9h", "external_funnel")))
      .toBe(reasonClass(probe("degraded", "bond slashes in 8h", "external_funnel")));
  });

  test("muted stays silent but still advances state", () => {
    let previous = new Map<string, ProbeResult>([["capabilities", probe("ok", OK)]]);
    const d = decideProbeTransitions({
      previous,
      current: [probe("red", "required capability down: blockchain=missing")],
      posted: new Set(),
      muted: true,
      streaks: new Map(),
    });
    expect(d.alerts).toEqual([]);
    // The key is retained, so unmuting does not replay an hours-old edge.
    expect(d.keys.size).toBe(1);
  });
});
