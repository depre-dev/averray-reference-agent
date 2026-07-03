// Product-health heartbeat — the first "watch the live PRODUCT, not the dev board" probe.
//
// A SERVER-SIDE routine (no tab open) that probes the LIVE product — is the
// Averray API up, is the chain advancing, is the signer solvent — and, on a RED
// probe, fires the SAME off-device alert bridge (D4) the dev board uses. It
// reuses the D3/D4 plane: pure `evaluateProductHealth` + effect-injected
// `runProductHealthOnce`, so detection + alerting unit-test with no fs/network.
//
// Chain/signer reads are raw JSON-RPC over an injected `fetch` (no viem dep in
// slack-operator; mockable in tests).
//
// TRUTH-BOUNDARY (the whole point): an UNCONFIGURED probe reports `degraded`,
// never a fake green; a CONFIGURED probe that trips its threshold reports `red`.
// Only `red` fires an alert. A probe that can't reach its dependency reports
// `degraded` (our own RPC/network hiccup must not page as a product outage).

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

// ── Config (env-driven; chain/liquidity stay degraded until their keys are set) ──

export interface ProductHealthConfig {
  apiBaseUrl?: string;
  apiHealthPath: string;
  rpcUrl?: string;
  /**
   * chain_height goes RED if the latest block is older than this many seconds —
   * a chain halt (blocks frozen) is a real settlement-down condition, not an RPC
   * hiccup. 0 disables the freshness check (height-only, the pre-halt-detect
   * behaviour). Env: PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS (default 600).
   */
  chainMaxStaleSeconds: number;
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

// Public Hub eth-rpc per network — so the monitor watches the SAME chain the
// product settles on, with zero duplicated config. `WALLET_NETWORK` (the signal
// the chain services already use) selects it; PRODUCT_HEALTH_RPC_URL overrides.
// Mainnet is intentionally absent until Codex confirms its endpoint — set
// PRODUCT_HEALTH_RPC_URL there. Testnet URL verified via docs.polkadot.com.
const NETWORK_ETH_RPC: Record<string, string> = {
  testnet: "https://testnet-passet-hub-eth-rpc.polkadot.io/",
};

/** Resolve the eth-rpc for the product's network (WALLET_NETWORK); testnet default. */
export function networkEthRpc(walletNetwork: string | undefined): string | undefined {
  return NETWORK_ETH_RPC[(walletNetwork || "testnet").toLowerCase()];
}

export function loadProductHealthConfig(env: NodeJS.ProcessEnv = process.env): ProductHealthConfig {
  const base = env.AVERRAY_API_BASE_URL;
  return {
    apiBaseUrl: base ? trimTrailingSlash(base) : undefined,
    apiHealthPath: env.PRODUCT_HEALTH_API_PATH || "/health",
    rpcUrl: env.PRODUCT_HEALTH_RPC_URL || networkEthRpc(env.WALLET_NETWORK),
    chainMaxStaleSeconds: num(env.PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS, 600),
    signerAddress: env.PRODUCT_HEALTH_SIGNER_ADDRESS || undefined,
    usdcAddress: env.PRODUCT_HEALTH_USDC_ADDRESS || undefined,
    usdcDecimals: num(env.PRODUCT_HEALTH_USDC_DECIMALS, 6),
    minGasNative: num(env.PRODUCT_HEALTH_MIN_GAS_NATIVE, 0),
    minUsdc: num(env.PRODUCT_HEALTH_MIN_USDC, 0),
  };
}

// ── Probes (each degraded-safe; fetch injected for testability) ──────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
}

/** Is the Averray product API answering? REAL as soon as AVERRAY_API_BASE_URL is set. */
export async function probeProductApi(input: {
  baseUrl?: string;
  healthPath: string;
  fetchImpl: typeof fetch;
}): Promise<ProbeResult> {
  if (!input.baseUrl) {
    return { name: "product_api", status: "degraded", detail: "AVERRAY_API_BASE_URL not configured" };
  }
  const url = joinUrl(input.baseUrl, input.healthPath);
  try {
    const res = await input.fetchImpl(url, { method: "GET", redirect: "follow" });
    return res.ok
      ? { name: "product_api", status: "ok", detail: `${url} → ${res.status}` }
      : { name: "product_api", status: "red", detail: `${url} → HTTP ${res.status}` };
  } catch (err) {
    return { name: "product_api", status: "red", detail: `${url} unreachable: ${errMsg(err)}` };
  }
}

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

/**
 * Chain reachable + producing FRESH blocks. Reads the latest block for both its
 * height and its timestamp: a halted chain (frozen block) still answers RPC, so a
 * height-only check stays green straight through a settlement-stopping halt. If the
 * latest block is older than `maxStaleSeconds`, that's RED (real product-down).
 * An RPC hiccup → degraded (not a product-down page).
 */
export async function probeChainHeight(input: {
  rpcUrl?: string;
  maxStaleSeconds?: number;
  fetchImpl: typeof fetch;
  now?: () => number;
}): Promise<ProbeResult> {
  if (!input.rpcUrl) {
    return { name: "chain_height", status: "degraded", detail: "PRODUCT_HEALTH_RPC_URL not configured" };
  }
  try {
    const block = (await ethRpcRaw(input.rpcUrl, "eth_getBlockByNumber", ["latest", false], input.fetchImpl)) as
      | { number?: string; timestamp?: string }
      | null;
    if (!block || typeof block.number !== "string") {
      return { name: "chain_height", status: "degraded", detail: "chain returned no latest block" };
    }
    const height = BigInt(block.number);
    if (height <= 0n) {
      return { name: "chain_height", status: "red", detail: "chain reports block 0" };
    }
    const maxStale = input.maxStaleSeconds ?? 0;
    if (maxStale > 0 && typeof block.timestamp === "string") {
      const nowSec = Math.floor((input.now?.() ?? Date.now()) / 1000);
      const ageSec = nowSec - Number(BigInt(block.timestamp));
      if (ageSec > maxStale) {
        return {
          name: "chain_height",
          status: "red",
          detail: `chain stalled: block #${height.toString()} last advanced ${Math.floor(ageSec / 60)}m ago (> ${Math.floor(maxStale / 60)}m)`,
        };
      }
      return { name: "chain_height", status: "ok", detail: `block #${height.toString()} (${Math.max(0, ageSec)}s ago)` };
    }
    return { name: "chain_height", status: "ok", detail: `block #${height.toString()}` };
  } catch (err) {
    return { name: "chain_height", status: "degraded", detail: `RPC unreachable: ${errMsg(err)}` };
  }
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

/** Build the real probe set from config, all sharing one injected fetch. */
export function buildProductHealthProbes(
  config: ProductHealthConfig,
  fetchImpl: typeof fetch = fetch,
): Array<() => Promise<ProbeResult>> {
  return [
    () => probeProductApi({ baseUrl: config.apiBaseUrl, healthPath: config.apiHealthPath, fetchImpl }),
    () => probeChainHeight({ rpcUrl: config.rpcUrl, maxStaleSeconds: config.chainMaxStaleSeconds, fetchImpl }),
    () =>
      probeSignerLiquidity({
        rpcUrl: config.rpcUrl,
        signerAddress: config.signerAddress,
        usdcAddress: config.usdcAddress,
        usdcDecimals: config.usdcDecimals,
        minGasNative: config.minGasNative,
        minUsdc: config.minUsdc,
        fetchImpl,
      }),
  ];
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
