// Product-health — the monitor board's view of the LIVE product (not the dev
// board). Mirrors the slack-operator GET /monitor/product-health shape. Pure
// types + helpers only; the hook (useProductHealth) and components consume these.
//
// The `probes[]` array + the top-level fields are what the backend emits today.
// The `solvency` / `flow` / `history` blocks are OPTIONAL and forward-compat: the
// Ops surface renders honest "awaiting data" placeholders until the backend PR
// starts emitting them, so nothing is ever fake-green.

export type ProbeStatus = "ok" | "degraded" | "red";
export type ProductHealthStatus = "healthy" | "degraded" | "red" | "unknown";

export interface ProductHealthProbe {
  name: string;
  status: ProbeStatus;
  detail: string;
  /** Per-check statuses, oldest → newest (feeds the sparkline). */
  sparkline: ProbeStatus[];
}

// ── structured blocks (all optional → forward-compat awaiting-data) ─────────

/** A liquidity pool row for the Solvency zone. `amount: null` → awaiting data. */
export interface SolvencyPool {
  key: string;
  label: string;
  amount: number | null;
  /** Display unit, e.g. "USDC" | "PAS". */
  unit: string;
  /** Minimum-healthy floor; drives the meter fill + status. Absent → no floor. */
  floor?: number | null;
  status: ProbeStatus;
  /** Shown for context but not floored (e.g. escrow balance). */
  informational?: boolean;
}

export interface SolvencySnapshot {
  pools: SolvencyPool[];
  /** Honest runway note, e.g. "≈ 6 payouts to floor" or "pending settlement data". */
  runwayNote?: string | null;
}

/** Money-path funnel counts. Any `null` → that step awaits data. */
export interface MoneyPathSnapshot {
  claimed?: number | null;
  submitted?: number | null;
  settled24h?: number | null;
  stuck?: number | null;
  failed24h?: number | null;
  /** Epoch ms of the settlement snapshot. */
  asOf?: number | null;
}

export interface OpsIncident {
  id: string;
  /** Probe name that owns the episode. */
  probe: string;
  severity: "degraded" | "red";
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; null/undefined → ongoing. */
  endedAt?: number | null;
  note?: string;
}

/**
 * Rolling history from the server-side store (backend PR). Absent → the Trends
 * and Incidents zones render their honest "history accruing" placeholders.
 */
export interface HealthHistory {
  /** 0..100 over the trailing 24h, or null if under 24h of data. */
  uptimePct24h?: number | null;
  /** Per-check overall status, oldest → newest. */
  uptimeSeries?: ProbeStatus[];
  /** Per-check API latency ms (null = missing sample), oldest → newest. */
  latencySeriesMs?: (number | null)[];
  /** Signer USDC balance over time (null = missing), oldest → newest. */
  balanceSeries?: (number | null)[];
  incidents?: OpsIncident[];
}

export type OpsNetwork = "testnet" | "mainnet" | "unknown";

export interface ProductHealth {
  /** false = the heartbeat routine is off (honest "monitoring off", not a green). */
  enabled: boolean;
  /** Epoch ms of the last check, or null if none yet. */
  at: number | null;
  status: ProductHealthStatus;
  checks: number;
  probes: ProductHealthProbe[];
  // ── optional structured blocks (forward-compat) ──
  chainId?: number | null;
  network?: OpsNetwork;
  solvency?: SolvencySnapshot;
  flow?: MoneyPathSnapshot;
  history?: HealthHistory;
}

const PROBE_LABELS: Record<string, string> = {
  product_api: "Product API",
  api_latency: "API latency",
  chain_height: "Chain height",
  capabilities: "Capabilities",
  signer_liquidity: "Signer liquidity",
  treasury_liquidity: "Treasury",
  money_path: "Money path",
};

export function probeLabel(name: string): string {
  return PROBE_LABELS[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Map a probe status onto the board's --hm-state-* token family. */
export function probeTone(status: ProbeStatus): "pass" | "degraded" | "fail" {
  return status === "ok" ? "pass" : status === "red" ? "fail" : "degraded";
}

// ── Ops pillars — the four operational domains the probe grid groups by ──────

export type OpsPillar = "availability" | "chain" | "solvency" | "flow";
export const OPS_PILLARS: readonly OpsPillar[] = ["availability", "chain", "solvency", "flow"];
export const OPS_PILLAR_LABELS: Record<OpsPillar, string> = {
  availability: "Availability",
  chain: "Chain",
  solvency: "Solvency",
  flow: "Flow",
};

const PROBE_PILLAR: Record<string, OpsPillar> = {
  product_api: "availability",
  api_latency: "availability",
  chain_height: "chain",
  capabilities: "chain",
  signer_liquidity: "solvency",
  treasury_liquidity: "solvency",
  money_path: "flow",
};

/** Which operational pillar a probe belongs to (unknown probes → availability). */
export function probePillar(name: string): OpsPillar {
  return PROBE_PILLAR[name] ?? "availability";
}

/**
 * A NEWLY-red probe versus the previous poll — drives the surface auto-flip so a
 * fresh incident surfaces itself. Pure: a probe already red last time doesn't
 * re-trigger; only a probe that just crossed into red does.
 */
export function hasFreshRed(prev: ProductHealth | undefined, next: ProductHealth): boolean {
  if (next.status !== "red") return false;
  const prevRed = new Set((prev?.probes ?? []).filter((p) => p.status === "red").map((p) => p.name));
  return next.probes.some((p) => p.status === "red" && !prevRed.has(p.name));
}

export type OverallTone = "healthy" | "degraded" | "red" | "off" | "idle";

/** The Ops surface headline. Truth-boundary aware: off vs no-data-yet vs real state. */
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
