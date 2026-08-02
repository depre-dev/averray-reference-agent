import { describe, expect, it } from "vitest";

import {
  describeBuzzDelivery,
  recordBuzzDelivery,
} from "../../services/slack-operator/src/buzz-delivery.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const MIN = 60_000;

const describe_ = (over: Partial<Parameters<typeof describeBuzzDelivery>[0]> = {}) =>
  describeBuzzDelivery({ configured: true, state: {}, nowMs: NOW, ...over });

describe("describeBuzzDelivery", () => {
  it("ARMED is not ok — a channel that never delivered is untested", () => {
    // The state this whole feature is for. Credentials loaded, nothing ever
    // sent: showing that green would lie about whether you will be TOLD when
    // something breaks, which is worse than lying about a probe.
    const r = describe_();
    expect(r.status).toBe("armed");
    expect(r.detail).toContain("nothing delivered yet");
    expect(r.status).not.toBe("ok");
  });

  it("reports a successful delivery with its age", () => {
    const r = describe_({ state: { lastOkAt: NOW - 7 * MIN } });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("delivered 7m ago");
  });

  it("a failure since the last success reads FAILING and names the reason", () => {
    // "delivery failed" sends the operator to the wrong place; an auth
    // rejection and an unreachable relay need different responses.
    const r = describe_({
      state: { lastOkAt: NOW - 60 * MIN, lastFailureAt: NOW - 3 * MIN, lastFailureReason: "auth-rejected" },
    });
    expect(r.status).toBe("failing");
    expect(r.detail).toContain("FAILING 3m ago");
    expect(r.detail).toContain("auth-rejected");
    // The last good delivery stays visible — "broken for 3 minutes" and "broken
    // for a day" are different situations.
    expect(r.detail).toContain("last delivered 1h ago");
  });

  it("says never delivered when every attempt has failed", () => {
    const r = describe_({ state: { lastFailureAt: NOW - MIN, lastFailureReason: "connect-failed" } });
    expect(r.status).toBe("failing");
    expect(r.detail).toContain("never delivered");
  });

  it("a success AFTER a failure clears the alarm", () => {
    const r = describe_({ state: { lastFailureAt: NOW - 20 * MIN, lastOkAt: NOW - 2 * MIN } });
    expect(r.status).toBe("ok");
  });

  it("unconfigured is quiet, not an alarm", () => {
    // Buzz is optional. A permanently-lit row for a feature nobody turned on is
    // how a panel teaches its reader to ignore it.
    const r = describe_({ configured: false, problem: null });
    expect(r.status).toBe("off");
    expect(r.detail).toBe("not configured");
  });

  it("HALF-configured is a failure, because somebody meant to enable it", () => {
    const r = describe_({ configured: false, problem: "Buzz is partially configured — missing BUZZ_OPS_CHANNEL_ID" });
    expect(r.status).toBe("failing");
    expect(r.detail).toContain("BUZZ_OPS_CHANNEL_ID");
  });

  it("treats a failure at the same instant as a success as the failure", () => {
    // Ties go to the bad news: reporting ok on an equal timestamp would hide a
    // failure that landed in the same tick.
    const r = describe_({ state: { lastOkAt: NOW - MIN, lastFailureAt: NOW - MIN, lastFailureReason: "timeout" } });
    expect(r.status).toBe("failing");
  });
});

describe("a past failure stops being a claim about now", () => {
  const HOUR = 60 * MIN;

  it("the listener DISPROVES a stale connect failure", () => {
    // The inbound listener holds a socket to the same relay on the same key and
    // NIP-OA tag. While it reports listening, "connect-failed 5h ago" is a fact
    // about the past, and asserting it as current is a fake red — which costs
    // exactly what a fake green costs: the row gets scrolled past.
    const r = describe_({
      state: { lastFailureAt: NOW - 5 * HOUR, lastFailureReason: "connect-failed" },
      relayReachableNow: true,
    });
    expect(r.status).toBe("armed");
    expect(r.detail).toContain("relay reachable now");
    expect(r.detail).toContain("nothing delivered since");
  });

  it("lands on ARMED, never ok — nothing has actually been delivered", () => {
    // The distinction that matters: the relay being reachable is not a
    // delivery. `armed` renders grey and reads "#ops untested", not green.
    const r = describe_({
      state: { lastFailureAt: NOW - 5 * HOUR, lastFailureReason: "timeout" },
      relayReachableNow: true,
    });
    expect(r.status).not.toBe("ok");
    expect(r.status).toBe("armed");
  });

  it("does NOT clear a publish-rejection, which the listener cannot speak to", () => {
    // THE LINE THAT MATTERS. A reachable relay disproves connect/auth/timeout.
    // `publish-rejected` means the relay accepted our auth and refused the
    // MESSAGE — a healthy listener says nothing about that, so clearing it
    // would be inventing evidence.
    const r = describe_({
      state: { lastFailureAt: NOW - 5 * HOUR, lastFailureReason: "publish-rejected" },
      relayReachableNow: true,
    });
    expect(r.status).toBe("failing");
    expect(r.detail).toContain("publish-rejected");
  });

  it("keeps FAILING while the listener agrees the relay is unreachable", () => {
    // The four-hour outage: the row read FAILING throughout and that was
    // correct and useful. Nothing here may weaken that case.
    const r = describe_({
      state: { lastFailureAt: NOW - 3 * HOUR, lastFailureReason: "connect-failed" },
      relayReachableNow: false,
    });
    expect(r.status).toBe("failing");
  });

  it("ages an untested failure into UNKNOWN when nobody is listening", () => {
    // Deliveries are edge-triggered, so hours pass between attempts. After long
    // enough with no retry we do not know it is failing — only that it failed
    // once and was never tried again. Say the unknown out loud.
    const r = describe_({
      state: { lastFailureAt: NOW - 7 * HOUR, lastFailureReason: "connect-failed" },
    });
    expect(r.status).toBe("armed");
    expect(r.detail).toContain("untested since");
    expect(r.detail).toContain("UNKNOWN");
  });

  it("still reports a RECENT failure as failing with no listener", () => {
    const r = describe_({
      state: { lastFailureAt: NOW - 2 * HOUR, lastFailureReason: "connect-failed" },
    });
    expect(r.status).toBe("failing");
    expect(r.detail).toContain("FAILING");
  });

  it("treats no-listener as no evidence, not as unreachable", () => {
    // `undefined` and `false` must not collapse: one is "we did not look", the
    // other is "we looked and it is down". A recent failure with no listener
    // stays failing rather than being cleared by absent evidence.
    const recent = { lastFailureAt: NOW - 10 * MIN, lastFailureReason: "connect-failed" };
    expect(describe_({ state: recent }).status).toBe("failing");
    expect(describe_({ state: recent, relayReachableNow: false }).status).toBe("failing");
    expect(describe_({ state: recent, relayReachableNow: true }).status).toBe("armed");
  });

  it("notes reachability even when nothing was ever sent", () => {
    const r = describe_({ relayReachableNow: true });
    expect(r.status).toBe("armed");
    expect(r.detail).toContain("relay reachable");
    expect(r.detail).toContain("nothing delivered yet");
  });
});

describe("recordBuzzDelivery", () => {
  it("keeps the last success and the last failure independently", () => {
    let state = recordBuzzDelivery({}, { ok: true, atMs: NOW - 10 * MIN });
    state = recordBuzzDelivery(state, { ok: false, reason: "timeout", detail: "no response", atMs: NOW });
    expect(state.lastOkAt).toBe(NOW - 10 * MIN);
    expect(state.lastFailureAt).toBe(NOW);
    expect(state.lastFailureReason).toBe("timeout");
  });

  it("a success does not erase the failure history", () => {
    // Which is what lets the row say "delivered 2m ago" while an operator can
    // still see it was broken twenty minutes back.
    const state = recordBuzzDelivery(
      { lastFailureAt: NOW - 20 * MIN, lastFailureReason: "auth-rejected" },
      { ok: true, atMs: NOW },
    );
    expect(state.lastOkAt).toBe(NOW);
    expect(state.lastFailureAt).toBe(NOW - 20 * MIN);
  });
});
