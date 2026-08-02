import { describe, expect, it } from "vitest";

import {
  decideProbeTransitions,
  reasonClass,
  type ProbeTransitionDecision,
} from "../../services/slack-operator/src/probe-transitions.js";
import type { ProbeResult } from "../../services/slack-operator/src/product-health.js";

const p = (name: string, status: ProbeResult["status"], detail = "fine"): ProbeResult => ({
  name,
  status,
  detail,
});

const decide = (
  over: Partial<Parameters<typeof decideProbeTransitions>[0]> = {},
): ProbeTransitionDecision =>
  decideProbeTransitions({
    previous: new Map(),
    current: [],
    posted: new Set(),
    muted: false,
    ...over,
  });

describe("reasonClass", () => {
  it("blanks the numbers that drift while the situation holds still", () => {
    // external_funnel counts DOWN. Keyed on the raw detail, this alerts every
    // poll while saying nothing new — the same trap the payout alert hit.
    const nine = p("external_funnel", "red", "rejected 0xaa4b… slashes in 9h · 1 in dispute window");
    const eight = p("external_funnel", "red", "rejected 0xaa4b… slashes in 8h · 1 in dispute window");
    expect(reasonClass(nine)).toBe(reasonClass(eight));
  });

  it("separates a different problem wearing the same severity", () => {
    const counting = p("external_funnel", "red", "rejected 0xaa4b… slashes in 9h");
    const lapsed = p("external_funnel", "red", "rejected 0xaa4b… dispute window LAPSED — bond slashable now");
    expect(reasonClass(counting)).not.toBe(reasonClass(lapsed));
  });

  it("separates severities of the same text", () => {
    expect(reasonClass(p("x", "degraded", "same"))).not.toBe(reasonClass(p("x", "red", "same")));
  });
});

describe("decideProbeTransitions", () => {
  it("says nothing about a probe it is seeing for the first time", () => {
    // First sight is the boot transition. Alerting here pages the operator on
    // every restart about a state that has not changed.
    const r = decide({ current: [p("money_path", "red", "settlement stalled")] });
    expect(r.alerts).toEqual([]);
    expect(r.next.get("money_path")?.status).toBe("red");
  });

  it("alerts when a probe enters degraded, carrying its own words", () => {
    const r = decide({
      previous: new Map([["external_funnel", p("external_funnel", "ok", "0 in dispute window")]]),
      current: [p("external_funnel", "red", "rejected 0xaa4b… slashes in 9h")],
    });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ probe: "external_funnel", kind: "opened", from: "ok", to: "red" });
    expect(r.alerts[0]?.text).toBe("⚠ external_funnel: rejected 0xaa4b… slashes in 9h");
  });

  it("does NOT repeat while the same reason class persists", () => {
    // The whole point of edge-triggering: a probe degraded for six hours must
    // not repost every heartbeat, or the one channel worth reading becomes the
    // one you scroll past.
    const previous = new Map([["external_funnel", p("external_funnel", "red", "slashes in 9h")]]);
    const current = [p("external_funnel", "red", "slashes in 8h")];
    const key = reasonClass(current[0]!);
    const r = decide({ previous, current, posted: new Set([key]) });
    expect(r.alerts).toEqual([]);
    // …and the key survives, so an unrelated probe changing does not revive it.
    expect(r.keys.has(key)).toBe(true);
  });

  it("alerts again when the reason class changes at the same severity", () => {
    // Still red, but a countdown becoming "LAPSED" is a different problem and
    // the operator's next action differs.
    const previous = new Map([["external_funnel", p("external_funnel", "red", "slashes in 9h")]]);
    const r = decide({
      previous,
      current: [p("external_funnel", "red", "dispute window LAPSED — bond slashable now")],
      posted: new Set([reasonClass(p("external_funnel", "red", "slashes in 9h"))]),
    });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]?.text).toContain("LAPSED");
  });

  it("treats an escalation and a de-escalation as material changes", () => {
    const up = decide({
      previous: new Map([["x", p("x", "degraded", "a")]]),
      current: [p("x", "red", "b")],
    });
    expect(up.alerts).toHaveLength(1);
    const down = decide({
      previous: new Map([["x", p("x", "red", "a")]]),
      current: [p("x", "degraded", "b")],
    });
    expect(down.alerts).toHaveLength(1);
  });

  it("posts one recovery when a probe returns to ok", () => {
    // A channel that only reports bad news leaves you guessing whether it ended.
    const r = decide({
      previous: new Map([["signer_liquidity", p("signer_liquidity", "red", "gas 0.4 < 1")]]),
      current: [p("signer_liquidity", "ok", "gas 5.2 DOT")],
    });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ kind: "recovered", from: "red", to: "ok" });
    expect(r.alerts[0]?.text).toBe("✓ signer_liquidity recovered: gas 5.2 DOT");
  });

  it("does not retain recovery keys — breaking twice is two events", () => {
    const r = decide({
      previous: new Map([["x", p("x", "red", "bad")]]),
      current: [p("x", "ok", "fine")],
    });
    expect([...r.keys]).toEqual([]);
  });

  it("stays silent about an ok probe that was already ok", () => {
    const r = decide({
      previous: new Map([["x", p("x", "ok", "fine")]]),
      current: [p("x", "ok", "still fine")],
    });
    expect(r.alerts).toEqual([]);
  });

  it("says NOTHING when a probe disappears", () => {
    // Absence is not recovery. Claiming it would be the same lie as a fake
    // green — the probe stopped reporting, which is not the same as fine.
    const r = decide({
      previous: new Map([["gone", p("gone", "red", "was broken")]]),
      current: [p("other", "ok", "fine")],
    });
    expect(r.alerts).toEqual([]);
    expect(r.next.has("gone")).toBe(false);
  });

  it("is silent while muted but still tracks state", () => {
    // Mute must not desynchronise the edge detector, or the first post after
    // unmuting would be about a transition that happened hours ago.
    const r = decide({
      previous: new Map([["x", p("x", "ok", "fine")]]),
      current: [p("x", "red", "broken")],
      muted: true,
    });
    expect(r.alerts).toEqual([]);
    expect(r.next.get("x")?.status).toBe("red");
    expect(r.keys.has(reasonClass(p("x", "red", "broken")))).toBe(true);
  });

  it("handles several probes crossing in the same tick", () => {
    const r = decide({
      previous: new Map([
        ["a", p("a", "ok", "fine")],
        ["b", p("b", "red", "broken")],
        ["c", p("c", "ok", "fine")],
      ]),
      current: [p("a", "red", "now broken"), p("b", "ok", "healed"), p("c", "ok", "fine")],
    });
    expect(r.alerts.map((x) => `${x.probe}:${x.kind}`).sort()).toEqual(["a:opened", "b:recovered"]);
  });

  it("a restart does not re-announce an alarm that never changed", () => {
    // THE REGRESSION. Tick 1 after a restart sees the probe for the first time
    // and is correctly silent — but it must also REMEMBER, or tick 2 finds an
    // empty posted set and treats the same unchanged alarm as fresh news.
    // Production posted three duplicate money_path alerts this way, one per
    // deploy, before this was caught.
    const broken = p("money_path", "degraded", "stuck 1, settled24h 12");

    // tick 1 — cold start, probe already degraded
    const first = decide({ previous: new Map(), current: [broken] });
    expect(first.alerts).toEqual([]);
    expect(first.keys.has(reasonClass(broken))).toBe(true);

    // tick 2 — nothing changed; the retained key must suppress it
    const second = decide({ previous: first.next, current: [broken], posted: first.keys });
    expect(second.alerts).toEqual([]);
  });

  it("a restart still lets a LATER genuine change through", () => {
    // The fix must not over-suppress: a cold start followed by a real
    // escalation is news, and staying quiet would be the opposite failure.
    const degraded = p("money_path", "degraded", "stuck 1");
    const first = decide({ previous: new Map(), current: [degraded] });
    const worse = p("money_path", "red", "stuck 9, settlement stalled");
    const second = decide({ previous: first.next, current: [worse], posted: first.keys });
    expect(second.alerts).toHaveLength(1);
    expect(second.alerts[0]?.to).toBe("red");
  });

  it("a probe that is HEALTHY at first sight retains nothing", () => {
    const first = decide({ previous: new Map(), current: [p("x", "ok", "fine")] });
    expect([...first.keys]).toEqual([]);
  });
});
