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
