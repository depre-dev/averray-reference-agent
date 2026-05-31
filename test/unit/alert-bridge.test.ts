import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateAlertBridge,
  initialAlertBridgeState,
  inQuietHours,
  buildAlertPayload,
  slackAlertChannel,
  minuteOfDayForOffset,
  setServerAlertMute,
  getServerAlertMuteUntilMs,
  clearServerAlertMute,
  type AlertItem,
  type AlertBridgeState,
  type AlertBridgeConfig,
} from "../../services/slack-operator/src/alert-bridge.js";
import { parseQuietHoursRange } from "../../services/slack-operator/src/routines.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearServerAlertMute();
});

const item = (id: string, title = id): AlertItem => ({ id, title });
const COOLDOWN = 30 * 60_000;
const cfg = (over: Partial<AlertBridgeConfig> = {}): AlertBridgeConfig => ({ cooldownMs: COOLDOWN, ...over });

function step(
  items: AlertItem[],
  nowMs: number,
  state: AlertBridgeState,
  config: AlertBridgeConfig = cfg(),
  minuteOfDay = 12 * 60,
) {
  return evaluateAlertBridge({ items, nowMs, nowMinuteOfDay: minuteOfDay, state, config });
}

describe("evaluateAlertBridge — rising edge + de-dup", () => {
  it("fires once on the 0→≥1 rising edge, then stays quiet while ≥1 with the same items", () => {
    let s = initialAlertBridgeState();
    const r1 = step([item("a")], 1_000, s);
    expect(r1.dispatch).toBe(true);
    expect(r1.reason).toBe("rising_edge");
    s = r1.state;

    const r2 = step([item("a")], 2_000, s);
    expect(r2.dispatch).toBe(false);
    expect(r2.reason).toBe("deduped");
  });

  it("re-fires after it returns to 0 and rises again", () => {
    let s = initialAlertBridgeState();
    s = step([item("a")], 1_000, s).state; // rising
    s = step([item("a")], 2_000, s).state; // deduped
    const cleared = step([], 3_000, s);
    expect(cleared.dispatch).toBe(false);
    expect(cleared.reason).toBe("clear");
    const again = step([item("a")], 4_000, cleared.state);
    expect(again.dispatch).toBe(true);
    expect(again.reason).toBe("rising_edge");
  });

  it("re-alerts on a NEW distinct item while still ≥1", () => {
    let s = initialAlertBridgeState();
    s = step([item("a")], 1_000, s).state; // rising (a)
    const r = step([item("a"), item("b")], 2_000, s);
    expect(r.dispatch).toBe(true);
    expect(r.reason).toBe("new_items");
    expect(r.payloadItems.map((i) => i.id)).toEqual(["b"]); // only the new one
  });

  it("re-alerts after the cooldown even with no new item", () => {
    let s = initialAlertBridgeState();
    const r1 = step([item("a")], 1_000, s);
    s = r1.state;
    const tooSoon = step([item("a")], 1_000 + 10 * 60_000, s);
    expect(tooSoon.dispatch).toBe(false);
    const afterCooldown = step([item("a")], 1_000 + 31 * 60_000, tooSoon.state);
    expect(afterCooldown.dispatch).toBe(true);
    expect(afterCooldown.reason).toBe("cooldown");
  });

  it("cooldown of 0 means never re-alert without a new item", () => {
    let s = initialAlertBridgeState();
    s = step([item("a")], 1_000, s, cfg({ cooldownMs: 0 })).state;
    const later = step([item("a")], 1_000 + 10 * 60 * 60_000, s, cfg({ cooldownMs: 0 }));
    expect(later.dispatch).toBe(false);
  });
});

describe("evaluateAlertBridge — suppression (mute + quiet-hours)", () => {
  it("mute suppresses, and the alert fires once the mute lifts (state not advanced)", () => {
    const s = initialAlertBridgeState();
    const muted = step([item("a")], 1_000, s, cfg({ muteUntilMs: 5_000 }));
    expect(muted.dispatch).toBe(false);
    expect(muted.suppressedBy).toBe("mute");
    expect(muted.state.alertedIds).toEqual([]); // not marked alerted

    const afterMute = step([item("a")], 6_000, muted.state, cfg({ muteUntilMs: 5_000 }));
    expect(afterMute.dispatch).toBe(true); // fires now that mute lifted
  });

  it("quiet-hours suppresses inside the window", () => {
    const s = initialAlertBridgeState();
    const q = { startMinute: 22 * 60, endMinute: 7 * 60 }; // 22:00–07:00, wraps midnight
    const inWindow = step([item("a")], 1_000, s, cfg({ quietHours: q }), 23 * 60);
    expect(inWindow.dispatch).toBe(false);
    expect(inWindow.suppressedBy).toBe("quiet-hours");
    const outside = step([item("a")], 2_000, inWindow.state, cfg({ quietHours: q }), 12 * 60);
    expect(outside.dispatch).toBe(true);
  });
});

describe("inQuietHours", () => {
  it("handles same-day and midnight-wrapping windows", () => {
    expect(inQuietHours(9 * 60, { startMinute: 8 * 60, endMinute: 17 * 60 })).toBe(true);
    expect(inQuietHours(20 * 60, { startMinute: 8 * 60, endMinute: 17 * 60 })).toBe(false);
    // wrap
    expect(inQuietHours(23 * 60, { startMinute: 22 * 60, endMinute: 7 * 60 })).toBe(true);
    expect(inQuietHours(3 * 60, { startMinute: 22 * 60, endMinute: 7 * 60 })).toBe(true);
    expect(inQuietHours(12 * 60, { startMinute: 22 * 60, endMinute: 7 * 60 })).toBe(false);
    expect(inQuietHours(12 * 60, undefined)).toBe(false);
  });
});

describe("buildAlertPayload", () => {
  it("single item → deep link to the card", () => {
    const p = buildAlertPayload([item("agent #602", "Cross-agent reputation (C4)")], 1, "https://monitor.averray.com/monitor/");
    expect(p.boardUrl).toBe("https://monitor.averray.com/monitor?card=agent%20%23602");
    expect(p.text).toContain("1 card needs your review");
    expect(p.text).toContain("Cross-agent reputation (C4)");
    expect(p.text).toContain(p.boardUrl);
  });

  it("multiple items → deep link to the needs-attention lane + count", () => {
    const p = buildAlertPayload([item("a"), item("b")], 4, "https://monitor.averray.com/monitor");
    expect(p.boardUrl).toBe("https://monitor.averray.com/monitor?lane=needs-attention");
    expect(p.text).toContain("4 cards need your review");
  });
});

describe("slackAlertChannel (no network)", () => {
  it("no webhook → no-op, returns false, never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ch = slackAlertChannel(undefined);
    const sent = await ch.dispatch(buildAlertPayload([item("a")], 1, "https://x/monitor"));
    expect(sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with a webhook → POSTs { text } and returns true", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const ch = slackAlertChannel("https://hooks.slack.test/abc");
    const payload = buildAlertPayload([item("a", "Needs you")], 1, "https://x/monitor");
    const sent = await ch.dispatch(payload);
    expect(sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ text: payload.text });
  });
});

describe("server-side mute state", () => {
  it("set/get/clear round-trips", () => {
    expect(getServerAlertMuteUntilMs()).toBe(0);
    setServerAlertMute(123_456);
    expect(getServerAlertMuteUntilMs()).toBe(123_456);
    setServerAlertMute(0);
    expect(getServerAlertMuteUntilMs()).toBe(0);
    setServerAlertMute(999);
    clearServerAlertMute();
    expect(getServerAlertMuteUntilMs()).toBe(0);
  });
});

describe("minuteOfDayForOffset + parseQuietHoursRange", () => {
  it("minuteOfDayForOffset applies the tz offset", () => {
    // 2026-01-01T00:00:00Z + 90 min offset → 01:30 local → 90 minutes of day.
    const utcMidnight = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(minuteOfDayForOffset(utcMidnight, 90)).toBe(90);
    expect(minuteOfDayForOffset(utcMidnight, 0)).toBe(0);
  });

  it("parseQuietHoursRange parses valid windows and rejects junk", () => {
    expect(parseQuietHoursRange("22:00-07:00")).toEqual({ startMinute: 1320, endMinute: 420 });
    expect(parseQuietHoursRange("08:30-17:00")).toEqual({ startMinute: 510, endMinute: 1020 });
    expect(parseQuietHoursRange("")).toBeUndefined();
    expect(parseQuietHoursRange("nonsense")).toBeUndefined();
    expect(parseQuietHoursRange("09:00-09:00")).toBeUndefined(); // empty window
    expect(parseQuietHoursRange("25:00-07:00")).toBeUndefined();
  });
});
