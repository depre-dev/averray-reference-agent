// Leading-indicator anomaly detection — baseline-relative flags over the Trends
// series. Instead of a fixed floor, each metric is judged against its OWN recent
// baseline: median + MAD → a robust z-score, so a spike (latency) or a drain
// (balance) shows up BEFORE it trips a fixed threshold.
//
// Honest by construction: too few samples reads as no-signal (never a flag); a
// flat baseline gets a min-spread floor so ordinary jitter doesn't flag; a
// deviation only counts in the metric's BAD direction (latency up / balance
// down); and it must clear both a robust-z and a minimum-% bar. Pure — no time,
// no DOM — over the history series the payload already carries.

import type { HealthHistory } from "./product-health.js";

export type AnomalyMetric = "latency" | "balance";
export type AnomalySeverity = "info" | "warn";

export interface MetricAnomaly {
  metric: AnomalyMetric;
  label: string;
  /** "up" = the metric rose, "down" = it fell. Only the metric's bad direction flags. */
  direction: "up" | "down";
  current: number;
  /** Baseline center (median of the prior samples). */
  baseline: number;
  /** Signed % deviation of current vs baseline. */
  deviationPct: number;
  /** Robust (MAD-based) z-score. */
  z: number;
  severity: AnomalySeverity;
}

export interface AnomalyConfig {
  /** Total clean samples needed (incl. the current one) before we judge. */
  minSamples: number;
  /** Spread floor as a fraction of |median| — tames a flat baseline. */
  minRelSpread: number;
  /** |z| ≥ this ⇒ flag (info). */
  infoZ: number;
  /** |z| ≥ this ⇒ warn. */
  warnZ: number;
  /** |deviation%| must ALSO clear this — no trivial flags. */
  minPct: number;
}

const DEFAULTS: AnomalyConfig = { minSamples: 8, minRelSpread: 0.05, infoZ: 3.5, warnZ: 6, minPct: 25 };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Analysis {
  current: number;
  baseline: number;
  deviationPct: number;
  z: number;
  severity: AnomalySeverity;
}

function analyze(
  raw: ReadonlyArray<number | null> | undefined,
  badDir: "up" | "down",
  cfg: AnomalyConfig,
): Analysis | null {
  const clean = (raw ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (clean.length < cfg.minSamples) return null; // insufficient → no signal (never a flag)
  const current = clean[clean.length - 1];
  const baseline = clean.slice(0, clean.length - 1);
  const med = median(baseline);
  const mad = median(baseline.map((v) => Math.abs(v - med)));
  // 1.4826·MAD ≈ σ for normal data; the relative floor stops a flat baseline from
  // turning millisecond jitter into an infinite z.
  const spread = Math.max(1.4826 * mad, cfg.minRelSpread * Math.abs(med), 1e-9);
  const z = (current - med) / spread;
  const badward = badDir === "up" ? z > 0 : z < 0;
  if (!badward) return null;
  const deviationPct = med !== 0 ? ((current - med) / Math.abs(med)) * 100 : 0;
  if (Math.abs(z) < cfg.infoZ || Math.abs(deviationPct) < cfg.minPct) return null;
  return { current, baseline: med, deviationPct, z, severity: Math.abs(z) >= cfg.warnZ ? "warn" : "info" };
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** Baseline-relative anomaly flags for the Trends metrics. Pure. */
export function detectAnomalies(history: HealthHistory | undefined, config?: Partial<AnomalyConfig>): MetricAnomaly[] {
  if (!history) return [];
  const cfg = { ...DEFAULTS, ...config };
  const out: MetricAnomaly[] = [];

  const lat = analyze(history.latencySeriesMs, "up", cfg);
  if (lat) {
    out.push({
      metric: "latency",
      label: "API latency",
      direction: "up",
      current: round(lat.current),
      baseline: round(lat.baseline),
      deviationPct: round(lat.deviationPct),
      z: round(lat.z, 2),
      severity: lat.severity,
    });
  }

  const bal = analyze(history.balanceSeries, "down", cfg);
  if (bal) {
    out.push({
      metric: "balance",
      label: "Signer USDC",
      direction: "down",
      current: round(bal.current, 2),
      baseline: round(bal.baseline, 2),
      deviationPct: round(bal.deviationPct),
      z: round(bal.z, 2),
      severity: bal.severity,
    });
  }

  return out;
}

/** Compact chip phrase for the Trends flag: "▲ 353% vs baseline" / "▼ 30% vs baseline". */
export function anomalyPhrase(a: MetricAnomaly): string {
  const arrow = a.direction === "up" ? "▲" : "▼";
  return `${arrow} ${Math.abs(Math.round(a.deviationPct))}% vs baseline`;
}
