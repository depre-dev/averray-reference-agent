// ARRIVALS view-model — the wallet-journey shape behind the OUTSIDERS panel.
//
// The visual grammar comes from the Averray design system's operator kit
// (records as KPI cards, instrumentation as a table, counts in mono); this
// module derives the one shape that needs derivation, without crossing the
// lines the registry design drew:
//
//   · pre-identity counters (reached/browsed/evaluated) are CALLS from
//     independent instruments and stay un-charted — a bar chart over them was
//     deliberately removed once, and this module must not resurrect it;
//   · from `identified` onward, rows are distinct SIWE wallets reaching AT
//     LEAST that stage — monotonic by construction, which is what makes a
//     fill drawn behind the count honest;
//   · the two doors carry different windows and different cut-overs, so each
//     door scales to its OWN maximum and nothing ever sums or compares them.

import type { ArrivalOperatorView } from "./product-health.js";

export interface JourneyStageView {
  stage: string;
  /** Distinct wallets reaching at least this stage, this door, its window. */
  count: number;
  /** 0..100 against THIS door's own busiest wallet stage. Zero draws no fill. */
  fillPct: number;
}

export interface DoorJourneyView {
  door: "mcp" | "http";
  label: string;
  sinceMs: number | null;
  window: string;
  /** Empty when the producer reported no wallet-unit rows for this door. */
  stages: JourneyStageView[];
}

/**
 * The wallet half of each door's instrumentation.
 *
 * Only rows whose unit is `agents` qualify — the producer's own declaration of
 * "distinct wallets reaching at least this stage". Rows keep producer order; a
 * nonzero count always gets a visible fill (a 1-wallet stage beside a
 * 164-wallet stage rounds to nothing, and "too small to draw" must not look
 * like "nobody ever got here").
 */
export function doorJourneys(view: ArrivalOperatorView): DoorJourneyView[] {
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
