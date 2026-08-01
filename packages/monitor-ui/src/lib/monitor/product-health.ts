// Product-health — the monitor board's view of the LIVE product (not the dev
// board). Mirrors the slack-operator GET /monitor/product-health shape. Pure
// types + helpers only; the hook (useProductHealth) and components consume these.
//
// The `probes[]` array + the top-level fields are what the backend emits today.
// The `solvency` / `flow` / `history` blocks are OPTIONAL for compatibility with
// older monitor snapshots. The Ops surface renders honest "awaiting data"
// placeholders whenever a field is absent, so nothing is ever fake-green.

import type { OpsVerdict } from "@avg/schemas/ops-verdict";

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
  /** Display unit, e.g. "USDC" | "PAS" | "DOT" | "native". */
  unit: string;
  /** Minimum-healthy floor; drives the meter fill + status. Absent → no floor. */
  floor?: number | null;
  status: ProbeStatus;
  /** Shown for context but not floored (e.g. escrow balance). */
  informational?: boolean;
  /** Operator-declared context for an intentionally unfloored pool. */
  note?: string;
  /** The address this amount was READ FROM — present only when the figure came
   *  from that address's balance. A pool sourced elsewhere carries none, and the
   *  row shows no address rather than borrowing a plausible one. */
  address?: string;
  /** What the address is, so the hex is legible without a block explorer. */
  addressLabel?: string;
}

/** Can the #Ops channel receive anything? Instrument health, not product health. */
export interface BuzzDeliveryView {
  status: "off" | "armed" | "ok" | "failing";
  detail: string;
  lastOkAt?: number;
  lastFailureAt?: number;
}

export interface SolvencySnapshot {
  pools: SolvencyPool[];
  /** Honest runway note, e.g. "≈ 6 payouts to floor" or "pending settlement data". */
  runwayNote?: string | null;
  /** Per-pool time-to-floor projection — drives the pre-floor ops suggestion. */
  runway?: RunwayPool[];
}

/** A floored pool's projected liquidity runway (mirrors the backend). */
export interface RunwayPool {
  key: string;
  label: string;
  unit: string;
  current: number;
  floor: number;
  /** Depletion rate in units/hour; null = flat / refilling / not estimable. */
  burnPerHour: number | null;
  /** Hours until the balance hits the floor; null = stable/awaiting; 0 = at floor. */
  hoursToFloor: number | null;
  estimable: boolean;
  status: ProbeStatus;
}

/** Money-path funnel counts. Any `null` → that step awaits data. */
export interface MoneyPathSnapshot {
  claimed24h?: number | null;
  submitted24h?: number | null;
  /** Current claims whose worker has not submitted yet; informational only. */
  claimedNotSubmitted?: number | null;
  /** Current submissions not yet settled; sustained nonzero is a backlog. */
  submittedNotSettled?: number | null;
  settled24h?: number | null;
  stuck?: number | null;
  failed24h?: number | null;
  /** Epoch ms of the settlement snapshot. */
  asOf?: number | null;
  /** Independent on-chain proof that the settled jobs actually PAID. */
  payout?: PayoutEvidence;
}

/**
 * Evidence that rewards were actually PAID, not merely marked settled.
 *
 * The funnel counts above are job-state rows from the product's own database —
 * "9 rows say settled". That is not proof any money moved. `payout` counts
 * `ReservationSettled` logs straight off the chain, so the two numbers come
 * from independent sources and THE DISCREPANCY IS THE SIGNAL. The board renders
 * them side by side and shows the contradiction rather than averaging it away.
 *
 * The three statuses are NOT a severity ramp, and the UI must never draw them
 * as one:
 *   confirmed  — proof matches the ledger;
 *   shortfall  — we can see the chain and it is short. MONEY is broken;
 *   unverified — we cannot see the chain at all. The INSTRUMENT is broken.
 * `unverified` is warm grey, never coral: paging on a blind instrument is the
 * false red that teaches an operator to ignore the real one.
 */
export interface PayoutEvidence {
  status: "confirmed" | "shortfall" | "unverified";
  detail: string;
  /** Settlement logs observed on-chain in the window; null = unverified. */
  confirmedCount: number | null;
  /** Summed USDC actually transferred; null = unverified. */
  confirmedUsdc: number | null;
  /** The product's own settled count, for the comparison. */
  settledCount: number | null;
  /** Blocks scanned. The window is approximate — the verdict allows for it. */
  windowBlocks: number | null;
  /** Does the block window actually span the period being compared? */
  window?: WindowFit;
}

/**
 * Whether the configured block lookback really covers the period it is compared
 * to — checked against MEASURED block time, not an assumed one. The assumption
 * was wrong in production: a lookback sized "24h at 6s/block" on a ~2.11s chain
 * spanned 8h26m and made a fully-paying system look like it had 12 unaccounted
 * payouts. A `suspect` window suppresses a shortfall verdict for that reason.
 */
export interface WindowFit {
  status: "ok" | "suspect" | "unknown";
  detail: string;
  /** Measured seconds per block; null when the chain could not be sampled. */
  blockSeconds: number | null;
  /** Hours the configured lookback actually spans at that rate. */
  spanHours: number | null;
}

/**
 * The monitor's own version — is the board you are reading built from current
 * code? Degraded-safe by construction: any failure resolves to `unknown`, which
 * must never render as up to date.
 */
export interface SelfFreshness {
  status: "current" | "behind" | "unknown";
  detail: string;
  /** The sha actually running, when it was baked into the image. */
  runningSha: string | null;
  /** Commits on main this build does not contain; null when unknown. */
  behindBy: number | null;
  /** When the OLDEST unshipped commit landed — how long we have been stale. */
  oldestUnshippedAt: string | null;
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
  /** 0..100 over the trailing window. Read `uptimeSpanMs` before labelling it:
   *  the percentage does NOT imply the window is covered, and calling it "24h"
   *  when one check backs it is a claim about a span we never observed. */
  uptimePct24h?: number | null;
  /** Determinate samples behind the percentage. */
  uptimeSamples?: number | null;
  /** Elapsed time those samples actually span; null/absent = coverage unknown. */
  uptimeSpanMs?: number | null;
  /** The window the percentage claims to cover, for comparison against the span. */
  uptimeWindowMs?: number | null;
  /** Per-check overall status, oldest → newest. */
  uptimeSeries?: ProbeStatus[];
  /** Epoch ms per sample, same index/length as the series. Absent → a series
   *  point cannot be labelled with a time, and must not be given one. */
  seriesAt?: number[];
  /** Per-check API latency ms (null = missing sample), oldest → newest. */
  latencySeriesMs?: (number | null)[];
  /** Reward bank balance over time (null = missing), oldest → newest. */
  balanceSeries?: (number | null)[];
  incidents?: OpsIncident[];
}

export type OpsNetwork = "testnet" | "mainnet" | "unknown";

/** Structured reading behind the chain_height probe (mirrors the backend's
 *  ChainTickData) — drives the TopStrip block ticker. Absent → awaiting-data. */
export interface ChainTick {
  /** Block height as reported by the product's /health at the last check. */
  height: number;
  /** Epoch ms when that height was observed (server clock). */
  observedAtMs: number;
  /** Age (s) of the latest block at observation; null = not measurable. */
  blockAgeSec?: number | null;
  /** Epoch ms when the height was last seen to advance (tracker fallback). */
  lastAdvanceAtMs?: number | null;
  /** Producer's freshness window (s) — the ticker's stale threshold. */
  freshSeconds?: number;
}

export interface ProductHealth {
  /** false = the heartbeat routine is off (honest "monitoring off", not a green). */
  enabled: boolean;
  /** Epoch ms of the last check, or null if none yet. */
  at: number | null;
  status: ProductHealthStatus;
  checks: number;
  /** How often the heartbeat is expected to update this payload. Absent on
   *  older snapshots — readers must fall back, never assume a value. */
  checkIntervalMs?: number | null;
  probes: ProductHealthProbe[];
  // ── optional structured blocks (forward-compat) ──
  chainId?: number | null;
  network?: OpsNetwork;
  chain?: ChainTick;
  solvency?: SolvencySnapshot;
  flow?: MoneyPathSnapshot;
  history?: HealthHistory;
  remediation?: RemediationStatus;
  /** #Ops delivery health — see BuzzDeliveryView. */
  buzz?: BuzzDeliveryView;
  /** The monitor's own build vs main — "is this board current?". */
  self?: SelfFreshness;
  /**
   * The server's copy of the operator verdict (`deriveOpsVerdict`, @avg/schemas).
   *
   * The board does NOT read this — it calls the same shared function itself,
   * because it layers reader-side staleness on top ("last known state" when
   * this browser's stream is down), which a server cannot know. Same function,
   * same inputs, same answer.
   *
   * The field exists for readers that are not the board — chiefly an agent
   * polling this endpoint, which must consume the board's conclusion rather
   * than forming a competing one. Declared here so it is visible in the payload
   * contract rather than being an undocumented extra key.
   */
  verdict?: OpsVerdict;
}

/** RPC auto-remediation status — drives the Ops "RPC failover" row. */
export interface RemediationStatus {
  /** off = disabled · armed = on primary, healthy · failover = reading a backup ·
   *  halted = breaker tripped, needs an operator. */
  state: "off" | "armed" | "failover" | "halted";
  enabled: boolean;
  activeEndpoint: string | null;
  onBackup: boolean;
  detail: string;
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
