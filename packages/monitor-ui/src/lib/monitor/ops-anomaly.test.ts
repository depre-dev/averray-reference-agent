import { describe, expect, test } from "vitest";
import { detectAnomalies, anomalyPhrase } from "./ops-anomaly.js";
import type { HealthHistory } from "./product-health.js";

const hist = (latency?: (number | null)[], balance?: (number | null)[]): HealthHistory => ({
  latencySeriesMs: latency,
  balanceSeries: balance,
});

describe("detectAnomalies", () => {
  test("flags a latency spike against its own baseline (up, warn)", () => {
    const a = detectAnomalies(hist([...Array(10).fill(75), 300])).find((x) => x.metric === "latency");
    expect(a).toBeTruthy();
    expect(a!.direction).toBe("up");
    expect(a!.severity).toBe("warn");
    expect(a!.baseline).toBe(75);
    expect(a!.current).toBe(300);
    expect(a!.deviationPct).toBeGreaterThan(200);
  });

  test("does not flag ordinary latency jitter", () => {
    expect(detectAnomalies(hist([74, 75, 76, 75, 74, 76, 75, 74, 76, 78]))).toEqual([]);
  });

  test("flags a signer-balance drain (down)", () => {
    const a = detectAnomalies(hist(undefined, [...Array(10).fill(10), 6])).find((x) => x.metric === "balance");
    expect(a).toBeTruthy();
    expect(a!.direction).toBe("down");
    expect(a!.deviationPct).toBeLessThan(0);
  });

  test("ignores the good direction — a latency drop or a balance refill never flags", () => {
    expect(detectAnomalies(hist([...Array(10).fill(200), 40]))).toEqual([]); // latency improved
    expect(detectAnomalies(hist(undefined, [...Array(10).fill(5), 12]))).toEqual([]); // balance refilled
  });

  test("insufficient samples → no flag (never fabricates a signal)", () => {
    expect(detectAnomalies(hist([75, 400]))).toEqual([]); // 2 samples < min 8
    expect(detectAnomalies(undefined)).toEqual([]);
  });

  test("a real but sub-threshold deviation is held back by the min-% bar", () => {
    // flat baseline 100, current 120 → z ≈ 4 (≥ infoZ) but only 20% (< 25%) → no flag
    expect(detectAnomalies(hist([...Array(9).fill(100), 120]))).toEqual([]);
  });

  test("severity: moderate → info, extreme → warn", () => {
    expect(detectAnomalies(hist([...Array(9).fill(100), 128]))[0].severity).toBe("info"); // ~28%
    expect(detectAnomalies(hist([...Array(9).fill(100), 300]))[0].severity).toBe("warn"); // 200%
  });

  test("anomalyPhrase renders a compact arrow + %", () => {
    const a = detectAnomalies(hist([...Array(10).fill(75), 300]))[0];
    expect(anomalyPhrase(a)).toMatch(/^▲ \d+% vs baseline$/);
  });
});
