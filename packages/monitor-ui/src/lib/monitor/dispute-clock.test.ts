import { describe, expect, test } from "vitest";

import { disputeClockLine } from "./ops-spec.js";
import type { ExternalFunnelView } from "./product-health.js";

const NOW = Date.parse("2026-08-02T18:00:00.000Z");
const H = 3_600_000;
const funnel = (over: Partial<ExternalFunnelView["buckets"]["rejected_window_running"]> | null): ExternalFunnelView => ({
  buckets: over === null ? {} : { rejected_window_running: { count: 1, ...over } },
  disputeWindowSeconds: 94_000,
});

describe("disputeClockLine", () => {
  test("is ABSENT when nothing is counting down", () => {
    // A line always present and almost always saying "0" is one nobody reads on
    // the day it matters.
    expect(disputeClockLine(funnel(null), NOW)).toBeNull();
    expect(disputeClockLine(funnel({ count: 0 }), NOW)).toBeNull();
    expect(disputeClockLine(undefined, NOW)).toBeNull();
  });

  test("appears while the clock is still COMFORTABLE", () => {
    // The whole gap this closes: at 60h the probe is correctly ok and the
    // countdown was invisible — which is exactly when acting is cheapest.
    const v = disputeClockLine(funnel({ oldestDeadlineMs: NOW + 60 * H, leadJobId: "0xaa4b7b03cd" }), NOW)!;
    expect(v.text).toContain("slashes in 3d");
    expect(v.text).toContain("0xaa4b7b03");
    expect(v.tone).toBe("awaiting");
  });

  test("mirrors the probe's thresholds instead of inventing new ones", () => {
    // A countdown shown twice in two different colours is how an operator
    // learns to trust neither.
    expect(disputeClockLine(funnel({ oldestDeadlineMs: NOW + 40 * H }), NOW)!.tone).toBe("degraded");
    expect(disputeClockLine(funnel({ oldestDeadlineMs: NOW + 6 * H }), NOW)!.tone).toBe("red");
  });

  test("a lapsed window says so plainly, not as a countdown", () => {
    const v = disputeClockLine(funnel({ oldestDeadlineMs: NOW - H }), NOW)!;
    expect(v.text).toContain("LAPSED");
    expect(v.text).toContain("slashable now");
    expect(v.tone).toBe("red");
  });

  test("an unreadable deadline is NOT 'no bond at risk'", () => {
    // Jobs are in the window and we cannot see the clock. That is an instrument
    // fault; rendering it as calm would be the fake green this board forbids.
    const v = disputeClockLine(funnel({ count: 2, oldestDeadlineMs: undefined }), NOW)!;
    expect(v.text).toContain("UNREADABLE");
    expect(v.text).toContain("2 bonds");
    expect(v.tone).toBe("degraded");
  });

  test("shows minutes when that is what is left", () => {
    expect(disputeClockLine(funnel({ oldestDeadlineMs: NOW + 25 * 60_000 }), NOW)!.text).toContain("slashes in 25m");
  });
});
