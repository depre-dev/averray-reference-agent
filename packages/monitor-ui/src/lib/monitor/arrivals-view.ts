// ARRIVALS view-model — the derived shapes behind the OUTSIDERS block.
//
// The operator view was four prose lines and two collapsed tables; the shapes
// here give the same facts marks, without crossing the lines the registry
// design drew:
//
//   · pre-identity counters (reached/browsed/evaluated) are CALLS from
//     independent instruments and stay un-charted — a bar chart over them was
//     deliberately removed once, and this module must not resurrect it;
//   · from `identified` onward, rows are distinct SIWE wallets reaching AT
//     LEAST that stage — monotonic by construction, which is what makes a
//     ladder of bars honest;
//   · the two doors carry different windows and different cut-overs, so each
//     door scales to its OWN maximum and nothing ever sums or compares them.
//
// Pure; the clock is always the SNAPSHOT's own (`generatedAtMs`), never the
// wall clock — the same rule the trust panel follows.

import type { ArrivalOperatorView } from "./product-health.js";

export interface LadderStageView {
  stage: string;
  /** Distinct wallets reaching at least this stage, this door, its window. */
  count: number;
  /** 0..100 against THIS door's own busiest wallet stage. Zero draws no bar. */
  fillPct: number;
}

export interface DoorLadderView {
  door: "mcp" | "http";
  label: string;
  sinceMs: number | null;
  window: string;
  /** Empty when the producer reported no wallet-unit rows for this door. */
  stages: LadderStageView[];
}

/**
 * The wallet half of each door's instrumentation, as a ladder.
 *
 * Only rows whose unit is `agents` qualify — the producer's own declaration of
 * "distinct wallets reaching at least this stage". Rows are kept in producer
 * order; a nonzero count always gets a visible bar (a 1-wallet stage beside a
 * 164-wallet stage rounds to nothing, and "too small to draw" must not look
 * like "nobody ever got here").
 */
export function doorLadders(view: ArrivalOperatorView): DoorLadderView[] {
  return (["mcp", "http"] as const).map((door) => {
    const evidence = view.doors[door];
    const wallets = (evidence?.rows ?? []).filter((r) => r.unit === "agents");
    const max = Math.max(1, ...wallets.map((r) => r.outsider));
    return {
      door,
      label: door === "mcp" ? "MCP" : "HTTP",
      sinceMs: evidence?.sinceMs ?? null,
      window: evidence?.window ?? "all-time",
      stages: wallets.map((r) => ({
        stage: r.stage,
        count: r.outsider,
        fillPct: r.outsider === 0 ? 0 : Math.max(5, Math.round((r.outsider / max) * 100)),
      })),
    };
  });
}

/** Fixed recency rungs — a scale that does not move with the value on it. */
export const RECENCY_BANDS = [
  { key: "1h", label: "<1h", maxMs: 3_600_000 },
  { key: "24h", label: "<24h", maxMs: 86_400_000 },
  { key: "7d", label: "<7d", maxMs: 604_800_000 },
  { key: "older", label: "older", maxMs: Number.POSITIVE_INFINITY },
] as const;

export type RecencyBandKey = (typeof RECENCY_BANDS)[number]["key"];

/**
 * Which band the last outsider activity falls in, against the snapshot clock.
 * `null` when there has never been any — the caller renders the words and no
 * strip, because a strip with no marker still looks like a reading.
 */
export function recencyBand(atMs: number | null | undefined, generatedAtMs: number): RecencyBandKey | null {
  if (atMs == null || !Number.isFinite(atMs)) return null;
  const age = Math.max(0, generatedAtMs - atMs);
  for (const band of RECENCY_BANDS) {
    if (age < band.maxMs) return band.key;
  }
  return "older";
}

export interface WeekPairView {
  identified: { count: number; fillPct: number };
  worked: { count: number; fillPct: number };
}

/**
 * The 7d identified/worked counts on ONE shared scale.
 *
 * Two comparable magnitudes, not a containment: nothing in the payload proves
 * `worked ⊆ identified`, so the bars sit side by side and neither nests in the
 * other. Null when both are zero — the words already say it, and two empty
 * tracks would dress a quiet week as a chart.
 */
export function weekPair(week: { identified: number; worked: number } | undefined): WeekPairView | null {
  if (!week) return null;
  const max = Math.max(week.identified, week.worked);
  if (max <= 0) return null;
  const fill = (n: number) => (n === 0 ? 0 : Math.max(5, Math.round((n / max) * 100)));
  return {
    identified: { count: week.identified, fillPct: fill(week.identified) },
    worked: { count: week.worked, fillPct: fill(week.worked) },
  };
}
