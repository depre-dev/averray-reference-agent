// Chain-ticker derivation — the honesty contract, tested deterministically:
// the height never changes client-side; only the age ticks; staleness dulls a
// green but never softens an alarm.

import { describe, expect, test } from "vitest";
import { deriveChainTicker } from "./chain-ticker.js";
import type { ChainTick, ProductHealthProbe } from "./product-health.js";

const T0 = 1_700_000_000_000;

const okProbe: ProductHealthProbe = {
  name: "chain_height",
  status: "ok",
  detail: "block #18,812,345 · 3s old",
  sparkline: ["ok"],
};

function tick(overrides: Partial<ChainTick> = {}): ChainTick {
  return { height: 18_812_345, observedAtMs: T0, blockAgeSec: 3, lastAdvanceAtMs: T0, freshSeconds: 600, ...overrides };
}

describe("deriveChainTicker", () => {
  test("awaiting when no chain block is present (never a fabricated number)", () => {
    const view = deriveChainTicker({ chain: undefined, probe: okProbe, nowMs: T0 });
    expect(view.kind).toBe("awaiting");
  });

  test("awaiting on a non-positive height", () => {
    expect(deriveChainTicker({ chain: tick({ height: 0 }), probe: okProbe, nowMs: T0 }).kind).toBe("awaiting");
    expect(deriveChainTicker({ chain: tick({ height: Number.NaN }), probe: okProbe, nowMs: T0 }).kind).toBe("awaiting");
  });

  test("formats the observed height and starts the age from the measured block age", () => {
    const view = deriveChainTicker({ chain: tick(), probe: okProbe, nowMs: T0 });
    expect(view).toMatchObject({ kind: "ready", heightLabel: "#18,812,345", tone: "ok", stale: false });
    if (view.kind === "ready") expect(view.ageSeconds).toBe(3);
  });

  test("the age ticks with the clock; the height NEVER self-increments", () => {
    const later = deriveChainTicker({ chain: tick(), probe: okProbe, nowMs: T0 + 42_000 });
    expect(later.kind).toBe("ready");
    if (later.kind === "ready") {
      expect(later.heightLabel).toBe("#18,812,345"); // same block — no invented advance
      expect(later.ageSeconds).toBe(45); // 3s measured + 42s elapsed
      expect(later.ageLabel).toBe("45s");
    }
  });

  test("falls back to the last-advance tracker when no measured block age exists", () => {
    const chain = tick({ blockAgeSec: null, lastAdvanceAtMs: T0 - 30_000 });
    const view = deriveChainTicker({ chain, probe: okProbe, nowMs: T0 + 10_000 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.ageSeconds).toBe(40); // 30s at observation + 10s since
  });

  test("weakest fallback: age = time since the reading itself", () => {
    const chain = tick({ blockAgeSec: null, lastAdvanceAtMs: null });
    const view = deriveChainTicker({ chain, probe: okProbe, nowMs: T0 + 20_000 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.ageSeconds).toBe(20);
  });

  test("stale past the producer's freshness window downgrades ok to telemetry-gray", () => {
    const view = deriveChainTicker({ chain: tick(), probe: okProbe, nowMs: T0 + 601_000 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.stale).toBe(true);
      expect(view.tone).toBe("awaiting"); // not confidently green on old data
    }
  });

  test("staleness never softens an alarm — a red probe stays red", () => {
    const redProbe: ProductHealthProbe = { ...okProbe, status: "red", detail: "chain not advancing" };
    const view = deriveChainTicker({ chain: tick(), probe: redProbe, nowMs: T0 + 601_000 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.stale).toBe(true);
      expect(view.tone).toBe("red");
    }
  });

  test("a failing product-health poll marks the reading stale immediately", () => {
    const view = deriveChainTicker({ chain: tick(), probe: okProbe, pollError: true, nowMs: T0 + 1_000 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.stale).toBe(true);
      expect(view.tone).toBe("awaiting");
    }
  });

  test("probe tone authority: degraded probe renders a degraded chip", () => {
    const degradedProbe: ProductHealthProbe = { ...okProbe, status: "degraded" };
    const view = deriveChainTicker({ chain: tick(), probe: degradedProbe, nowMs: T0 });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.tone).toBe("degraded");
  });
});
