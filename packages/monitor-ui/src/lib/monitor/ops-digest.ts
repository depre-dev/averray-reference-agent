// Ops digest summary — a compact one-line view of product health for the
// co-pilot rail's Digest, so ops status is glanceable from the Delivery view
// (the rail is mounted in both surfaces). Pure: health snapshot → {tone, label,
// detail}. Truth-boundary preserved: off / awaiting states are honest, and an
// awaiting-data probe is never surfaced as the "lead incident" (it's telemetry,
// not a degradation).

import type { ProductHealth, ProductHealthProbe } from "./product-health.js";
import { overallSummary, overallToneClass } from "./product-health.js";
import { isAwaitingProbe } from "./ops-model.js";

export interface OpsDigestSummary {
  /** Maps to the board's --hm-state-* family: pass / degraded / fail / muted. */
  toneClass: "pass" | "degraded" | "fail" | "muted";
  /** Short headline, e.g. "degraded · safe", "all healthy", "2 probes red". */
  label: string;
  /** The lead incident probe's compact detail, or "" when nominal/off. */
  detail: string;
}

/** The worst REAL probe (red beats a genuine degradation; awaiting is skipped). */
function leadIncidentProbe(probes: readonly ProductHealthProbe[]): ProductHealthProbe | undefined {
  return (
    probes.find((p) => p.status === "red") ??
    probes.find((p) => p.status === "degraded" && !isAwaitingProbe(p))
  );
}

function compact(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > 64 ? `${trimmed.slice(0, 61)}…` : trimmed;
}

export function opsDigestSummary(health: ProductHealth | undefined): OpsDigestSummary {
  if (!health) return { toneClass: "muted", label: "awaiting", detail: "" };
  const overall = overallSummary(health);
  const toneClass = overallToneClass(overall.tone);
  // Only show a detail line when there's a real incident to point at — a healthy
  // or off board keeps the line clean.
  const lead = overall.tone === "red" || overall.tone === "degraded" ? leadIncidentProbe(health.probes) : undefined;
  return { toneClass, label: overall.label, detail: lead ? compact(lead.detail) : "" };
}
