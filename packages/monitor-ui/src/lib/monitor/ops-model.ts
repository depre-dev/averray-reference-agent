// Ops view-model — pure derivation the Ops zones consume. Turns the raw
// ProductHealth payload into grouped probes, funnel steps, solvency meter rows,
// and incident durations. Kept pure (no Date.now, no DOM) so components pass
// `nowMs` and the whole model is deterministic to unit-test.

import type {
  ProductHealthProbe,
  OpsPillar,
  SolvencyPool,
  MoneyPathSnapshot,
  OpsIncident,
  HealthHistory,
  ProbeStatus,
  ProbeReading,
} from "./product-health.js";
import { OPS_PILLARS, OPS_PILLAR_LABELS, probePillar } from "./product-health.js";

/**
 * Ops tone — the four visual states the --h4 board draws: sage `ok`, amber
 * `degraded` (a real degradation), coral `red` (page-worthy), and warm-gray
 * `awaiting` (no data yet — a forward-compat gap, never a fake green *or* a
 * false alarm). This keeps the truth-boundary honest: "not exposed yet" is
 * telemetry-grey, distinct from a genuine amber degradation.
 */
export type OpsTone = "ok" | "degraded" | "red" | "awaiting";

// These two classifiers live in @avg/schemas because the SERVICE needs them
// too — it emits the verdict on /monitor/product-health so an agent reads the
// board's conclusion rather than re-deriving one. They were briefly duplicated
// on both sides (the service carried a comment reading "mirrors the frontend's
// awaiting regex", which is a drift bug waiting to happen). Re-exported here so
// existing frontend imports keep working.
import { isAcknowledgedProbe, isAwaitingProbe, isUnknownReadingProbe } from "@avg/schemas/ops-verdict";
export { isAcknowledgedProbe, isAwaitingProbe, isUnknownReadingProbe };

/** Resolve a probe to its ops tone (awaiting overrides a bare degraded; a probe
 *  with no reading is grey too — telemetry we could not take, not a fault we
 *  observed). `isAwaitingProbe` covers both, and leaves `red` alone. */
export function probeOpsTone(probe: { status: ProbeStatus; detail: string; reading?: ProbeReading }): OpsTone {
  return isAwaitingProbe(probe) ? "awaiting" : probe.status;
}

export interface ProbeGroup {
  pillar: OpsPillar;
  label: string;
  probes: ProductHealthProbe[];
}

/** Group the probe array into the four pillars, preserving probe order within each. */
export function groupProbesByPillar(probes: ProductHealthProbe[]): ProbeGroup[] {
  return OPS_PILLARS.map((pillar) => ({
    pillar,
    label: OPS_PILLAR_LABELS[pillar],
    probes: probes.filter((p) => probePillar(p.name) === pillar),
  })).filter((g) => g.probes.length > 0);
}

export type FunnelTone = ProbeStatus | "neutral";

export interface FunnelStep {
  key: string;
  label: string;
  /** null → awaiting data (renders a dash, not a zero). */
  value: number | null;
  tone: FunnelTone;
}

/**
 * The money-path funnel: claimed → submitted → settled, with stuck / failed as
 * the drop-off tails. Stuck>0 tones amber; failed>0 tones coral — those are the
 * page-worthy tails. Missing counts render as "awaiting", never as 0.
 */
export function funnelSteps(flow: MoneyPathSnapshot | undefined): FunnelStep[] {
  const v = (n: number | null | undefined): number | null => (typeof n === "number" ? n : null);
  const stuck = v(flow?.stuck);
  const failed = v(flow?.failed24h);
  return [
    { key: "claimed", label: "Claimed 24h", value: v(flow?.claimed24h), tone: "neutral" },
    { key: "submitted", label: "Submitted 24h", value: v(flow?.submitted24h), tone: "neutral" },
    { key: "settled", label: "Settled 24h", value: v(flow?.settled24h), tone: "ok" },
    { key: "stuck", label: "Stuck", value: stuck, tone: stuck != null && stuck > 0 ? "degraded" : "neutral" },
    { key: "failed", label: "Failed 24h", value: failed, tone: failed != null && failed > 0 ? "red" : "neutral" },
  ];
}

/** True once any funnel count is present — gates the "awaiting settlement" veil. */
export function hasFlowData(flow: MoneyPathSnapshot | undefined): boolean {
  if (!flow) return false;
  return [
    flow.claimed24h,
    flow.submitted24h,
    flow.claimedNotSubmitted,
    flow.submittedNotSettled,
    flow.settled24h,
    flow.stuck,
    flow.failed24h,
  ].some((n) => typeof n === "number");
}

export interface SolvencyRow extends SolvencyPool {
  /** Meter fill 0..1 vs 3× the floor; null → no meter (awaiting or unfloored). */
  fill: number | null;
  amountLabel: string;
  floorLabel: string | null;
}

/** A pool sits at 1/3 of its meter when exactly at floor, full at 3× floor. */
function meterFill(amount: number | null, floor: number | null | undefined): number | null {
  if (amount == null) return null;
  if (floor == null || floor <= 0) return null;
  return Math.max(0.03, Math.min(1, amount / (floor * 3)));
}

export function solvencyRows(pools: SolvencyPool[]): SolvencyRow[] {
  return pools.map((p) => ({
    ...p,
    fill: meterFill(p.amount, p.floor),
    amountLabel: p.amount == null ? "awaiting data" : `${formatAmount(p.amount)} ${p.unit}`,
    floorLabel: p.floor == null ? null : `floor ${formatAmount(p.floor)}`,
  }));
}

export interface IncidentRow extends OpsIncident {
  ongoing: boolean;
  durationMs: number;
  durationLabel: string;
}

/** Incidents newest-first, with duration computed against `nowMs` for ongoing ones. */
export function incidentRows(history: HealthHistory | undefined, nowMs: number): IncidentRow[] {
  const list = history?.incidents ?? [];
  return [...list]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((inc) => {
      const end = inc.endedAt ?? nowMs;
      const durationMs = Math.max(0, end - inc.startedAt);
      return { ...inc, ongoing: inc.endedAt == null, durationMs, durationLabel: formatDuration(durationMs) };
    });
}

/** Severity order for roll-ups. Shared so every "worst of" on the board ranks
 *  the same way — a pillar head and a panel rail must never disagree. */
export const OPS_TONE_RANK: Record<OpsTone, number> = { red: 3, degraded: 2, awaiting: 1, ok: 0 };

/** The worst tone in a list; an empty list is `ok` (nothing observed wrong). */
export function worstOpsTone(tones: readonly OpsTone[]): OpsTone {
  return tones.reduce<OpsTone>((acc, t) => (OPS_TONE_RANK[t] > OPS_TONE_RANK[acc] ? t : acc), "ok");
}

export interface RecentIncidentsView {
  /** Newest first, capped for a narrow column. */
  rows: IncidentRow[];
  /** Episodes beyond the cap, still inside the durable window. Never hidden silently. */
  more: number;
}

/**
 * The durable log's newest episodes, sized for the INCIDENTS column.
 *
 * `null` means the build reports no incident log AT ALL — absent is not empty,
 * and the column must say "not reported" rather than implying a clean record.
 * An empty array is the opposite fact: the log exists and holds nothing.
 */
export function recentIncidents(
  history: HealthHistory | undefined,
  nowMs: number,
  max = 3,
): RecentIncidentsView | null {
  if (!history?.incidents) return null;
  const rows = incidentRows(history, nowMs);
  return { rows: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}

/**
 * The span qualifier for a history sparkline ("24h" · "over 34m" · "span unknown").
 *
 * The latency trend was captioned "latency 24h" unconditionally, while the ring
 * buffer behind it lives in memory: right after a deploy those samples span
 * minutes, and the caption claimed a day. Uptime already states its measured
 * span (same buffer, same lesson) — this applies the identical ≥95%-of-window
 * rule to the series caption, so both labels degrade together.
 */
export function trendSpanLabel(history: HealthHistory | undefined): string {
  const span = history?.uptimeSpanMs;
  if (typeof span !== "number" || span <= 0) return "span unknown";
  const window = history?.uptimeWindowMs;
  if (typeof window === "number" && window > 0 && span >= window * 0.95) {
    // Covered: label the window itself. Whole hours read as hours ("24h"),
    // anything else falls back to the coarse duration label.
    const hours = window / 3_600_000;
    return hours < 48 && Number.isInteger(hours) ? `${hours}h` : formatDuration(window);
  }
  return `over ${formatDuration(span)}`;
}

/** Compact money/amount label: 4.99k, 1.20M, 2.00. */
export function formatAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(2);
}

/** Relative "checked Ns ago" label from an epoch-ms timestamp. */
export function formatAgo(at: number | null, nowMs: number): string {
  if (at == null) return "—";
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Coarse duration label: 3d 20h, 4h 12m, 7m, 45s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
