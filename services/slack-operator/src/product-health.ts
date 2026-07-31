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
//  • Signer gas comes from direct eth-RPC (`eth_getBalance`). Payout liquidity
//    comes from `/health.rewardBank.liquid`, the authoritative
//    AgentAccountCore.positions[signer][USDC].liquid position. Raw JSON-RPC uses
//    the injected `fetch` (no viem dependency).
//
// TRUTH-BOUNDARY (the whole point): an UNCONFIGURED or unreadable probe reports
// `degraded`, never a fake green; a probe the product self-reports as failing (or a
// balance below its floor) reports `red`. Only `red` fires an alert. A dependency
// hiccup (our RPC, the /health fetch) → `degraded`, never a product-down page. A
// chain HALT is network-conditional: a testnet freeze is `degraded` (no page — a
// known reset happens), a mainnet halt is `red` (settlement down = page).

import type { AlertPayload } from "./alert-bridge.js";

// ── Probe result model ──────────────────────────────────────────────

import { decideDiskHeadroom, readDiskUsage } from "./disk-headroom.js";
import { alertProvenance, decideMoneyAlert } from "./money-alert.js";
import { decideSelfFreshness, fetchSelfCompare } from "./self-freshness.js";
import type { SelfFreshness } from "./self-freshness.js";

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
  /** Reward-bank USDC at this check — Trends balance series + payout runway.
   *  The field name is retained for stored-history compatibility; the value is
   *  AgentAccountCore.positions[signer][USDC].liquid, never wallet USDC. */
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
  /** Share of determinate trailing-24h product_api checks that were reachable
   *  and healthy, 0..100. Unknown monitor samples are excluded; null means the
   *  window contains no determinate product-availability evidence. */
  uptimePct24h: number | null;
  /** Per-check product_api availability (oldest→newest), bounded to `maxSeries`.
   *  Missing/unknown product_api evidence is degraded/grey, never fake-green. */
  uptimeSeries: ProbeStatus[];
  latencySeriesMs: (number | null)[];
  balanceSeries: (number | null)[];
  incidents: ProductHealthIncident[];
}

/** Product reachability is deliberately independent from the overall monitor
 * status. RPC, GitHub, or balance-reader failures can degrade the monitor while
 * the product's own /health endpoint remains available. */
function productAvailabilityTone(snapshot: ProductHealthSnapshot): ProbeStatus {
  const probe = snapshot.probes.find((p) => p.name === "product_api");
  return probe?.status === "ok" || probe?.status === "red" ? probe.status : "degraded";
}

/**
 * Derive the Ops Trends + Incidents block from the rolling history. Pure — the
 * caller passes `nowMs`. The series are newest-anchored to `maxSeries` bins; the
 * uptime% is over determinate product_api checks in the trailing
 * `uptimeWindowMs`. A degraded/missing product_api sample is unknown and is
 * excluded from the percentage rather than being counted as either up or down.
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
  const availability = inWindow
    .map(productAvailabilityTone)
    .filter((status): status is "ok" | "red" => status === "ok" || status === "red");
  const uptimePct24h =
    availability.length > 0
      ? Math.round((availability.filter((status) => status === "ok").length / availability.length) * 1000) / 10
      : null;

  return {
    uptimePct24h,
    uptimeSeries: series.map(productAvailabilityTone),
    latencySeriesMs: series.map((s) => s.latencyMs ?? null),
    balanceSeries: series.map((s) => s.signerUsdc ?? null),
    incidents: deriveIncidents(history),
  };
}

const PRODUCT_API_DEPENDENT_PROBES = new Set([
  "chain_height",
  "capabilities",
  "api_latency",
  "money_path",
]);

/** These probe failures carry no evidence beyond an unreadable product /health.
 * Keep the product_api incident as the root instead of multiplying one outage
 * into four nominal incidents. Independent probe failures remain visible. */
function isProductApiDependentFailure(
  snapshot: ProductHealthSnapshot,
  probe: ProbeResult | undefined,
): boolean {
  if (!probe || !PRODUCT_API_DEPENDENT_PROBES.has(probe.name)) return false;
  const productApi = snapshot.probes.find((candidate) => candidate.name === "product_api");
  if (!productApi || productApi.status === "ok") return false;
  return /product \/health not readable|no response after/i.test(probe.detail);
}

/** Contiguous degraded/red runs per probe → incident episodes (newest-first,
 *  capped). Awaiting-data degradations are excluded — a forward-compat gap is
 *  not an incident. Failures derived solely from an unreadable product_api are
 *  folded into that root incident. An unrecovered run stays open
 *  (`endedAt: null`). */
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
      // Do not treat root-cause suppression as recovery for a pre-existing
      // independent incident; wait for an observable sample to close it.
      if (isProductApiDependentFailure(snap, probe)) continue;
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

/** Per-pool balance accessor into a history entry — only live payout/gas pools
 *  carry a stored series; other treasury pools are forward-compat. */
const RUNWAY_SERIES: Record<string, (s: ProductHealthSnapshot) => number | null | undefined> = {
  signer_gas: (s) => s.signerGas,
  reward_bank: (s) => s.signerUsdc,
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
  /** Verify settled jobs against real on-chain transfers. OFF by default: the
   *  log read is rate-limit sensitive, so the operator arms it deliberately. */
  payoutEvidenceEnabled: boolean;
  /** Override the payout SOURCE address. Defaults to /health's
   *  addresses.agentAccountCore — the contract USDC actually leaves. */
  payoutSourceAddress?: string;
  /** "owner/repo" of the MONITOR itself, for the self-freshness comparison. */
  selfRepo?: string;
  /** The commit this build came from — baked in as AVERRAY_GIT_SHA. */
  selfSha?: string;
  /** Token for the compare call; a private repo returns 404 without one. */
  selfGithubToken?: string;
  githubApiBaseUrl?: string;
  /** Blocks scanned for Transfer logs (~24h at the chain's block time). */
  payoutLookbackBlocks: number;
  /** Settled-minus-confirmed gap tolerated as a window-boundary artifact. */
  payoutTolerance: number;
  /** Filesystem the monitor writes to. Container `/` sees real host capacity. */
  diskPath: string;
  /** Free-space floor in GiB — below this the disk probe goes red. */
  minDiskFreeGb: number;
  /** Free-space warning line in GiB. */
  warnDiskFreeGb: number;
  /** Native-gas floor in whole tokens (e.g. 0.1 DOT). 0 = don't threshold. */
  minGasNative: number;
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
  /** Required explanation when the treasury-reserve floor is deliberately 0.
   *  Without it the reserve probe degrades instead of silently painting green. */
  treasuryReserveZeroReason?: string;
  minAac: number;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Opt-in switch, same spelling as OPS_AUTOREMEDIATE_ENABLED. */
function truthy(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
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
    payoutEvidenceEnabled: truthy(env.PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED),
    payoutSourceAddress: env.PRODUCT_HEALTH_PAYOUT_SOURCE_ADDRESS || undefined,
    selfRepo: env.PRODUCT_HEALTH_SELF_REPO || env.MONITOR_REPO || undefined,
    selfSha: env.AVERRAY_GIT_SHA || undefined,
    selfGithubToken: env.PRODUCT_HEALTH_SELF_GITHUB_TOKEN || env.GITHUB_TOKEN || undefined,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL || undefined,
    // ~24h at a 6s block time. Lower it if the RPC caps eth_getLogs ranges.
    payoutLookbackBlocks: num(env.PRODUCT_HEALTH_PAYOUT_LOOKBACK_BLOCKS, 14400),
    payoutTolerance: num(env.PRODUCT_HEALTH_PAYOUT_TOLERANCE, 1),
    diskPath: env.PRODUCT_HEALTH_DISK_PATH || "/",
    // Unlike the token floors (which default to 0 = can-never-go-red, because a
    // sensible balance is deployment-specific), disk exhaustion is universally
    // fatal, so these carry real defaults. Sized against the live box: 155 GiB
    // free, so 10/25 cannot fire spuriously.
    minDiskFreeGb: num(env.PRODUCT_HEALTH_MIN_DISK_FREE_GB, 10),
    warnDiskFreeGb: num(env.PRODUCT_HEALTH_WARN_DISK_FREE_GB, 25),
    minGasNative: num(env.PRODUCT_HEALTH_MIN_GAS_NATIVE, 0),
    requiredCapabilities: csv(env.PRODUCT_HEALTH_REQUIRED_CAPABILITIES, "blockchain,treasuryMutations"),
    expectedWarnings: csv(env.PRODUCT_HEALTH_EXPECTED_WARNINGS, "xcm_observer_staged,indexer_unavailable,gas_sponsor_disabled"),
    latencyWarnMs: num(env.PRODUCT_HEALTH_LATENCY_WARN_MS, 2000),
    latencyRedMs: num(env.PRODUCT_HEALTH_LATENCY_RED_MS, 10000),
    maxStuck: num(env.PRODUCT_HEALTH_MAX_STUCK, 5),
    maxFailed24h: num(env.PRODUCT_HEALTH_MAX_FAILED_24H, 3),
    settlementMaxStaleMinutes: num(env.PRODUCT_HEALTH_SETTLEMENT_MAX_STALE_MINUTES, 15),
    minRewardBank: num(env.PRODUCT_HEALTH_MIN_REWARD_BANK, 0),
    minTreasuryReserve: num(env.PRODUCT_HEALTH_MIN_TREASURY_RESERVE, 5),
    treasuryReserveZeroReason: env.PRODUCT_HEALTH_TREASURY_RESERVE_ZERO_REASON?.trim() || undefined,
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
    claimed24h?: number;
    submitted24h?: number;
    claimedNotSubmitted?: number;
    submittedNotSettled?: number;
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
  config: {
    maxStuck: number;
    maxFailed24h: number;
    maxStaleMinutes: number;
    nowMs: number;
    /** Previous poll's current-state gauge. A positive value on both polls is
     *  a sustained verification/payout backlog rather than a transient handoff. */
    previousSubmittedNotSettled?: number | null;
  },
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
  const claimedNotSubmitted = pickNum(s.claimedNotSubmitted);
  const submittedNotSettled = pickNum(s.submittedNotSettled);
  const previousSubmittedNotSettled = pickNum(config.previousSubmittedNotSettled);
  const submittedBacklogSustained =
    submittedNotSettled !== undefined &&
    submittedNotSettled > 0 &&
    previousSubmittedNotSettled !== undefined &&
    previousSubmittedNotSettled > 0;
  const withGauges = (detail: string): string => {
    const gauges: string[] = [];
    if (claimedNotSubmitted !== undefined && claimedNotSubmitted > 0) {
      gauges.push(`claimedNotSubmitted ${claimedNotSubmitted}`);
    }
    if (submittedNotSettled !== undefined && submittedNotSettled > 0) {
      gauges.push(
        submittedBacklogSustained
          ? `submittedNotSettled ${submittedNotSettled} across 2 consecutive probes`
          : `submittedNotSettled ${submittedNotSettled} (first observation)`,
      );
    }
    return gauges.length > 0 ? `${detail}; ${gauges.join(", ")}` : detail;
  };
  if (config.maxStaleMinutes > 0 && s.asOf) {
    const ageMs = config.nowMs - Date.parse(s.asOf);
    if (Number.isFinite(ageMs) && ageMs > config.maxStaleMinutes * 60_000) {
      return {
        name,
        status: "degraded",
        detail: withGauges(`settlement counts stale — asOf ${formatDuration(ageMs)} ago`),
      };
    }
  }
  if (config.maxStuck > 0 && stuck >= config.maxStuck) {
    return {
      name,
      status: "red",
      detail: withGauges(`${stuck} jobs stuck (submitted, unsettled ≥ ${config.maxStuck})`),
    };
  }
  if (config.maxFailed24h > 0 && failed >= config.maxFailed24h) {
    return {
      name,
      status: "red",
      detail: withGauges(`${failed} settlement failures in 24h (≥ ${config.maxFailed24h})`),
    };
  }
  if (stuck > 0 || failed > 0) {
    return {
      name,
      status: "degraded",
      detail: withGauges(`stuck ${stuck}, failed24h ${failed}, settled24h ${settled}`),
    };
  }
  const healthyDetail = withGauges(`settled24h ${settled} (0 stuck, 0 failed)`);
  if (submittedBacklogSustained) {
    return { name, status: "degraded", detail: healthyDetail };
  }
  return { name, status: "ok", detail: healthyDetail };
}

// A capabilityHealth value counts as "up" when it's one of these; anything else
// (unavailable / staged / disabled / degraded / …) is treated as not-operational.
const HEALTHY_CAPABILITY_STATES = new Set(["enabled", "available", "ok", "ready", "healthy", "synced"]);
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
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `${method} → RPC endpoint misconfigured (HTTP 404: JSON-RPC route not found)`,
      );
    }
    if (res.status === 429) {
      throw new Error(`${method} → RPC endpoint throttled (HTTP 429)`);
    }
    throw new Error(`${method} → RPC endpoint HTTP ${res.status}`);
  }
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

/**
 * keccak256("ReservationSettled(bytes32,address,address,address,uint256)") — the
 * AgentAccountCore event a reward payout emits.
 *
 * NOT the ERC-20 Transfer topic. USDC here is asset 1337 behind the precompile
 * at 0x…1200000, which bridges to the Substrate assets pallet: a transfer is a
 * PALLET event and never enters EVM log space. Verified on mainnet 2026-07-29 —
 * that address has emitted zero logs, and there is not a single ERC-20 Transfer
 * topic anywhere on the chain. Watching for one finds nothing forever, which is
 * indistinguishable from total payout failure.
 *
 * `eth_getLogs` itself works fine (368 logs over a ~130k-block window); an
 * earlier 200-block sample of a mostly-empty chain wrongly suggested otherwise.
 * Our own contracts emit normally, so the payout is read from OUR event — which
 * is better evidence anyway: it is semantic, correlates 1:1 with a settlement,
 * and is independent of the backend's own claim, which is the entire point.
 *
 * Layout (indexed → topics, the rest → data):
 *   topic1 jobId · topic2 account · topic3 recipient
 *   data[0] asset · data[1] amount
 */
/** settled24h is a rolling 24h count, so that is what the window must span. */
const PAYOUT_COMPARISON_HOURS = 24;
/** Blocks sampled to measure block time — long enough to smooth jitter. */
const PAYOUT_BLOCK_TIME_SAMPLE = 2000;

const RESERVATION_SETTLED_TOPIC = "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee";

/** Pad an address to a 32-byte topic. */
function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/** One 32-byte word of a log's `data`, or undefined when it is not there. */
function dataWord(data: unknown, index: number): string | undefined {
  if (typeof data !== "string") return undefined;
  const body = data.replace(/^0x/, "");
  const start = index * 64;
  return body.length >= start + 64 ? body.slice(start, start + 64) : undefined;
}

/**
 * The payout verdict. PURE — the tolerance reasoning is the delicate part, so
 * it's testable without a chain.
 *
 * The two counts come from different clocks: `settled24h` is the product's
 * rolling 24h, the log read is an approximate block window. A small mismatch is
 * a boundary artifact, not a lost payout, so a shortfall inside `tolerance` is
 * still "confirmed" — crying wolf on an off-by-one would train the operator to
 * ignore the one that matters. A material shortfall is reported honestly but
 * NOT as red: the window really is approximate, and "investigate" is the true
 * instruction, not "settlement is down".
 */
/** How far the real span may drift from the target before we distrust it. */
const WINDOW_FIT_TOLERANCE = 0.2;

/**
 * Does the configured block lookback actually span the period it is compared
 * against? PURE — the measurement is injected, so the boundary is testable.
 *
 * Reports on the INSTRUMENT, never on the money. "suspect" means this probe may
 * be misconfigured; it never means a payout failed.
 */
export function decideWindowFit(input: {
  /** Measured seconds per block; null when the chain could not be sampled. */
  blockSeconds: number | null;
  lookbackBlocks: number;
  /** The period the count is compared against — settled24h ⇒ 24. */
  targetHours: number;
}): WindowFit {
  if (input.blockSeconds === null || !Number.isFinite(input.blockSeconds) || input.blockSeconds <= 0) {
    return {
      status: "unknown",
      // Unmeasured is NOT "fine". Say we could not check rather than implying a pass.
      detail: "block time not measured — window fit unchecked",
      blockSeconds: null,
      spanHours: null,
    };
  }
  const spanHours = (input.lookbackBlocks * input.blockSeconds) / 3600;
  const ratio = spanHours / input.targetHours;
  const blockSeconds = Number(input.blockSeconds.toFixed(3));
  const span = Number(spanHours.toFixed(1));
  if (Math.abs(ratio - 1) <= WINDOW_FIT_TOLERANCE) {
    return {
      status: "ok",
      detail: `window spans ~${span}h at ${blockSeconds}s/block (target ${input.targetHours}h)`,
      blockSeconds,
      spanHours: span,
    };
  }
  // Short is the dangerous direction: it under-counts and manufactures a
  // shortfall. Long merely over-counts, which decidePayoutEvidence reads as
  // "confirmed". Name the direction so the fix is obvious.
  const suggested = Math.round((input.targetHours * 3600) / input.blockSeconds);
  return {
    status: "suspect",
    detail: `window spans ~${span}h at a measured ${blockSeconds}s/block, not the ${input.targetHours}h it is compared against — ${
      ratio < 1 ? "too SHORT, which under-counts payouts" : "longer than the comparison period"
    }; ~${suggested} blocks would match`,
    blockSeconds,
    spanHours: span,
  };
}

/**
 * Measure seconds per block from two real block timestamps.
 *
 * Never throws and never guesses: any failure returns null, which
 * decideWindowFit reports as "unchecked" rather than as a pass.
 */
export async function measureBlockSeconds(input: {
  rpcUrl?: string;
  sampleBlocks: number;
  fetchImpl: typeof fetch;
}): Promise<number | null> {
  if (!input.rpcUrl || input.sampleBlocks <= 0) return null;
  try {
    const head = Number(BigInt(await ethRpc(input.rpcUrl, "eth_blockNumber", [], input.fetchImpl)));
    const earlier = Math.max(0, head - input.sampleBlocks);
    if (earlier >= head) return null;
    const [a, b] = await Promise.all([
      blockTimestamp(input.rpcUrl, head, input.fetchImpl),
      blockTimestamp(input.rpcUrl, earlier, input.fetchImpl),
    ]);
    if (a === null || b === null || a <= b) return null;
    return (a - b) / (head - earlier);
  } catch {
    return null;
  }
}

async function blockTimestamp(rpcUrl: string, block: number, fetchImpl: typeof fetch): Promise<number | null> {
  const raw = await ethRpcRaw(rpcUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false], fetchImpl);
  const ts = (raw as { timestamp?: unknown } | null)?.timestamp;
  if (typeof ts !== "string") return null;
  const parsed = Number(BigInt(ts));
  return Number.isFinite(parsed) ? parsed : null;
}

export function decidePayoutEvidence(input: {
  confirmedCount: number | null;
  confirmedUsdc: number | null;
  settledCount: number | null;
  windowBlocks: number | null;
  tolerance: number;
  unverifiedReason?: string;
  /** Whether the block window really spans the comparison period. */
  window?: WindowFit;
}): PayoutEvidence {
  const base = {
    confirmedCount: input.confirmedCount,
    confirmedUsdc: input.confirmedUsdc,
    settledCount: input.settledCount,
    windowBlocks: input.windowBlocks,
    ...(input.window ? { window: input.window } : {}),
  };
  if (input.confirmedCount === null) {
    return {
      ...base,
      status: "unverified",
      detail: input.unverifiedReason ?? "payout evidence unverified",
    };
  }
  const paid = `${input.confirmedCount} payout${input.confirmedCount === 1 ? "" : "s"} confirmed on-chain${
    input.confirmedUsdc !== null ? ` (${input.confirmedUsdc.toFixed(2)} USDC)` : ""
  }`;
  if (input.settledCount === null) {
    // Real evidence, nothing to compare it against — say exactly that.
    return { ...base, status: "confirmed", detail: `${paid} · no settled count to compare` };
  }
  // A 100% miss is overwhelmingly a MISCONFIGURED FILTER, not 100% payout
  // failure: point this at the wrong address or topic and you observe exactly
  // zero events, which is indistinguishable from total failure. That is not
  // hypothetical, and it has now happened twice — first watching the signer EOA
  // instead of AgentAccountCore ("12 unaccounted for" on a live money board),
  // then watching for an ERC-20 Transfer the USDC precompile never emits. The
  // deployed event signature can also drift from the contract source (it has:
  // the live ReservationSettled carries a jobId the checked-in source lacks),
  // so a silent zero stays a question about the INSTRUMENT, not the money.
  // Refuse to accuse the money until the instrument has proven it can see
  // anything at all; one observed transfer is enough to trust it.
  if (input.confirmedCount === 0) {
    return {
      ...base,
      status: "unverified",
      detail: `no payout events found on the configured payout contract while ${input.settledCount} job${input.settledCount === 1 ? " is" : "s are"} marked settled — check the contract address and event topic before suspecting the payouts`,
    };
  }
  const shortfall = input.settledCount - input.confirmedCount;
  if (shortfall > input.tolerance) {
    // A shortfall computed over a window that does not span the comparison
    // period is not evidence about money — it is arithmetic on mismatched
    // units. This exact case shipped: a lookback sized for 6s blocks on a
    // ~2.1s chain covered 8h against a 24h settled count and would have posted
    // a permanent "12 unaccounted for" on a system paying every job. An
    // untrustworthy instrument SUPPRESSES the accusation; it never creates one.
    if (input.window?.status === "suspect") {
      return {
        ...base,
        status: "unverified",
        detail: `cannot compare: ${input.window.detail} — fix the window before reading ${shortfall} unaccounted for as a payout problem`,
      };
    }
    return {
      ...base,
      status: "shortfall",
      detail: `${input.settledCount} jobs marked settled but only ${paid} — ${shortfall} unaccounted for; windows are approximate, investigate`,
    };
  }
  return { ...base, status: "confirmed", detail: `${paid} · ${input.settledCount} marked settled` };
}

/**
 * Read AgentAccountCore `ReservationSettled` logs over a recent block window —
 * the on-chain record of a reward actually leaving the reward bank.
 *
 * Guarded the same way balances are (#543): logs are only trusted from an
 * endpoint on the product's chain, because a wrong-chain endpoint would return
 * a confident, wrong payout count. Any failure → null (unverified), never a
 * zero that would read as "nothing paid".
 */
export async function readPayoutTransfers(input: {
  rpcUrl?: string;
  /**
   * The contract that EMITS the payout event — AgentAccountCore, which is also
   * where the reward bank lives as an in-contract position (see #558). The
   * signer EOA merely sends the transaction and pays gas, so watching the
   * signer finds nothing and looks exactly like total payout failure — which is
   * precisely what it did on the first live run (12 settled, 0 found).
   */
  sourceAddress?: string;
  usdcAddress?: string;
  usdcDecimals: number;
  lookbackBlocks: number;
  expectedChainId?: number;
  fetchImpl: typeof fetch;
}): Promise<{ count: number | null; usdc: number | null; windowBlocks: number | null; reason?: string }> {
  if (!input.rpcUrl || !input.sourceAddress || !input.usdcAddress) {
    return {
      count: null, usdc: null, windowBlocks: null,
      reason: !input.sourceAddress
        ? "payout evidence not configured — no payout source address (/health addresses.agentAccountCore, or PRODUCT_HEALTH_PAYOUT_SOURCE_ADDRESS)"
        : "payout evidence not configured (RPC / USDC address)",
    };
  }
  try {
    if (input.expectedChainId !== undefined) {
      const actual = Number(BigInt(await ethRpc(input.rpcUrl, "eth_chainId", [], input.fetchImpl)));
      if (actual !== input.expectedChainId) {
        return {
          count: null, usdc: null, windowBlocks: null,
          reason: `payout evidence unverified — RPC is on chain ${actual}, product is on ${input.expectedChainId}`,
        };
      }
    }
    const latest = Number(BigInt(await ethRpc(input.rpcUrl, "eth_blockNumber", [], input.fetchImpl)));
    const fromBlock = Math.max(0, latest - input.lookbackBlocks);
    const logs = await ethRpcRaw(
      input.rpcUrl,
      "eth_getLogs",
      [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: "latest",
        // The CONTRACT THAT EMITS the payout event, not the token.
        address: input.sourceAddress,
        topics: [RESERVATION_SETTLED_TOPIC],
      }],
      input.fetchImpl,
    );
    if (!Array.isArray(logs)) {
      return { count: null, usdc: null, windowBlocks: null, reason: "payout evidence unverified — eth_getLogs returned no array" };
    }
    let total = 0n;
    let counted = 0;
    const wantAsset = input.usdcAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    for (const entry of logs) {
      const data = (entry as { data?: unknown }).data;
      // data[0] is the ASSET. Counting a DOT settlement as USDC would break the
      // unit invariant the same way the display math once did, so a payout in
      // another asset is skipped rather than folded into a USDC total.
      const asset = dataWord(data, 0);
      if (asset === undefined || asset.toLowerCase() !== wantAsset) continue;
      // data[1] is the AMOUNT. Reading the whole `data` as one integer — which
      // is right for a single-word Transfer — would be off by ~10^48 here.
      const amount = dataWord(data, 1);
      if (amount === undefined) continue;
      try {
        total += BigInt(`0x${amount}`);
        counted += 1;
      } catch {
        // A malformed value is not a reason to under-report the count.
        counted += 1;
      }
    }
    return {
      count: counted,
      usdc: Number(total) / 10 ** input.usdcDecimals,
      windowBlocks: latest - fromBlock,
    };
  } catch (error) {
    // Rate limit, capped range, dead endpoint — all unverified, never "0 paid".
    return {
      count: null, usdc: null, windowBlocks: null,
      reason: `payout evidence unverified — log read failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

// erc20 balanceOf(address) selector.
const BALANCE_OF_SELECTOR = "0x70a08231";

function encodeBalanceOf(address: string): string {
  return BALANCE_OF_SELECTOR + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// Protocol revenue = the fee treasury's AgentAccountCore *position*, not an
// ERC20 balanceOf. treasuryAccount() (0x339b2cff) is read off the live
// EscrowCore so the address is derived from chain, never hardcoded; then
// positions(treasury, USDC) (0x4bd21445) returns 6 words, [0] = liquid.
const TREASURY_ACCOUNT_SELECTOR = "0x339b2cff";
const POSITIONS_SELECTOR = "0x4bd21445";

function encodePositions(account: string, asset: string): string {
  const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return POSITIONS_SELECTOR + pad(account) + pad(asset);
}

/** Read the protocol-fee treasury's liquid USDC position (fees accrued). Best-effort:
 *  any failure returns undefined so the treasury probe still reports the rest. The
 *  address is derived from EscrowCore.treasuryAccount(), so it follows a contract
 *  cutover automatically. */
async function readProtocolRevenueUsdc(input: {
  rpcUrl: string;
  escrowCore?: string;
  agentAccountCore?: string;
  token?: string;
  usdcDecimals: number;
  fetchImpl: typeof fetch;
}): Promise<number | undefined> {
  if (!input.escrowCore || !input.agentAccountCore || !input.token) return undefined;
  try {
    const rawTreasury = await ethRpc(
      input.rpcUrl,
      "eth_call",
      [{ to: input.escrowCore, data: TREASURY_ACCOUNT_SELECTOR }, "latest"],
      input.fetchImpl,
    );
    if (!rawTreasury || rawTreasury.length < 66) return undefined;
    const treasury = "0x" + rawTreasury.slice(-40);
    if (/^0x0+$/.test(treasury)) return undefined;
    const rawPos = await ethRpc(
      input.rpcUrl,
      "eth_call",
      [{ to: input.agentAccountCore, data: encodePositions(treasury, input.token) }, "latest"],
      input.fetchImpl,
    );
    if (!rawPos || rawPos.length < 2 + 64) return undefined;
    const liquid = BigInt("0x" + rawPos.replace(/^0x/, "").slice(0, 64));
    return Number(liquid) / 10 ** input.usdcDecimals;
  } catch {
    return undefined;
  }
}

const NATIVE_GAS_SYMBOL_BY_CHAIN_ID = new Map<number, string>([
  [420420417, "PAS"],
  [420420419, "DOT"],
]);

function nativeGasSymbol(chainId: number | undefined): string {
  return chainId === undefined
    ? "native"
    : NATIVE_GAS_SYMBOL_BY_CHAIN_ID.get(chainId) ?? "native";
}

/** Signer solvency: native wallet gas + the in-contract reward bank.
 *
 * USDC intentionally lives in AgentAccountCore.positions[signer][USDC].liquid
 * after funding. Reading ERC-20 balanceOf(signer) here alarms on the wrong
 * number: it stays zero while payouts are healthy and does not fall when the
 * reward bank drains. The product already exposes the authoritative position as
 * /health.rewardBank.liquid, shared with treasury_liquidity below.
 */
export async function probeSignerLiquidity(input: {
  rpcUrl?: string;
  signerAddress?: string;
  rewardBankLiquid?: number;
  minGasNative: number;
  minRewardBank: number;
  /** The chainId `/health` reports. When set, the RPC must agree before we trust
   *  any balance it returns (chain guard below). */
  expectedChainId?: number;
  fetchImpl: typeof fetch;
}): Promise<ProbeResult & { pools?: SolvencyPoolData[]; rpcOk?: boolean }> {
  if (!input.rpcUrl || !input.signerAddress) {
    // Name the missing piece: at a network cutover this is the difference between
    // "monitor is fine" and "solvency has been unmonitored since the flip".
    return {
      name: "signer_liquidity",
      status: "degraded",
      detail: !input.rpcUrl
        ? "PRODUCT_HEALTH_RPC_URL not set (no built-in default outside testnet)"
        : "PRODUCT_HEALTH_SIGNER_ADDRESS not set",
    };
  }
  try {
    // CHAIN GUARD — mirrors chainBlockAge: never report a balance from an endpoint
    // that isn't on the product's chain. Without it, a leftover testnet endpoint
    // (a stale PRODUCT_HEALTH_RPC_BACKUPS entry, or a failover onto one) reads the
    // TESTNET signer and paints solvency GREEN while the mainnet signer is dry.
    // `rpcOk: false` also drives the failover loop, so a mismatched endpoint is
    // rotated past and ultimately escalated to a human rather than trusted.
    if (input.expectedChainId !== undefined) {
      const actualChainId = Number(BigInt(await ethRpc(input.rpcUrl, "eth_chainId", [], input.fetchImpl)));
      if (actualChainId !== input.expectedChainId) {
        return {
          name: "signer_liquidity",
          // Same escalation rule as chainHaltStatus: being blind on mainnet pages.
          status: MAINNET_CHAIN_IDS.has(input.expectedChainId) ? "red" : "degraded",
          detail: `RPC chain mismatch — endpoint is on chain ${actualChainId}, product is on ${input.expectedChainId}; balances NOT trusted`,
          rpcOk: false,
        };
      }
    }
    const gasWei = BigInt(await ethRpc(input.rpcUrl, "eth_getBalance", [input.signerAddress, "latest"], input.fetchImpl));
    const gasNative = Number(gasWei) / 1e18;
    const gasUnit = nativeGasSymbol(input.expectedChainId);
    const parts: string[] = [];
    let red = false;
    let degraded = false;

    const gasPart = `gas ${gasNative.toFixed(4)} ${gasUnit}`;
    if (input.minGasNative > 0 && gasNative < input.minGasNative) {
      red = true;
      parts.push(`${gasPart} < ${input.minGasNative}`);
    } else {
      parts.push(gasPart);
    }

    if (input.rewardBankLiquid === undefined) {
      degraded = true;
      parts.push("reward bank unreadable");
    } else {
      const rewardPart = `reward bank ${input.rewardBankLiquid.toFixed(2)} USDC`;
      if (input.minRewardBank > 0 && input.rewardBankLiquid < input.minRewardBank) {
        red = true;
        parts.push(`${rewardPart} < ${input.minRewardBank}`);
      } else {
        parts.push(rewardPart);
      }
    }

    const pools: SolvencyPoolData[] = [
      {
        key: "signer_gas",
        label: "Signer gas",
        amount: gasNative,
        unit: gasUnit,
        floor: input.minGasNative > 0 ? input.minGasNative : null,
        status: input.minGasNative > 0 && gasNative < input.minGasNative ? "red" : "ok",
      },
    ];
    if (input.rewardBankLiquid !== undefined) {
      pools.push({
        key: "reward_bank",
        label: "Reward bank",
        amount: input.rewardBankLiquid,
        unit: "USDC",
        floor: input.minRewardBank > 0 ? input.minRewardBank : null,
        status: input.minRewardBank > 0 && input.rewardBankLiquid < input.minRewardBank ? "red" : "ok",
      });
    }

    return {
      name: "signer_liquidity",
      status: red ? "red" : degraded ? "degraded" : "ok",
      detail: parts.join(", "),
      pools,
      rpcOk: true,
    };
  } catch (err) {
    // The direct RPC read itself failed (timeout / 1006 / bad endpoint) — distinct
    // from a low balance. rpcOk:false is the auto-remediation failover signal.
    return { name: "signer_liquidity", status: "degraded", detail: `balance read failed: ${errMsg(err)}`, rpcOk: false };
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
  treasuryReserveZeroReason?: string;
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
    let degraded = false;
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
    if (input.minTreasuryReserve === 0) {
      if (input.treasuryReserveZeroReason) {
        if (reserve !== undefined) {
          parts.push(
            `reserve ${reserve.toFixed(2)} (intentionally unfunded: ${input.treasuryReserveZeroReason})`,
          );
        }
      } else {
        degraded = true;
        if (reserve !== undefined) {
          parts.push(`reserve ${reserve.toFixed(2)} (floor disabled without a declared reason)`);
        }
      }
    } else {
      withFloor("reserve", reserve, input.minTreasuryReserve);
    }
    withFloor("AAC", aac, input.minAac);
    if (escrow !== undefined) parts.push(`escrow ${escrow.toFixed(2)}`); // in-flight — informational, no floor

    const pools: SolvencyPoolData[] = [];
    const pool = (
      key: string,
      label: string,
      val: number | undefined,
      floor: number,
      note?: string,
    ): void => {
      if (val === undefined) return;
      pools.push({
        key,
        label,
        amount: val,
        unit: "USDC",
        floor: floor > 0 ? floor : null,
        status: floor > 0 && val < floor ? "red" : "ok",
        ...(note ? { note } : {}),
      });
    };
    pool("reward_bank", "Reward bank", input.rewardBankLiquid, input.minRewardBank);
    pool(
      "reserve",
      "Treasury reserve",
      reserve,
      input.minTreasuryReserve,
      input.minTreasuryReserve === 0
        ? input.treasuryReserveZeroReason
          ? `Intentionally unfunded: ${input.treasuryReserveZeroReason}`
          : "Floor disabled without a declared reason"
        : undefined,
    );
    pool("aac", "Agent core", aac, input.minAac);
    if (escrow !== undefined) pools.push({ key: "escrow", label: "Escrow (in-flight)", amount: escrow, unit: "USDC", status: "ok", informational: true });

    // Protocol revenue — the 5% poster-side fee accrued in the treasury
    // multisig's position. Internal ops metric (Hermes-only); informational, no
    // floor. Omitted entirely if unreadable — never shown as a fake zero, since
    // a zero here is a real "no fees yet" statement.
    const protocolRevenue = await readProtocolRevenueUsdc({
      rpcUrl: input.rpcUrl,
      escrowCore: a.escrowCore,
      agentAccountCore: a.agentAccountCore,
      token: a.token,
      usdcDecimals: input.usdcDecimals,
      fetchImpl: input.fetchImpl,
    });
    if (protocolRevenue !== undefined) {
      pools.push({
        key: "protocol_revenue",
        label: "Protocol revenue (fees)",
        amount: protocolRevenue,
        unit: "USDC",
        status: "ok",
        informational: true,
        note: "5% poster-side fee, held under the 2-of-3 treasury",
      });
      parts.push(`revenue ${protocolRevenue.toFixed(2)}`);
    }

    if (parts.length === 0) return { name, status: "degraded", detail: "no treasury balances readable" };
    return { name, status: red ? "red" : degraded ? "degraded" : "ok", detail: parts.join(", "), pools };
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
  /** Operator-declared context for a deliberately unfloored pool. */
  note?: string;
}
export interface SolvencySnapshotData {
  pools: SolvencyPoolData[];
  runwayNote?: string | null;
  /** Per-pool time-to-floor projection — drives the pre-floor ops suggestion. */
  runway?: LiquidityRunwayPool[];
}
export interface MoneyPathData {
  claimed24h?: number | null;
  submitted24h?: number | null;
  claimedNotSubmitted?: number | null;
  submittedNotSettled?: number | null;
  settled24h?: number | null;
  stuck?: number | null;
  failed24h?: number | null;
  asOf?: number | null;
  /** Independent on-chain proof that the settled jobs actually PAID. */
  payout?: PayoutEvidence;
}

/**
 * Evidence that rewards were actually PAID, not merely marked settled.
 *
 * `settled24h` and friends are job-state counts from the product's own
 * database — "13 rows say settled". That is not proof any money moved. This
 * reads USDC Transfer logs FROM the signer straight off the chain, so the two
 * numbers come from independent sources, and THE DISCREPANCY IS THE SIGNAL:
 * matching → genuinely paid; fewer transfers than settled jobs → jobs marked
 * settled that never paid, which nothing else on the board can currently see.
 *
 * `confirmedCount: null` means UNVERIFIED (disabled, unconfigured, or the log
 * read failed). It never falls back to inferring payment from job state.
 */
export interface PayoutEvidence {
  status: "confirmed" | "shortfall" | "unverified";
  detail: string;
  /** Transfers observed on-chain in the window; null = unverified. */
  confirmedCount: number | null;
  /** Summed USDC actually transferred; null = unverified. */
  confirmedUsdc: number | null;
  /** The product's own settled count, for the comparison. */
  settledCount: number | null;
  /** Blocks scanned. The window is approximate — the verdict allows for it. */
  windowBlocks: number | null;
  /** Does the block window actually span what it is compared against? */
  window?: WindowFit;
}

/**
 * Whether the configured block lookback really covers the period it is being
 * compared to — checked against MEASURED block time, not an assumed one.
 *
 * This exists because the assumption was wrong in production: the lookback was
 * sized "~24h at 6s/block" on a chain that runs at ~2.1s, so it spanned 8h26m
 * and made a fully-paying system look like it had 12 unaccounted payouts.
 * Nobody had measured the chain.
 */
export interface WindowFit {
  status: "ok" | "suspect" | "unknown";
  detail: string;
  /** Measured seconds per block; null when the chain could not be sampled. */
  blockSeconds: number | null;
  /** Hours the configured lookback actually spans at that rate. */
  spanHours: number | null;
}

/** Structured reading behind the chain_height probe — drives the board's block
 *  ticker (TopStrip, beside the clock). Emitted only when the product /health
 *  reported a real height this cycle; absent otherwise, so the ticker renders
 *  awaiting-data instead of a number nobody observed. */
export interface ChainTickData {
  /** Block height as reported by the product's /health this cycle. */
  height: number;
  /** Epoch ms when this cycle observed that height (server clock). */
  observedAtMs: number;
  /** Age (s) of the latest block per the chain-matched RPC at observation;
   *  null = RPC absent/mismatched (UI falls back to lastAdvanceAtMs). */
  blockAgeSec?: number | null;
  /** Epoch ms when the cross-poll tracker last saw the height advance. */
  lastAdvanceAtMs?: number | null;
  /** The chain_height probe's freshness window (s). The UI's stale threshold
   *  reads this so producer config stays the single authority. */
  freshSeconds?: number;
}

export interface ProductHealthSnapshotBlocks {
  chainId?: number | null;
  /**
   * The MONITOR's own version. Deliberately NOT a probe: a stale monitor is not
   * a degraded product, and folding it into the probe list would flip the board
   * (and the phone headline) to degraded over a fact about ourselves.
   */
  self?: SelfFreshness;
  network?: "testnet" | "mainnet" | "unknown";
  chain?: ChainTickData;
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
  /** Did the direct read RPC respond this cycle? true/false/undefined(=can't judge).
   *  The auto-remediation failover signal. */
  rpcOk?: boolean;
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
  chainCtx: {
    advance?: ChainAdvance;
    nowMs: number;
    previousSubmittedNotSettled?: number | null;
  } = { nowMs: 0 },
): Promise<ProductHealthCollection> {
  const h = await fetchProductHealth({
    baseUrl: config.apiBaseUrl,
    healthPath: config.apiHealthPath,
    fetchImpl,
  });
  const chainId = h.body?.auth?.chainId;
  const rewardBankLiquid = pickNum(h.body?.rewardBank?.liquid);
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
    rewardBankLiquid,
    minGasNative: config.minGasNative,
    minRewardBank: config.minRewardBank,
    // Balances are only trusted from an RPC on the product's own chain.
    expectedChainId: chainId,
    fetchImpl,
  });
  const treasury = await probeTreasuryLiquidity({
    addresses: h.body?.addresses,
    rewardBankLiquid,
    usdcDecimals: config.usdcDecimals,
    minRewardBank: config.minRewardBank,
    minTreasuryReserve: config.minTreasuryReserve,
    treasuryReserveZeroReason: config.treasuryReserveZeroReason,
    minAac: config.minAac,
    rpcUrl: config.rpcUrl,
    fetchImpl,
  });
  // signer_liquidity and treasury_liquidity intentionally share the same
  // /health reward-bank position. Keep one board row while retaining both
  // independently actionable probes. The direct /health row is added last so
  // RPC-only gas/treasury failures cannot erase reward-bank data the product
  // already supplied; absent /health data still remains honestly absent.
  const rewardBankPool: SolvencyPoolData[] =
    rewardBankLiquid === undefined
      ? []
      : [
          {
            key: "reward_bank",
            label: "Reward bank",
            amount: rewardBankLiquid,
            unit: "USDC",
            floor: config.minRewardBank > 0 ? config.minRewardBank : null,
            status:
              config.minRewardBank > 0 && rewardBankLiquid < config.minRewardBank ? "red" : "ok",
          },
        ];
  const solvencyPools = [
    ...new Map(
      [...(signer.pools ?? []), ...(treasury.pools ?? []), ...rewardBankPool].map((pool) => [
        pool.key,
        pool,
      ]),
    ).values(),
  ];
  const settlement = h.body?.settlement;
  // Independent proof that the settled jobs actually PAID. Opt-in: the log read
  // is rate-limit sensitive, so while it's off the block stays honestly
  // "unverified" rather than reporting a zero that would read as nothing-paid.
  const payoutRead = config.payoutEvidenceEnabled
    ? await readPayoutTransfers({
        rpcUrl: config.rpcUrl,
        // USDC leaves AgentAccountCore, not the signer EOA — the reward bank is
        // an in-contract position and the signer only sends the tx (#558).
        sourceAddress: config.payoutSourceAddress || h.body?.addresses?.agentAccountCore,
        usdcAddress: config.usdcAddress,
        usdcDecimals: config.usdcDecimals,
        lookbackBlocks: config.payoutLookbackBlocks,
        expectedChainId: chainId,
        fetchImpl,
      })
    : { count: null, usdc: null, windowBlocks: null, reason: "payout evidence off (set PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED=true)" };
  // Check the INSTRUMENT against the chain, not against an assumption. The
  // lookback is compared to settled24h, so it has to actually span 24h at the
  // chain's real block time — an assumed one has already been wrong in prod.
  const windowFit = config.payoutEvidenceEnabled
    ? decideWindowFit({
        blockSeconds: await measureBlockSeconds({
          rpcUrl: config.rpcUrl,
          sampleBlocks: PAYOUT_BLOCK_TIME_SAMPLE,
          fetchImpl,
        }),
        lookbackBlocks: config.payoutLookbackBlocks,
        targetHours: PAYOUT_COMPARISON_HOURS,
      })
    : undefined;
  const payout = decidePayoutEvidence({
    confirmedCount: payoutRead.count,
    confirmedUsdc: payoutRead.usdc,
    settledCount: settlement?.settled24h ?? null,
    windowBlocks: payoutRead.windowBlocks,
    tolerance: config.payoutTolerance,
    ...(payoutRead.reason ? { unverifiedReason: payoutRead.reason } : {}),
    ...(windowFit ? { window: windowFit } : {}),
  });
  // The monitor's own version. Degraded-safe: any failure is "unknown", which
  // must never render as up to date.
  const selfFreshness = await deriveSelfFreshnessProbe({
    ...(config.selfRepo ? { repo: config.selfRepo } : {}),
    ...(config.selfSha ? { runningSha: config.selfSha } : {}),
    ...(config.selfGithubToken ? { token: config.selfGithubToken } : {}),
    ...(config.githubApiBaseUrl ? { baseUrl: config.githubApiBaseUrl } : {}),
    nowMs: chainCtx.nowMs,
    fetchImpl,
  });
  const snapshot: ProductHealthSnapshotBlocks = {
    chainId: chainId ?? null,
    ...(selfFreshness.selfFreshness ? { self: selfFreshness.selfFreshness } : {}),
    network: resolveProductHealthNetwork(chainId),
    // Block ticker data — same values the chain_height probe judged this cycle,
    // structured instead of embedded in the detail string. Only emitted when a
    // real height was observed (never a placeholder number).
    ...(block !== undefined && block > 0
      ? {
          chain: {
            height: block,
            observedAtMs: chainCtx.nowMs,
            blockAgeSec: blockAgeSec ?? null,
            lastAdvanceAtMs: chainAdvance.lastAdvanceAtMs,
            freshSeconds: config.chainMaxStaleSeconds,
          },
        }
      : {}),
    ...(solvencyPools.length ? { solvency: { pools: solvencyPools } } : {}),
    ...(settlement
      ? {
          flow: {
            claimed24h: settlement.claimed24h ?? null,
            submitted24h: settlement.submitted24h ?? null,
            claimedNotSubmitted: settlement.claimedNotSubmitted ?? null,
            submittedNotSettled: settlement.submittedNotSettled ?? null,
            settled24h: settlement.settled24h ?? null,
            stuck: settlement.stuck ?? null,
            failed24h: settlement.failed24h ?? null,
            asOf: parseHealthAsOf(settlement.asOf),
            payout,
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
      // The pillar nobody was watching. A full disk is a CORRELATED failure —
      // it takes the monitor, the money board and the alert path together, so
      // the thing meant to warn you dies with the thing it watches.
      decideDiskHeadroom({
        usage: readDiskUsage(config.diskPath),
        minFreeGb: config.minDiskFreeGb,
        warnFreeGb: config.warnDiskFreeGb,
      }),
      deriveMoneyPathProbe(h, {
        maxStuck: config.maxStuck,
        maxFailed24h: config.maxFailed24h,
        maxStaleMinutes: config.settlementMaxStaleMinutes,
        nowMs: chainCtx.nowMs,
        previousSubmittedNotSettled: chainCtx.previousSubmittedNotSettled,
      }),
      treasury,
    ],
    chainAdvance,
    snapshot,
    latencyMs: h.latencyMs,
    rpcOk: signer.rpcOk,
  };
}

/**
 * Is the MONITOR itself current? It reported on everything but its own version
 * until the VPS was found six commits behind with four merged PRs live nowhere.
 *
 * "behind" is DEGRADED, never red: stale code is not an outage, and colouring
 * it as one would be the false-alarm that gets scrolled past. "unknown" is a
 * real third state — it must never render as up to date.
 */
async function deriveSelfFreshnessProbe(input: {
  repo?: string;
  runningSha?: string;
  token?: string;
  baseUrl?: string;
  nowMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ selfFreshness: SelfFreshness }> {
  const sha = input.runningSha ?? null;
  if (!input.repo) {
    const verdict = decideSelfFreshness({ runningSha: sha, compare: null, unknownReason: "no repo configured", nowMs: input.nowMs });
    return { selfFreshness: verdict };
  }
  const normalized = (sha ?? "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") {
    const verdict = decideSelfFreshness({ runningSha: null, compare: null, nowMs: input.nowMs });
    return { selfFreshness: verdict };
  }
  const { compare, reason } = await fetchSelfCompare({
    repo: input.repo,
    runningSha: normalized,
    ...(input.token ? { token: input.token } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    fetchFn: input.fetchImpl,
  });
  const verdict = decideSelfFreshness({
    runningSha: normalized,
    compare,
    ...(reason ? { unknownReason: reason } : {}),
    nowMs: input.nowMs,
  });
  return { selfFreshness: verdict };
}

// ── Alert rendering (reuses the D4 AlertPayload) ────────────────────

/** Probes whose failure is a MONEY failure — these lead the page. */
const MONEY_PROBE_NAMES = new Set(["money_path", "signer_liquidity", "treasury_liquidity", "chain_height"]);

export function buildProductHealthAlert(
  evaluation: ProductHealthEvaluation,
  boardUrl: string,
  snapshot?: ProductHealthSnapshotBlocks,
): AlertPayload {
  // Money first. A red api_latency and a red money_path used to render
  // identically, so the thing that costs money could sit below the thing that
  // costs milliseconds.
  const ordered = [...evaluation.redProbes].sort(
    (a, b) => Number(MONEY_PROBE_NAMES.has(b.name)) - Number(MONEY_PROBE_NAMES.has(a.name)),
  );
  const money = decideMoneyAlert(snapshot);
  const probeLines = ordered.map((p) => `• 🔴 ${p.name}: ${p.detail}`);
  const lines = [...money.lines, ...probeLines];
  const count = evaluation.redProbes.length + money.lines.length;
  const head =
    count === 1 ? "1 money-blocking signal" : `${count} money-blocking signals`;
  const provenance = alertProvenance(snapshot);
  const text = [
    `:rotating_light: Averray product health — ${head}`,
    ...lines,
    `Inspect: ${boardUrl}`,
    ...(provenance ? [provenance] : []),
  ].join("\n");
  return { count, items: [], boardUrl, text };
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
  /** Snapshot blocks, so a money signal that is not a probe can still page. */
  snapshot?: ProductHealthSnapshotBlocks;
}): { alert: boolean; state: ProductHealthAlertState } {
  const money = decideMoneyAlert(input.snapshot);
  // A payout shortfall is not a probe, so it never reached this gate: the
  // system could see "14 settled, 2 confirmed" and stay silent. Fold it in so
  // it pages on its own, and so a CHANGE in the gap re-pages.
  const key = [redProbeKey(input.evaluation), money.key].filter(Boolean).join("|");
  const worthPaging = input.evaluation.status === "red" || money.key !== "";
  if (!worthPaging || key === "") {
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
  /**
   * The snapshot blocks for this cycle. Carries the money signals that are NOT
   * probes (payout evidence) and the monitor's own version, so a page can fire
   * on a shortfall and can state which build it speaks for.
   */
  getSnapshot?: () => ProductHealthSnapshotBlocks | undefined;
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
  const snapshot = deps.getSnapshot?.();
  const { alert, state } = decideProductHealthAlert({
    evaluation,
    state: deps.getAlertState(),
    nowMs: deps.nowMs(),
    cooldownMs: deps.cooldownMs,
    ...(snapshot ? { snapshot } : {}),
  });
  deps.setAlertState(state);
  let alerted = false;
  if (alert) {
    await deps.alert(buildProductHealthAlert(evaluation, deps.boardUrl, snapshot));
    alerted = true;
  }
  return { status: evaluation.status, evaluation, alerted };
}
