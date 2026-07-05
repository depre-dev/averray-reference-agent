// Product-health heartbeat — the first "watch the live PRODUCT, not the dev board" probe.
//
// A SERVER-SIDE routine (no tab open) that probes the LIVE product — is the
// Averray API up, is the chain advancing, is the signer solvent — and, on a RED
// probe, fires the SAME off-device alert bridge (D4) the dev board uses. It
// reuses the D3/D4 plane: pure `evaluateProductHealth` + effect-injected
// `runProductHealthOnce`, so detection + alerting unit-test with no fs/network.
//
// Two data sources, deliberately:
//  • API + chain height come from the product's OWN `GET /health` payload — the
//    product self-reports block height + blockchain capability + signer status
//    there, so the monitor always watches the EXACT chain the product runs on
//    (it reads `auth.chainId`), with no separate endpoint that can drift to the
//    wrong network. A frozen chain still reports its last block, so a block-advance
//    tracker turns a static height into a halt signal.
//  • Signer BALANCES come from a direct eth-RPC (eth_getBalance + erc20 balanceOf)
//    — `/health` does not expose balances, so this is the only source of real
//    solvency monitoring. Raw JSON-RPC over the injected `fetch` (no viem dep).
//
// TRUTH-BOUNDARY (the whole point): an UNCONFIGURED or unreadable probe reports
// `degraded`, never a fake green; a probe the product self-reports as failing (or a
// balance below its floor) reports `red`. Only `red` fires an alert. A dependency
// hiccup (our RPC, the /health fetch) → `degraded`, never a product-down page. A
// chain HALT is network-conditional: a testnet freeze is `degraded` (no page — a
// known reset happens), a mainnet halt is `red` (settlement down = page).

import type { AlertPayload } from "./alert-bridge.js";

// ── Probe result model ──────────────────────────────────────────────

export type ProbeStatus = "ok" | "degraded" | "red";

export interface ProbeResult {
  /** Stable probe id, e.g. "product_api" | "chain_height" | "signer_liquidity". */
  name: string;
  status: ProbeStatus;
  detail: string;
}

export type ProductHealthStatus = "healthy" | "degraded" | "red";

export interface ProductHealthEvaluation {
  status: ProductHealthStatus;
  probes: ProbeResult[];
  /** The red probes (drive the alert). */
  redProbes: ProbeResult[];
}

/** Pure: overall = worst probe. red > degraded > ok. Only red drives an alert. */
export function evaluateProductHealth(probes: ProbeResult[]): ProductHealthEvaluation {
  const redProbes = probes.filter((p) => p.status === "red");
  const status: ProductHealthStatus =
    redProbes.length > 0 ? "red" : probes.some((p) => p.status === "degraded") ? "degraded" : "healthy";
  return { status, probes, redProbes };
}

/** Stable key for the current red set (order-independent) — used for alert de-dup. */
export function redProbeKey(evaluation: ProductHealthEvaluation): string {
  return evaluation.redProbes.map((p) => p.name).sort().join(",");
}

// ── Rolling history (feeds the board's per-probe uptime sparkline) ──

export interface ProductHealthSnapshot {
  /** Epoch ms of the check. */
  at: number;
  status: ProductHealthStatus;
  probes: ProbeResult[];
  /** GET /health round-trip latency (ms) for this check — Trends latency series. */
  latencyMs?: number | null;
  /** Signer USDC balance at this check — Trends balance series + USDC runway. */
  signerUsdc?: number | null;
  /** Signer native-gas balance at this check — gas runway (matters on mainnet). */
  signerGas?: number | null;
}

/** Append a snapshot to a bounded rolling history (oldest→newest). Pure. */
export function appendHistory(
  history: ReadonlyArray<ProductHealthSnapshot>,
  snapshot: ProductHealthSnapshot,
  maxLen: number,
): ProductHealthSnapshot[] {
  const next = [...history, snapshot];
  return maxLen > 0 && next.length > maxLen ? next.slice(next.length - maxLen) : next;
}

/** The last `bins` statuses for one probe (oldest→newest), for a sparkline. Pure. */
export function probeSparkline(
  history: ReadonlyArray<ProductHealthSnapshot>,
  probeName: string,
  bins: number,
): ProbeStatus[] {
  const series: ProbeStatus[] = [];
  for (const snap of history) {
    const hit = snap.probes.find((p) => p.name === probeName);
    if (hit) series.push(hit.status);
  }
  return bins > 0 && series.length > bins ? series.slice(series.length - bins) : series;
}

// ── History-derived Ops blocks (Trends + Incidents) ──

/** Mirrors the frontend's awaiting regex (ops-model `AWAITING_RE`): a degraded
 *  probe whose detail is really "upstream data not wired yet". Excluded from
 *  incidents so a forward-compat gap never masquerades as a live degradation. */
const AWAITING_DETAIL_RE = /awaiting|not expose|not wired|not configured|unconfigured|no data/i;

function isAwaitingDetail(status: ProbeStatus, detail: string): boolean {
  return status !== "red" && AWAITING_DETAIL_RE.test(detail);
}

export interface ProductHealthIncident {
  id: string;
  probe: string;
  severity: "degraded" | "red";
  /** Epoch ms of the first check in the run. */
  startedAt: number;
  /** Epoch ms of recovery; null → still ongoing. */
  endedAt?: number | null;
  /** The probe's detail at the tail of the run — the incident description. */
  note?: string;
}

export interface ProductHealthHistoryBlock {
  /** Share of trailing-24h checks that were NOT red, 0..100; null under-window. */
  uptimePct24h: number | null;
  /** Per-check overall tone (oldest→newest), bounded to `maxSeries`. */
  uptimeSeries: ProbeStatus[];
  latencySeriesMs: (number | null)[];
  balanceSeries: (number | null)[];
  incidents: ProductHealthIncident[];
}

/** Overall check status → probe tone for the uptime sparkline. */
function overallTone(status: ProductHealthStatus): ProbeStatus {
  return status === "healthy" ? "ok" : status;
}

/**
 * Derive the Ops Trends + Incidents block from the rolling history. Pure — the
 * caller passes `nowMs`. The series are newest-anchored to `maxSeries` bins; the
 * uptime% is over the trailing `uptimeWindowMs` and counts "not red" as up (a
 * degraded product still serves; only red is a page-worthy outage).
 */
export function deriveProductHealthHistory(
  history: ReadonlyArray<ProductHealthSnapshot>,
  nowMs: number,
  opts: { maxSeries?: number; uptimeWindowMs?: number } = {},
): ProductHealthHistoryBlock {
  const maxSeries = opts.maxSeries ?? 48;
  const uptimeWindowMs = opts.uptimeWindowMs ?? 24 * 60 * 60 * 1000;
  const series =
    maxSeries > 0 && history.length > maxSeries ? history.slice(history.length - maxSeries) : history;

  const windowStart = nowMs - uptimeWindowMs;
  const inWindow = history.filter((s) => s.at >= windowStart);
  const uptimePct24h =
    inWindow.length > 0
      ? Math.round((inWindow.filter((s) => s.status !== "red").length / inWindow.length) * 1000) / 10
      : null;

  return {
    uptimePct24h,
    uptimeSeries: series.map((s) => overallTone(s.status)),
    latencySeriesMs: series.map((s) => s.latencyMs ?? null),
    balanceSeries: series.map((s) => s.signerUsdc ?? null),
    incidents: deriveIncidents(history),
  };
}

/** Contiguous degraded/red runs per probe → incident episodes (newest-first,
 *  capped). Awaiting-data degradations are excluded — a forward-compat gap is
 *  not an incident. An unrecovered run stays open (`endedAt: null`). */
function deriveIncidents(history: ReadonlyArray<ProductHealthSnapshot>): ProductHealthIncident[] {
  const names: string[] = [];
  for (const snap of history) {
    for (const p of snap.probes) if (!names.includes(p.name)) names.push(p.name);
  }
  const incidents: ProductHealthIncident[] = [];
  for (const name of names) {
    let startedAt: number | null = null;
    let severity: "degraded" | "red" = "degraded";
    let note = "";
    for (const snap of history) {
      const probe = snap.probes.find((p) => p.name === name);
      const bad =
        !!probe &&
        (probe.status === "red" ||
          (probe.status === "degraded" && !isAwaitingDetail(probe.status, probe.detail)));
      if (bad) {
        if (startedAt === null) {
          startedAt = snap.at;
          severity = "degraded";
        }
        if (probe!.status === "red") severity = "red";
        note = probe!.detail;
      } else if (startedAt !== null) {
        incidents.push({ id: `${name}-${startedAt}`, probe: name, severity, startedAt, endedAt: snap.at, note });
        startedAt = null;
      }
    }
    if (startedAt !== null) {
      incidents.push({ id: `${name}-${startedAt}`, probe: name, severity, startedAt, endedAt: null, note });
    }
  }
  return incidents.sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);
}

// ── Liquidity runway (projects time-to-floor from the balance series) ──

/** Per-pool balance accessor into a history entry — only the live signer pools
 *  carry a stored series; treasury pools are forward-compat (no series yet). */
const RUNWAY_SERIES: Record<string, (s: ProductHealthSnapshot) => number | null | undefined> = {
  signer_gas: (s) => s.signerGas,
  signer_usdc: (s) => s.signerUsdc,
};

export interface LiquidityRunwayPool {
  key: string;
  label: string;
  unit: string;
  current: number;
  floor: number;
  /** Depletion rate in units/hour; null = flat, refilling, or not estimable. */
  burnPerHour: number | null;
  /** Projected hours until the balance hits the floor; null = stable / refilling
   *  / awaiting samples; 0 = already at or below the floor. */
  hoursToFloor: number | null;
  /** Did we have enough data to project? false = awaiting samples (not "stable"). */
  estimable: boolean;
  status: ProbeStatus;
}

export interface LiquidityRunway {
  pools: LiquidityRunwayPool[];
  /** Honest one-line summary of the nearest pool — feeds SolvencySnapshot.runwayNote. */
  note: string | null;
}

export interface LiquidityRunwayOptions {
  /** Trailing window the burn rate is fit over (default 6h). */
  windowMs?: number;
  /** Minimum non-null samples needed to project (default 3). */
  minSamples?: number;
  /** Minimum elapsed span across those samples (default 15m) — rejects a burst. */
  minSpanMs?: number;
  /** A projection beyond this is treated as "stable" — rejects noise (default 240h). */
  stableCapHours?: number;
  /** hoursToFloor ≤ this ⇒ degraded (default 24h). */
  warnHours?: number;
  /** hoursToFloor ≤ this ⇒ red (default 6h). */
  redHours?: number;
}

/** Least-squares slope of value-vs-time (units per ms); null if undetermined. */
function seriesSlopePerMs(samples: ReadonlyArray<{ t: number; v: number }>): number | null {
  const n = samples.length;
  if (n < 2) return null;
  let sumT = 0;
  let sumV = 0;
  for (const s of samples) {
    sumT += s.t;
    sumV += s.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dt = s.t - meanT;
    num += dt * (s.v - meanV);
    den += dt * dt;
  }
  return den === 0 ? null : num / den;
}

function formatRunwayHours(hours: number): string {
  if (hours <= 0) return "at floor";
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))}m to floor`;
  if (hours < 48) return `~${Math.round(hours)}h to floor`;
  return `~${Math.round(hours / 24)}d to floor`;
}

/**
 * Project liquidity runway for each floored signer pool from its balance series.
 * Pure — the caller passes `nowMs`. Honest by construction: too few samples / too
 * short a span read as "awaiting"; a flat or refilling trend, or a projection past
 * `stableCapHours`, reads as "stable" — never a fabricated countdown off sensor
 * noise. Only floored, live signer pools (with a stored series) get a runway;
 * informational + forward-compat treasury pools are skipped.
 */
export function deriveLiquidityRunway(
  history: ReadonlyArray<ProductHealthSnapshot>,
  pools: ReadonlyArray<SolvencyPoolData>,
  nowMs: number,
  opts: LiquidityRunwayOptions = {},
): LiquidityRunway {
  const windowMs = opts.windowMs ?? 6 * 60 * 60 * 1000;
  const minSamples = opts.minSamples ?? 3;
  const minSpanMs = opts.minSpanMs ?? 15 * 60 * 1000;
  const stableCapHours = opts.stableCapHours ?? 240;
  const warnHours = opts.warnHours ?? 24;
  const redHours = opts.redHours ?? 6;
  const windowStart = nowMs - windowMs;

  const out: LiquidityRunwayPool[] = [];
  for (const pool of pools) {
    const accessor = RUNWAY_SERIES[pool.key];
    if (!accessor || pool.informational || pool.amount == null || pool.floor == null || pool.floor <= 0) {
      continue;
    }
    const current = pool.amount;
    const floor = pool.floor;
    const mk = (
      extra: Pick<LiquidityRunwayPool, "burnPerHour" | "hoursToFloor" | "estimable" | "status">,
    ): LiquidityRunwayPool => ({ key: pool.key, label: pool.label, unit: pool.unit, current, floor, ...extra });

    // Already at/below floor — the balance probe owns the red; runway is 0.
    if (current <= floor) {
      out.push(mk({ burnPerHour: null, hoursToFloor: 0, estimable: true, status: "red" }));
      continue;
    }
    const samples: { t: number; v: number }[] = [];
    for (const snap of history) {
      if (snap.at < windowStart) continue;
      const v = accessor(snap);
      if (typeof v === "number" && Number.isFinite(v)) samples.push({ t: snap.at, v });
    }
    const spanMs = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
    if (samples.length < minSamples || spanMs < minSpanMs) {
      out.push(mk({ burnPerHour: null, hoursToFloor: null, estimable: false, status: "ok" }));
      continue;
    }
    const slope = seriesSlopePerMs(samples);
    const burnPerHour = slope == null ? null : -slope * 3_600_000; // +ve = depleting
    if (burnPerHour == null || burnPerHour <= 0) {
      out.push(mk({ burnPerHour, hoursToFloor: null, estimable: true, status: "ok" })); // stable / refilling
      continue;
    }
    const hoursToFloor = (current - floor) / burnPerHour;
    if (hoursToFloor > stableCapHours) {
      out.push(mk({ burnPerHour, hoursToFloor: null, estimable: true, status: "ok" })); // effectively stable
      continue;
    }
    const status: ProbeStatus = hoursToFloor <= redHours ? "red" : hoursToFloor <= warnHours ? "degraded" : "ok";
    out.push(mk({ burnPerHour, hoursToFloor, estimable: true, status }));
  }

  return { pools: out, note: summariseRunway(out) };
}

/** The honest one-liner: the nearest depleting pool, else stable, else awaiting. */
function summariseRunway(pools: ReadonlyArray<LiquidityRunwayPool>): string | null {
  const trending = pools
    .filter((p) => p.hoursToFloor != null)
    .sort((a, b) => (a.hoursToFloor as number) - (b.hoursToFloor as number));
  if (trending.length) {
    const p = trending[0];
    return `${p.label} ${formatRunwayHours(p.hoursToFloor as number)}`;
  }
  // Enough data but no downward trend → a real, honest "stable". No estimable
  // pool at all → null (awaiting) so the board shows its awaiting-data line.
  return pools.some((p) => p.estimable) ? "stable — no depletion trend" : null;
}

// ── Pre-floor runway alert (edge-triggered; mirrors decideProductHealthAlert) ──

export interface RunwayAlertState {
  /** The danger-set key at the previous alert ("" when last clear). */
  lastDangerKey: string;
  lastAlertAtMs: number;
}

export function initialRunwayAlertState(): RunwayAlertState {
  return { lastDangerKey: "", lastAlertAtMs: 0 };
}

/** The danger set: floored pools projected into the warn/page band, keyed by
 *  pool:status so a worsening (degraded→red) counts as a new edge. Empty = safe. */
function runwayDangerKey(runway: LiquidityRunway): string {
  return runway.pools
    .filter((p) => p.status === "red" || p.status === "degraded")
    .map((p) => `${p.key}:${p.status}`)
    .sort()
    .join(",");
}

/**
 * Fire a pre-floor alert on the rising edge into the danger band (or a worsening
 * within it), then re-fire only after the cooldown while it persists — so the
 * operator hears about a projected floor BEFORE it halts settlement, without a
 * page every poll. Clears (no alert) once every pool is out of the band.
 */
export function decideRunwayAlert(input: {
  runway: LiquidityRunway;
  state: RunwayAlertState;
  nowMs: number;
  cooldownMs: number;
}): { alert: boolean; state: RunwayAlertState } {
  const key = runwayDangerKey(input.runway);
  if (key === "") {
    return { alert: false, state: { lastDangerKey: "", lastAlertAtMs: input.state.lastAlertAtMs } };
  }
  const changed = key !== input.state.lastDangerKey;
  const cooldownElapsed =
    input.cooldownMs > 0 && input.nowMs - input.state.lastAlertAtMs >= input.cooldownMs;
  if (changed || cooldownElapsed) {
    return { alert: true, state: { lastDangerKey: key, lastAlertAtMs: input.nowMs } };
  }
  return { alert: false, state: { ...input.state, lastDangerKey: key } };
}

/** Build the D4 alert payload for the pools in the danger band (nearest-first). */
export function buildRunwayAlertPayload(runway: LiquidityRunway, boardUrl: string): AlertPayload {
  const danger = runway.pools
    .filter((p) => p.status === "red" || p.status === "degraded")
    .sort((a, b) => (a.hoursToFloor ?? 0) - (b.hoursToFloor ?? 0));
  const items = danger.map((p) => ({
    id: `runway-${p.key}`,
    title: `${p.label} — ${formatRunwayHours(p.hoursToFloor ?? 0)}`,
  }));
  const lead = danger.length ? `${danger[0].label} ${formatRunwayHours(danger[0].hoursToFloor ?? 0)}` : "";
  return {
    count: danger.length,
    items,
    boardUrl,
    text: `Liquidity runway — ${lead}. Top up before settlement halts (operator action).`,
  };
}

// ── Config (env-driven; balances stay degraded until their RPC/USDC keys are set) ──

export interface ProductHealthConfig {
  apiBaseUrl?: string;
  apiHealthPath: string;
  /** Direct eth-RPC for the signer-balance probe (PRODUCT_HEALTH_RPC_URL, else the
   *  per-network default). Chain HEIGHT no longer needs it — that reads /health. */
  rpcUrl?: string;
  /** chain_height freshness window (seconds): block height static for longer than
   *  this ⇒ "not advancing". 0 disables. Env: PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS. */
  chainMaxStaleSeconds: number;
  /** Halt severity: "auto" (mainnet chainId → red, testnet → degraded) | "red" |
   *  "degraded". Env: PRODUCT_HEALTH_HALT_SEVERITY. */
  haltSeverity: string;
  signerAddress?: string;
  usdcAddress?: string;
  usdcDecimals: number;
  /** Native-gas floor in whole tokens (e.g. 0.1 DOT). 0 = don't threshold. */
  minGasNative: number;
  /** USDC floor in whole tokens (e.g. 5). 0 = don't threshold. */
  minUsdc: number;
  /** capabilityHealth keys that MUST be up; one dropping ⇒ red. Env
   *  PRODUCT_HEALTH_REQUIRED_CAPABILITIES (csv). Default blockchain,treasuryMutations. */
  requiredCapabilities: string[];
  /** Warning codes acknowledged as expected — while only these are present the
   *  capabilities probe stays ok; a NEW code ⇒ degraded (red if error/critical). Env
   *  PRODUCT_HEALTH_EXPECTED_WARNINGS (csv). */
  expectedWarnings: string[];
  /** /health round-trip latency thresholds (ms): degraded ≥ warn, red ≥ red. 0
   *  disables. Env PRODUCT_HEALTH_LATENCY_WARN_MS / PRODUCT_HEALTH_LATENCY_RED_MS. */
  latencyWarnMs: number;
  latencyRedMs: number;
  /** money_path: red at ≥ this many stuck (submitted-unsettled) jobs, or ≥ this many
   *  settlement-EXECUTION failures in 24h. 0 disables that arm. Env
   *  PRODUCT_HEALTH_MAX_STUCK / PRODUCT_HEALTH_MAX_FAILED_24H. */
  maxStuck: number;
  maxFailed24h: number;
  /** Settlement counts older than this (minutes) ⇒ degraded (stale record). Env
   *  PRODUCT_HEALTH_SETTLEMENT_MAX_STALE_MINUTES. */
  settlementMaxStaleMinutes: number;
  /** Treasury/pool USDC floors (whole tokens) → red when a pool drops below. 0 =
   *  show the balance without paging. Env PRODUCT_HEALTH_MIN_REWARD_BANK /
   *  PRODUCT_HEALTH_MIN_TREASURY_RESERVE / PRODUCT_HEALTH_MIN_AAC. */
  minRewardBank: number;
  minTreasuryReserve: number;
  minAac: number;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function csv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// Direct eth-rpc per network for the signer-BALANCE probe (chain height reads
// /health instead). `WALLET_NETWORK` selects it; PRODUCT_HEALTH_RPC_URL overrides.
// Testnet uses the SAME canonical Hub eth-rpc the product settles on
// (deployments/testnet.json, all three backend RPC vars, and the indexer),
// verified live (chainId 420420417, USDC precompile answering). The old
// `testnet-passet-hub-eth-rpc.polkadot.io` host no longer resolves.
const NETWORK_ETH_RPC: Record<string, string> = {
  testnet: "https://eth-rpc-testnet.polkadot.io/",
};

/** Resolve the eth-rpc for the product's network (WALLET_NETWORK); testnet default. */
export function networkEthRpc(walletNetwork: string | undefined): string | undefined {
  return NETWORK_ETH_RPC[(walletNetwork || "testnet").toLowerCase()];
}

// A chain HALT pages on mainnet (settlement down) but not on a testnet (resets
// happen). `auth.chainId` from /health selects; PRODUCT_HEALTH_HALT_SEVERITY overrides.
const MAINNET_CHAIN_IDS = new Set<number>([420420419]); // Polkadot Hub mainnet (DOT). Testnet 420420417 → degraded.

/** Resolve halt severity: explicit override, else auto by chainId (mainnet → red). */
export function chainHaltStatus(chainId: number | undefined, override: string | undefined): ProbeStatus {
  if (override === "red" || override === "degraded") return override;
  return chainId !== undefined && MAINNET_CHAIN_IDS.has(chainId) ? "red" : "degraded";
}

export function loadProductHealthConfig(env: NodeJS.ProcessEnv = process.env): ProductHealthConfig {
  const base = env.AVERRAY_API_BASE_URL;
  return {
    apiBaseUrl: base ? trimTrailingSlash(base) : undefined,
    apiHealthPath: env.PRODUCT_HEALTH_API_PATH || "/health",
    rpcUrl: env.PRODUCT_HEALTH_RPC_URL || networkEthRpc(env.WALLET_NETWORK),
    chainMaxStaleSeconds: num(env.PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS, 600),
    haltSeverity: env.PRODUCT_HEALTH_HALT_SEVERITY || "auto",
    signerAddress: env.PRODUCT_HEALTH_SIGNER_ADDRESS || undefined,
    usdcAddress: env.PRODUCT_HEALTH_USDC_ADDRESS || undefined,
    usdcDecimals: num(env.PRODUCT_HEALTH_USDC_DECIMALS, 6),
    minGasNative: num(env.PRODUCT_HEALTH_MIN_GAS_NATIVE, 0),
    minUsdc: num(env.PRODUCT_HEALTH_MIN_USDC, 0),
    requiredCapabilities: csv(env.PRODUCT_HEALTH_REQUIRED_CAPABILITIES, "blockchain,treasuryMutations"),
    expectedWarnings: csv(env.PRODUCT_HEALTH_EXPECTED_WARNINGS, "xcm_observer_staged,indexer_unavailable,gas_sponsor_disabled"),
    latencyWarnMs: num(env.PRODUCT_HEALTH_LATENCY_WARN_MS, 2000),
    latencyRedMs: num(env.PRODUCT_HEALTH_LATENCY_RED_MS, 10000),
    maxStuck: num(env.PRODUCT_HEALTH_MAX_STUCK, 5),
    maxFailed24h: num(env.PRODUCT_HEALTH_MAX_FAILED_24H, 3),
    settlementMaxStaleMinutes: num(env.PRODUCT_HEALTH_SETTLEMENT_MAX_STALE_MINUTES, 15),
    minRewardBank: num(env.PRODUCT_HEALTH_MIN_REWARD_BANK, 0),
    minTreasuryReserve: num(env.PRODUCT_HEALTH_MIN_TREASURY_RESERVE, 5),
    minAac: num(env.PRODUCT_HEALTH_MIN_AAC, 0),
  };
}

// ── Product /health payload (the product self-reports chain + signer state) ──

/** The slice of the Averray API `/health` payload the monitor reads. All optional
 *  — the product may omit fields, and every derivation degrades safely if so. */
export interface ProductHealthPayload {
  status?: string;
  auth?: { chainId?: number };
  serviceHealth?: { ok?: boolean };
  capabilityHealth?: Record<string, string>;
  warnings?: Array<{ code?: string; severity?: string; message?: string }>;
  components?: {
    blockchain?: {
      ok?: boolean;
      enabled?: boolean;
      blockNumber?: number;
      signerConfigured?: boolean;
      arbitratorSignerConfigured?: boolean;
    };
  };
  /** Settlement-flow counts (the backend's Redis record, not on-chain), per the
   *  locked /health contract. Absent ⇒ money_path degrades until the product ships it. */
  settlement?: {
    settled24h?: number;
    stuck?: number;
    failed24h?: number;
    asOf?: string;
  };
  /** Contract addresses echoed from deployments/testnet.json (locked contract) so the
   *  monitor's balanceOf reads auto-follow a chain retarget. */
  addresses?: {
    token?: string;
    agentAccountCore?: string;
    escrowCore?: string;
    settlementSigner?: string;
    treasuryReserve?: string;
  };
  /** Reward bank = AgentAccountCore.positions(signer,USDC).liquid, computed by the
   *  product (so the monitor needs no positions() ABI). */
  rewardBank?: {
    liquid?: number | null;
    decimals?: number;
    asOf?: string;
  };
}

export interface ProductHealthFetch {
  /** AVERRAY_API_BASE_URL was set. */
  configured: boolean;
  /** The GET completed (any status). */
  reachable: boolean;
  /** Response was 2xx. */
  httpOk: boolean;
  status: number;
  url: string;
  body?: ProductHealthPayload;
  error?: string;
  /** Wall-clock ms for the /health GET round-trip. undefined when unconfigured. */
  latencyMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
}

/** Coerce a number|numeric-string to a finite number, else undefined. */
function pickNum(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── Chain-advance tracker (a frozen chain still reports its last block) ──

/** Tracks when the chain's block height last advanced, so a frozen chain can be
 *  told apart from a live one. Pure state transition; the caller persists it. */
export interface ChainAdvance {
  lastBlock: number;
  lastAdvanceAtMs: number;
}

export function trackChainAdvance(
  prev: ChainAdvance | undefined,
  block: number | undefined,
  nowMs: number,
): ChainAdvance {
  if (block === undefined) return prev ?? { lastBlock: -1, lastAdvanceAtMs: nowMs };
  if (!prev || block > prev.lastBlock) return { lastBlock: block, lastAdvanceAtMs: nowMs };
  return prev; // block <= lastBlock: no advance — keep the old timestamp so staleness accrues.
}

// ── /health-derived probes (product_api + chain_height) ─────────────

/** Fetch the product's `/health` once; product_api + chain_height derive from it. */
export async function fetchProductHealth(input: {
  baseUrl?: string;
  healthPath: string;
  fetchImpl: typeof fetch;
}): Promise<ProductHealthFetch> {
  if (!input.baseUrl) {
    return { configured: false, reachable: false, httpOk: false, status: 0, url: "" };
  }
  const url = joinUrl(input.baseUrl, input.healthPath);
  const startedAt = Date.now();
  try {
    const res = await input.fetchImpl(url, { method: "GET", redirect: "follow" });
    const latencyMs = Date.now() - startedAt;
    let body: ProductHealthPayload | undefined;
    try {
      body = (await res.json()) as ProductHealthPayload;
    } catch {
      body = undefined;
    }
    return { configured: true, reachable: true, httpOk: res.ok, status: res.status, url, body, latencyMs };
  } catch (err) {
    return { configured: true, reachable: false, httpOk: false, status: 0, url, error: errMsg(err), latencyMs: Date.now() - startedAt };
  }
}

/** Is the Averray product API answering? REAL as soon as AVERRAY_API_BASE_URL is set. */
export function deriveProductApiProbe(h: ProductHealthFetch): ProbeResult {
  const name = "product_api";
  if (!h.configured) return { name, status: "degraded", detail: "AVERRAY_API_BASE_URL not configured" };
  if (!h.reachable) return { name, status: "red", detail: `${h.url} unreachable: ${h.error ?? "fetch failed"}` };
  if (!h.httpOk) return { name, status: "red", detail: `${h.url} → HTTP ${h.status}` };
  if (h.body?.serviceHealth?.ok === false) return { name, status: "red", detail: `${h.url} → service reports unhealthy` };
  const chainId = h.body?.auth?.chainId;
  return { name, status: "ok", detail: `${h.url} → ${h.status}${chainId ? ` · chain ${chainId}` : ""}` };
}

/** /health round-trip latency. Slow-but-reachable is degraded (working, just slow);
 *  ≥ redMs is red (effectively down). Unreachable / no sample → degraded (product_api
 *  carries the red for a hard outage). */
export function deriveLatencyProbe(h: ProductHealthFetch, thresholds: { warnMs: number; redMs: number }): ProbeResult {
  const name = "api_latency";
  if (!h.configured) return { name, status: "degraded", detail: "AVERRAY_API_BASE_URL not configured" };
  if (h.latencyMs === undefined) return { name, status: "degraded", detail: "no latency sample" };
  const ms = h.latencyMs;
  if (!h.reachable) return { name, status: "degraded", detail: `no response after ${ms}ms` };
  if (thresholds.redMs > 0 && ms >= thresholds.redMs) return { name, status: "red", detail: `/health ${ms}ms (≥ ${thresholds.redMs}ms)` };
  if (thresholds.warnMs > 0 && ms >= thresholds.warnMs) return { name, status: "degraded", detail: `/health ${ms}ms (≥ ${thresholds.warnMs}ms)` };
  return { name, status: "ok", detail: `/health ${ms}ms` };
}

/** Money-path FLOW, from /health's settlement counts (the backend's Redis record).
 *  red on too many stuck (submitted-unsettled) jobs or settlement-EXECUTION failures
 *  in 24h; degraded on any below those, on stale counts, or before the product
 *  exposes the block. NOTE: failed24h must be execution failures (tx revert), NOT
 *  verifier rejections — a rejection is the protocol working correctly. */
export function deriveMoneyPathProbe(
  h: ProductHealthFetch,
  config: { maxStuck: number; maxFailed24h: number; maxStaleMinutes: number; nowMs: number },
): ProbeResult {
  const name = "money_path";
  if (!h.configured || !h.reachable || !h.httpOk) {
    return { name, status: "degraded", detail: "settlement status unavailable (product /health not readable)" };
  }
  const s = h.body?.settlement;
  if (!s) return { name, status: "degraded", detail: "product /health does not expose settlement counts yet" };
  const stuck = pickNum(s.stuck) ?? 0;
  const failed = pickNum(s.failed24h) ?? 0;
  const settled = pickNum(s.settled24h) ?? 0;
  if (config.maxStaleMinutes > 0 && s.asOf) {
    const ageMs = config.nowMs - Date.parse(s.asOf);
    if (Number.isFinite(ageMs) && ageMs > config.maxStaleMinutes * 60_000) {
      return { name, status: "degraded", detail: `settlement counts stale — asOf ${formatDuration(ageMs)} ago` };
    }
  }
  if (config.maxStuck > 0 && stuck >= config.maxStuck) {
    return { name, status: "red", detail: `${stuck} jobs stuck (submitted, unsettled ≥ ${config.maxStuck})` };
  }
  if (config.maxFailed24h > 0 && failed >= config.maxFailed24h) {
    return { name, status: "red", detail: `${failed} settlement failures in 24h (≥ ${config.maxFailed24h})` };
  }
  if (stuck > 0 || failed > 0) {
    return { name, status: "degraded", detail: `stuck ${stuck}, failed24h ${failed}, settled24h ${settled}` };
  }
  return { name, status: "ok", detail: `settled24h ${settled} (0 stuck, 0 failed)` };
}

// A capabilityHealth value counts as "up" when it's one of these; anything else
// (unavailable / staged / disabled / degraded / …) is treated as not-operational.
const HEALTHY_CAPABILITY_STATES = new Set(["enabled", "available", "ok", "ready", "healthy"]);
const CRITICAL_WARNING_SEVERITIES = new Set(["error", "critical", "fatal"]);

/** Product capability + dependency health, from /health's `capabilityHealth` +
 *  `warnings[]`. RED if a REQUIRED capability isn't up (money path down); DEGRADED
 *  on a NEW warning outside the acknowledged baseline (RED if it's error/critical);
 *  OK while only the acknowledged warnings are present. Unreadable /health →
 *  degraded (product_api carries the red). */
export function deriveCapabilityProbe(
  h: ProductHealthFetch,
  config: { requiredCapabilities: string[]; expectedWarnings: string[] },
): ProbeResult {
  const name = "capabilities";
  if (!h.configured || !h.reachable || !h.httpOk) {
    return { name, status: "degraded", detail: "capability status unavailable (product /health not readable)" };
  }
  const caps = h.body?.capabilityHealth;
  if (!caps) return { name, status: "degraded", detail: "product /health did not report capabilityHealth" };
  const isUp = (v: unknown): boolean => HEALTHY_CAPABILITY_STATES.has(String(v ?? "").toLowerCase());
  const requiredDown = config.requiredCapabilities.filter((k) => !isUp(caps[k]));
  if (requiredDown.length > 0) {
    return { name, status: "red", detail: `required capability down: ${requiredDown.map((k) => `${k}=${caps[k] ?? "missing"}`).join(", ")}` };
  }
  const expected = new Set(config.expectedWarnings);
  const unexpected = (h.body?.warnings ?? []).filter((w) => w.code && !expected.has(w.code));
  if (unexpected.length > 0) {
    const critical = unexpected.some((w) => CRITICAL_WARNING_SEVERITIES.has(String(w.severity ?? "").toLowerCase()));
    return {
      name,
      status: critical ? "red" : "degraded",
      detail: `${critical ? "new CRITICAL" : "new"} capability warning: ${unexpected.map((w) => w.code).join(", ")}`,
    };
  }
  const total = Object.keys(caps).length;
  const up = Object.values(caps).filter(isUp).length;
  const ackd = (h.body?.warnings ?? []).length;
  return {
    name,
    status: "ok",
    detail: `${up}/${total} capabilities up${ackd ? `, ${ackd} acknowledged warning${ackd === 1 ? "" : "s"}` : ""}`,
  };
}

/** Chain reachable + producing blocks, per the product's own /health. Unreadable
 *  /health → degraded (product_api carries the red; never double-page). A frozen
 *  height (static past the window) → `haltStatus` (red on mainnet, degraded on a
 *  testnet freeze), never a green on a stopped chain. */
export function deriveChainProbe(
  h: ProductHealthFetch,
  staleness?: {
    staticForMs: number;
    maxStaleSeconds: number;
    haltStatus: ProbeStatus;
    /** Absolute age (s) of the latest block from a chain-matched RPC. When present
     *  it's authoritative (no startup blind window); undefined ⇒ fall back to the
     *  cross-poll block-advance tracker. */
    blockAgeSec?: number;
  },
): ProbeResult {
  const name = "chain_height";
  if (!h.configured || !h.reachable || !h.httpOk) {
    return { name, status: "degraded", detail: "chain status unavailable (product /health not readable)" };
  }
  const bc = h.body?.components?.blockchain;
  if (!bc) return { name, status: "degraded", detail: "product /health did not report a blockchain component" };
  const chainId = h.body?.auth?.chainId;
  const tag = chainId ? ` · chain ${chainId}` : "";
  if (bc.ok === false) return { name, status: "red", detail: `product reports its blockchain component unhealthy${tag}` };
  const block = pickNum(bc.blockNumber);
  if (block === undefined) return { name, status: "degraded", detail: `blockchain healthy but no block height reported${tag}` };
  if (block <= 0) return { name, status: "red", detail: `chain reports block ${block}${tag}` };
  if (staleness && staleness.maxStaleSeconds > 0) {
    const { blockAgeSec, maxStaleSeconds, staticForMs, haltStatus } = staleness;
    if (blockAgeSec !== undefined) {
      // Absolute block age (chain-matched RPC) — fires immediately, no blind window.
      if (blockAgeSec > maxStaleSeconds) {
        return {
          name,
          status: haltStatus,
          detail: `chain not advancing — last block ${formatDuration(blockAgeSec * 1000)} old (block #${formatInt(block)})${tag}`,
        };
      }
    } else if (staticForMs >= maxStaleSeconds * 1000) {
      // Fallback: no chain-matched RPC → cross-poll tracker (has a startup blind window).
      return {
        name,
        status: haltStatus,
        detail: `chain not advancing — block #${formatInt(block)} static for ${formatDuration(staticForMs)}${tag}`,
      };
    }
  }
  return { name, status: "ok", detail: `block #${formatInt(block)}${tag}` };
}

// ── Direct eth-RPC signer-balance probe (the only source of real balances) ──

/** Minimal eth JSON-RPC call; returns the raw `result` (may be a string or object). */
async function ethRpcRaw(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message ?? "rpc error"}`);
  if (json.result === undefined || json.result === null) throw new Error(`${method}: missing result`);
  return json.result;
}

/** eth JSON-RPC call whose result is a hex string (eth_call, eth_getBalance, …). */
async function ethRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<string> {
  const result = await ethRpcRaw(rpcUrl, method, params, fetchImpl);
  if (typeof result !== "string") throw new Error(`${method}: expected a string result`);
  return result;
}

// erc20 balanceOf(address) selector.
const BALANCE_OF_SELECTOR = "0x70a08231";

function encodeBalanceOf(address: string): string {
  return BALANCE_OF_SELECTOR + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Signer solvency: native gas + (optionally) USDC vs floors. Read fails → degraded. */
export async function probeSignerLiquidity(input: {
  rpcUrl?: string;
  signerAddress?: string;
  usdcAddress?: string;
  usdcDecimals: number;
  minGasNative: number;
  minUsdc: number;
  fetchImpl: typeof fetch;
}): Promise<ProbeResult & { pools?: SolvencyPoolData[] }> {
  if (!input.rpcUrl || !input.signerAddress) {
    return {
      name: "signer_liquidity",
      status: "degraded",
      detail: "PRODUCT_HEALTH_RPC_URL / signer address not configured",
    };
  }
  try {
    const gasWei = BigInt(await ethRpc(input.rpcUrl, "eth_getBalance", [input.signerAddress, "latest"], input.fetchImpl));
    const gasNative = Number(gasWei) / 1e18;
    const parts: string[] = [];
    let red = false;

    const gasPart = `gas ${gasNative.toFixed(4)}`;
    if (input.minGasNative > 0 && gasNative < input.minGasNative) {
      red = true;
      parts.push(`${gasPart} < ${input.minGasNative}`);
    } else {
      parts.push(gasPart);
    }

    let usdc: number | undefined;
    if (input.usdcAddress) {
      const usdcRaw = await ethRpc(
        input.rpcUrl,
        "eth_call",
        [{ to: input.usdcAddress, data: encodeBalanceOf(input.signerAddress) }, "latest"],
        input.fetchImpl,
      );
      usdc = Number(BigInt(usdcRaw || "0x0")) / 10 ** input.usdcDecimals;
      const usdcPart = `USDC ${usdc.toFixed(2)}`;
      if (input.minUsdc > 0 && usdc < input.minUsdc) {
        red = true;
        parts.push(`${usdcPart} < ${input.minUsdc}`);
      } else {
        parts.push(usdcPart);
      }
    }

    const pools: SolvencyPoolData[] = [
      {
        key: "signer_gas",
        label: "Signer gas",
        amount: gasNative,
        unit: "PAS",
        floor: input.minGasNative > 0 ? input.minGasNative : null,
        status: input.minGasNative > 0 && gasNative < input.minGasNative ? "red" : "ok",
      },
    ];
    if (usdc !== undefined) {
      pools.push({
        key: "signer_usdc",
        label: "Signer USDC",
        amount: usdc,
        unit: "USDC",
        floor: input.minUsdc > 0 ? input.minUsdc : null,
        status: input.minUsdc > 0 && usdc < input.minUsdc ? "red" : "ok",
      });
    }

    return { name: "signer_liquidity", status: red ? "red" : "ok", detail: parts.join(", "), pools };
  } catch (err) {
    return { name: "signer_liquidity", status: "degraded", detail: `balance read failed: ${errMsg(err)}` };
  }
}

/** Treasury / reward-pool headroom: USDC balanceOf(AAC / escrow / reserve) via direct
 *  RPC + the reward bank (rewardBank.liquid the product computes on /health). Floors
 *  page (red); escrow is informational (in-flight, fluctuates). Addresses absent (the
 *  product hasn't shipped them) or a read fails → degraded (never a page for our hiccup). */
export async function probeTreasuryLiquidity(input: {
  addresses?: { token?: string; agentAccountCore?: string; escrowCore?: string; treasuryReserve?: string };
  rewardBankLiquid?: number;
  usdcDecimals: number;
  minRewardBank: number;
  minTreasuryReserve: number;
  minAac: number;
  rpcUrl?: string;
  fetchImpl: typeof fetch;
}): Promise<ProbeResult & { pools?: SolvencyPoolData[] }> {
  const name = "treasury_liquidity";
  const a = input.addresses;
  if (!a || !a.token) return { name, status: "degraded", detail: "treasury addresses not exposed by /health yet" };
  if (!input.rpcUrl) return { name, status: "degraded", detail: "PRODUCT_HEALTH_RPC_URL not configured" };
  try {
    const usdcOf = async (addr?: string): Promise<number | undefined> => {
      if (!addr) return undefined;
      const raw = await ethRpc(input.rpcUrl!, "eth_call", [{ to: a.token, data: encodeBalanceOf(addr) }, "latest"], input.fetchImpl);
      return Number(BigInt(raw || "0x0")) / 10 ** input.usdcDecimals;
    };
    const [aac, escrow, reserve] = await Promise.all([
      usdcOf(a.agentAccountCore),
      usdcOf(a.escrowCore),
      usdcOf(a.treasuryReserve),
    ]);
    const parts: string[] = [];
    let red = false;
    const withFloor = (label: string, val: number | undefined, floor: number): void => {
      if (val === undefined) return;
      const s = `${label} ${val.toFixed(2)}`;
      if (floor > 0 && val < floor) {
        red = true;
        parts.push(`${s} < ${floor}`);
      } else {
        parts.push(s);
      }
    };
    withFloor("reward", input.rewardBankLiquid, input.minRewardBank);
    withFloor("reserve", reserve, input.minTreasuryReserve);
    withFloor("AAC", aac, input.minAac);
    if (escrow !== undefined) parts.push(`escrow ${escrow.toFixed(2)}`); // in-flight — informational, no floor

    const pools: SolvencyPoolData[] = [];
    const pool = (key: string, label: string, val: number | undefined, floor: number): void => {
      if (val === undefined) return;
      pools.push({ key, label, amount: val, unit: "USDC", floor: floor > 0 ? floor : null, status: floor > 0 && val < floor ? "red" : "ok" });
    };
    pool("reward_bank", "Reward bank", input.rewardBankLiquid, input.minRewardBank);
    pool("reserve", "Treasury reserve", reserve, input.minTreasuryReserve);
    pool("aac", "Agent core", aac, input.minAac);
    if (escrow !== undefined) pools.push({ key: "escrow", label: "Escrow (in-flight)", amount: escrow, unit: "USDC", status: "ok", informational: true });

    if (parts.length === 0) return { name, status: "degraded", detail: "no treasury balances readable" };
    return { name, status: red ? "red" : "ok", detail: parts.join(", "), pools };
  } catch (err) {
    return { name, status: "degraded", detail: `treasury read failed: ${errMsg(err)}` };
  }
}

// ── Collector: one /health fetch (api + chain) + the direct-RPC balance probe ──

// ── Structured "snapshot" blocks the Ops board consumes forward-compat ──
// Each is emitted only when its data is actually available: signer solvency is
// always readable via direct RPC; treasury pools + settlement flow arrive when
// the product /health exposes addresses + settlement (until then the frontend
// shows honest awaiting-data, never a fabricated zero).

export interface SolvencyPoolData {
  key: string;
  label: string;
  amount: number | null;
  unit: string;
  floor?: number | null;
  status: ProbeStatus;
  informational?: boolean;
}
export interface SolvencySnapshotData {
  pools: SolvencyPoolData[];
  runwayNote?: string | null;
  /** Per-pool time-to-floor projection — drives the pre-floor ops suggestion. */
  runway?: LiquidityRunwayPool[];
}
export interface MoneyPathData {
  settled24h?: number | null;
  stuck?: number | null;
  failed24h?: number | null;
  asOf?: number | null;
}
export interface ProductHealthSnapshotBlocks {
  chainId?: number | null;
  network?: "testnet" | "mainnet" | "unknown";
  solvency?: SolvencySnapshotData;
  flow?: MoneyPathData;
}

function resolveProductHealthNetwork(chainId: number | undefined): "testnet" | "mainnet" | "unknown" {
  if (chainId === undefined) return "unknown";
  return MAINNET_CHAIN_IDS.has(chainId) ? "mainnet" : "testnet";
}

function parseHealthAsOf(asOf: string | undefined): number | null {
  if (!asOf) return null;
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? null : t;
}

export interface ProductHealthCollection {
  probes: ProbeResult[];
  /** Updated block-advance tracker — the caller persists it across ticks. */
  chainAdvance: ChainAdvance;
  /** Structured blocks for the Ops board (chain id / network / solvency / flow). */
  snapshot: ProductHealthSnapshotBlocks;
  /** GET /health round-trip latency (ms) — the caller records it on the history entry. */
  latencyMs?: number;
}

/** Absolute age (seconds) of the chain's latest block via the direct RPC — but
 *  ONLY when that RPC reports the SAME chainId `/health` does, so a retarget-stale
 *  endpoint can't false-halt on the wrong chain. undefined = no RPC / chain mismatch
 *  / read error → the caller falls back to the cross-poll block-advance tracker. */
export async function chainBlockAge(input: {
  rpcUrl?: string;
  expectedChainId?: number;
  nowMs: number;
  fetchImpl: typeof fetch;
}): Promise<number | undefined> {
  if (!input.rpcUrl) return undefined;
  try {
    const cid = Number(BigInt(await ethRpc(input.rpcUrl, "eth_chainId", [], input.fetchImpl)));
    if (input.expectedChainId !== undefined && cid !== input.expectedChainId) return undefined;
    const block = (await ethRpcRaw(input.rpcUrl, "eth_getBlockByNumber", ["latest", false], input.fetchImpl)) as
      | { timestamp?: string }
      | null;
    if (!block || typeof block.timestamp !== "string") return undefined;
    return Math.max(0, Math.floor(input.nowMs / 1000) - Number(BigInt(block.timestamp)));
  } catch {
    return undefined;
  }
}

export async function collectProductHealthProbes(
  config: ProductHealthConfig,
  fetchImpl: typeof fetch = fetch,
  chainCtx: { advance?: ChainAdvance; nowMs: number } = { nowMs: 0 },
): Promise<ProductHealthCollection> {
  const h = await fetchProductHealth({
    baseUrl: config.apiBaseUrl,
    healthPath: config.apiHealthPath,
    fetchImpl,
  });
  const chainId = h.body?.auth?.chainId;
  const block = pickNum(h.body?.components?.blockchain?.blockNumber);
  const chainAdvance = trackChainAdvance(chainCtx.advance, block, chainCtx.nowMs);
  // Absolute block age from the (chain-matched) settlement RPC — no startup blind
  // window; falls back to the cross-poll tracker when the RPC is absent/mismatched.
  const blockAgeSec = await chainBlockAge({
    rpcUrl: config.rpcUrl,
    expectedChainId: chainId,
    nowMs: chainCtx.nowMs,
    fetchImpl,
  });
  const staleness = {
    staticForMs: chainCtx.nowMs - chainAdvance.lastAdvanceAtMs,
    maxStaleSeconds: config.chainMaxStaleSeconds,
    haltStatus: chainHaltStatus(chainId, config.haltSeverity),
    blockAgeSec,
  };
  const signer = await probeSignerLiquidity({
    rpcUrl: config.rpcUrl,
    signerAddress: config.signerAddress,
    usdcAddress: config.usdcAddress,
    usdcDecimals: config.usdcDecimals,
    minGasNative: config.minGasNative,
    minUsdc: config.minUsdc,
    fetchImpl,
  });
  const treasury = await probeTreasuryLiquidity({
    addresses: h.body?.addresses,
    rewardBankLiquid: pickNum(h.body?.rewardBank?.liquid),
    usdcDecimals: config.usdcDecimals,
    minRewardBank: config.minRewardBank,
    minTreasuryReserve: config.minTreasuryReserve,
    minAac: config.minAac,
    rpcUrl: config.rpcUrl,
    fetchImpl,
  });
  const solvencyPools = [...(signer.pools ?? []), ...(treasury.pools ?? [])];
  const settlement = h.body?.settlement;
  const snapshot: ProductHealthSnapshotBlocks = {
    chainId: chainId ?? null,
    network: resolveProductHealthNetwork(chainId),
    ...(solvencyPools.length ? { solvency: { pools: solvencyPools } } : {}),
    ...(settlement
      ? {
          flow: {
            settled24h: settlement.settled24h ?? null,
            stuck: settlement.stuck ?? null,
            failed24h: settlement.failed24h ?? null,
            asOf: parseHealthAsOf(settlement.asOf),
          },
        }
      : {}),
  };
  return {
    probes: [
      deriveProductApiProbe(h),
      deriveChainProbe(h, staleness),
      signer,
      deriveCapabilityProbe(h, {
        requiredCapabilities: config.requiredCapabilities,
        expectedWarnings: config.expectedWarnings,
      }),
      deriveLatencyProbe(h, { warnMs: config.latencyWarnMs, redMs: config.latencyRedMs }),
      deriveMoneyPathProbe(h, {
        maxStuck: config.maxStuck,
        maxFailed24h: config.maxFailed24h,
        maxStaleMinutes: config.settlementMaxStaleMinutes,
        nowMs: chainCtx.nowMs,
      }),
      treasury,
    ],
    chainAdvance,
    snapshot,
    latencyMs: h.latencyMs,
  };
}

// ── Alert rendering (reuses the D4 AlertPayload) ────────────────────

export function buildProductHealthAlert(evaluation: ProductHealthEvaluation, boardUrl: string): AlertPayload {
  const lines = evaluation.redProbes.map((p) => `• 🔴 ${p.name}: ${p.detail}`).join("\n");
  const head =
    evaluation.redProbes.length === 1
      ? "1 product-health probe is RED"
      : `${evaluation.redProbes.length} product-health probes are RED`;
  const text = `:rotating_light: Averray product health — ${head}\n${lines}\nInspect: ${boardUrl}`;
  return { count: evaluation.redProbes.length, items: [], boardUrl, text };
}

// ── De-dup: alert on a rising edge or a changed red-set, else after cooldown ──

export interface ProductHealthAlertState {
  /** The red-set key at the previous red episode ("" when last clear). */
  lastRedKey: string;
  lastAlertAtMs: number;
}

export function initialProductHealthAlertState(): ProductHealthAlertState {
  return { lastRedKey: "", lastAlertAtMs: 0 };
}

/**
 * Pure de-dup: alert when the red-set is newly non-empty, when its membership
 * changes, or when the cooldown has elapsed on an unchanged red-set. Returns the
 * next state alongside the decision so the caller can persist it.
 */
export function decideProductHealthAlert(input: {
  evaluation: ProductHealthEvaluation;
  state: ProductHealthAlertState;
  nowMs: number;
  cooldownMs: number;
}): { alert: boolean; state: ProductHealthAlertState } {
  const key = redProbeKey(input.evaluation);
  if (input.evaluation.status !== "red" || key === "") {
    return { alert: false, state: { lastRedKey: "", lastAlertAtMs: input.state.lastAlertAtMs } };
  }
  const changed = key !== input.state.lastRedKey;
  const cooldownElapsed =
    input.cooldownMs > 0 && input.nowMs - input.state.lastAlertAtMs >= input.cooldownMs;
  if (changed || cooldownElapsed) {
    return { alert: true, state: { lastRedKey: key, lastAlertAtMs: input.nowMs } };
  }
  return { alert: false, state: { ...input.state, lastRedKey: key } };
}

// ── Orchestrator (effect-injected; index.ts wires real probes + Slack channel) ──

export interface ProductHealthDeps {
  runProbes: () => Promise<ProbeResult[]>;
  alert: (payload: AlertPayload) => Promise<boolean>;
  boardUrl: string;
  nowMs: () => number;
  getAlertState: () => ProductHealthAlertState;
  setAlertState: (state: ProductHealthAlertState) => void;
  cooldownMs: number;
}

export interface ProductHealthResult {
  status: ProductHealthStatus;
  evaluation: ProductHealthEvaluation;
  alerted: boolean;
}

export async function runProductHealthOnce(deps: ProductHealthDeps): Promise<ProductHealthResult> {
  const probes = await deps.runProbes();
  const evaluation = evaluateProductHealth(probes);
  const { alert, state } = decideProductHealthAlert({
    evaluation,
    state: deps.getAlertState(),
    nowMs: deps.nowMs(),
    cooldownMs: deps.cooldownMs,
  });
  deps.setAlertState(state);
  let alerted = false;
  if (alert) {
    await deps.alert(buildProductHealthAlert(evaluation, deps.boardUrl));
    alerted = true;
  }
  return { status: evaluation.status, evaluation, alerted };
}
