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

const AWAITING_RE = /awaiting|not exposed|not configured|unconfigured|no data/i;

/** A probe whose degraded status is really "upstream data not wired yet". */
export function isAwaitingProbe(probe: { status: ProbeStatus; detail: string }): boolean {
  return probe.status !== "red" && AWAITING_RE.test(probe.detail);
}

/** Resolve a probe to its ops tone (awaiting overrides a bare degraded). */
export function probeOpsTone(probe: { status: ProbeStatus; detail: string }): OpsTone {
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
    { key: "claimed", label: "Claimed", value: v(flow?.claimed), tone: "neutral" },
    { key: "submitted", label: "Submitted", value: v(flow?.submitted), tone: "neutral" },
    { key: "settled", label: "Settled 24h", value: v(flow?.settled24h), tone: "ok" },
    { key: "stuck", label: "Stuck", value: stuck, tone: stuck != null && stuck > 0 ? "degraded" : "neutral" },
    { key: "failed", label: "Failed 24h", value: failed, tone: failed != null && failed > 0 ? "red" : "neutral" },
  ];
}

/** True once any funnel count is present — gates the "awaiting settlement" veil. */
export function hasFlowData(flow: MoneyPathSnapshot | undefined): boolean {
  if (!flow) return false;
  return [flow.claimed, flow.submitted, flow.settled24h, flow.stuck, flow.failed24h].some(
    (n) => typeof n === "number",
  );
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

/** Compact money/amount label: 4.99k, 1.20M, 2.00. */
export function formatAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(2);
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
