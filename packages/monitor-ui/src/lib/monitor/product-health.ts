// Product-health — the monitor board's view of the LIVE product (not the dev
// board). Mirrors the slack-operator GET /monitor/product-health shape. Pure
// types + helpers only; the hook (useProductHealth) and components consume these.

export type ProbeStatus = "ok" | "degraded" | "red";
export type ProductHealthStatus = "healthy" | "degraded" | "red" | "unknown";

export interface ProductHealthProbe {
  name: string;
  status: ProbeStatus;
  detail: string;
  /** Per-check statuses, oldest → newest (feeds the sparkline). */
  sparkline: ProbeStatus[];
}

export interface ProductHealth {
  /** false = the heartbeat routine is off (honest "monitoring off", not a green). */
  enabled: boolean;
  /** Epoch ms of the last check, or null if none yet. */
  at: number | null;
  status: ProductHealthStatus;
  checks: number;
  probes: ProductHealthProbe[];
}

const PROBE_LABELS: Record<string, string> = {
  product_api: "Product API",
  chain_height: "Chain height",
  signer_liquidity: "Signer liquidity",
};

export function probeLabel(name: string): string {
  return PROBE_LABELS[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Map a probe status onto the board's --hm-state-* token family. */
export function probeTone(status: ProbeStatus): "pass" | "degraded" | "fail" {
  return status === "ok" ? "pass" : status === "red" ? "fail" : "degraded";
}

/**
 * A NEWLY-red probe versus the previous poll — drives the lane auto-flip so a
 * fresh incident surfaces itself. Pure: a probe already red last time doesn't
 * re-trigger; only a probe that just crossed into red does.
 */
export function hasFreshRed(prev: ProductHealth | undefined, next: ProductHealth): boolean {
  if (next.status !== "red") return false;
  const prevRed = new Set((prev?.probes ?? []).filter((p) => p.status === "red").map((p) => p.name));
  return next.probes.some((p) => p.status === "red" && !prevRed.has(p.name));
}

export type OverallTone = "healthy" | "degraded" | "red" | "off" | "idle";

/** The Monitoring lane's headline. Truth-boundary aware: off vs no-data-yet vs real state. */
export function overallSummary(h: ProductHealth): { label: string; tone: OverallTone } {
  if (!h.enabled) return { label: "monitoring off", tone: "off" };
  if (h.checks === 0) return { label: "awaiting first check", tone: "idle" };
  if (h.status === "red") {
    const n = h.probes.filter((p) => p.status === "red").length;
    return { label: `${n} probe${n === 1 ? "" : "s"} red`, tone: "red" };
  }
  if (h.status === "degraded") return { label: "degraded · safe", tone: "degraded" };
  return { label: "all healthy", tone: "healthy" };
}

/** Overall tone → the --hm-state-* family (pass/degraded/fail) or a muted neutral. */
export function overallToneClass(tone: OverallTone): "pass" | "degraded" | "fail" | "muted" {
  if (tone === "healthy") return "pass";
  if (tone === "red") return "fail";
  if (tone === "degraded") return "degraded";
  return "muted";
}
