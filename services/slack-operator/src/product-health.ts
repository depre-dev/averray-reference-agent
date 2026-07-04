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
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
  try {
    const res = await input.fetchImpl(url, { method: "GET", redirect: "follow" });
    let body: ProductHealthPayload | undefined;
    try {
      body = (await res.json()) as ProductHealthPayload;
    } catch {
      body = undefined;
    }
    return { configured: true, reachable: true, httpOk: res.ok, status: res.status, url, body };
  } catch (err) {
    return { configured: true, reachable: false, httpOk: false, status: 0, url, error: errMsg(err) };
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
}): Promise<ProbeResult> {
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

    if (input.usdcAddress) {
      const usdcRaw = await ethRpc(
        input.rpcUrl,
        "eth_call",
        [{ to: input.usdcAddress, data: encodeBalanceOf(input.signerAddress) }, "latest"],
        input.fetchImpl,
      );
      const usdc = Number(BigInt(usdcRaw || "0x0")) / 10 ** input.usdcDecimals;
      const usdcPart = `USDC ${usdc.toFixed(2)}`;
      if (input.minUsdc > 0 && usdc < input.minUsdc) {
        red = true;
        parts.push(`${usdcPart} < ${input.minUsdc}`);
      } else {
        parts.push(usdcPart);
      }
    }

    return { name: "signer_liquidity", status: red ? "red" : "ok", detail: parts.join(", ") };
  } catch (err) {
    return { name: "signer_liquidity", status: "degraded", detail: `balance read failed: ${errMsg(err)}` };
  }
}

// ── Collector: one /health fetch (api + chain) + the direct-RPC balance probe ──

export interface ProductHealthCollection {
  probes: ProbeResult[];
  /** Updated block-advance tracker — the caller persists it across ticks. */
  chainAdvance: ChainAdvance;
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
  return {
    probes: [deriveProductApiProbe(h), deriveChainProbe(h, staleness), signer],
    chainAdvance,
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
