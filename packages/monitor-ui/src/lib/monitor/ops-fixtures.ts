// Ops surface fixtures — realistic ProductHealth snapshots for the dev preview
// entry and the component tests. Deterministic (built against FIXTURE_NOW, no
// Date.now) so the same data drives both. Three states:
//
//   OPS_FIXTURE_LIVE       today's reality — 7 probes, chain degraded, but the
//                          solvency/flow/history blocks ABSENT → awaiting-data
//                          zones (what the live board shows until the backend PR)
//   OPS_FIXTURE_POPULATED  every block wired → the full filled look
//   OPS_FIXTURE_RED        a mainnet page-worthy incident → soft-banner / auto-flip

import type {
  ProductHealth,
  ProductHealthProbe,
  ProbeStatus,
  SolvencyPool,
  OpsIncident,
} from "./product-health.js";

export const FIXTURE_NOW = 1_751_500_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;

function spark(status: ProbeStatus, len = 24): ProbeStatus[] {
  return Array.from({ length: len }, () => status);
}

const P = {
  productApi: {
    name: "product_api",
    status: "ok",
    detail: "200 · chain 420420417 · serviceHealth ok",
    sparkline: spark("ok"),
  },
  chainHeight: {
    name: "chain_height",
    status: "degraded",
    detail: "chain not advancing — last block 3d 20h old (block #10,612,201)",
    sparkline: spark("degraded"),
  },
  signerLiquidity: {
    name: "signer_liquidity",
    status: "ok",
    detail: "gas 4999.99 PAS · USDC 2.00 (floor 1.00)",
    sparkline: spark("ok"),
  },
  capabilities: {
    name: "capabilities",
    status: "ok",
    detail: "2/5 up · 3 acknowledged warnings",
    sparkline: spark("ok"),
  },
  apiLatency: {
    name: "api_latency",
    status: "ok",
    detail: "/health 114 ms",
    sparkline: spark("ok"),
  },
} satisfies Record<string, ProductHealthProbe>;

const AWAITING_MONEY_PATH: ProductHealthProbe = {
  name: "money_path",
  status: "degraded",
  detail: "awaiting /health settlement counts",
  sparkline: spark("degraded"),
};
const AWAITING_TREASURY: ProductHealthProbe = {
  name: "treasury_liquidity",
  status: "degraded",
  detail: "awaiting /health addresses",
  sparkline: spark("degraded"),
};

// ── today's reality — structured blocks absent → the money zones await data ──
export const OPS_FIXTURE_LIVE: ProductHealth = {
  enabled: true,
  at: FIXTURE_NOW - 24_000,
  status: "degraded",
  checks: 812,
  chainId: 420420417,
  network: "testnet",
  probes: [
    P.productApi,
    P.chainHeight,
    P.signerLiquidity,
    P.capabilities,
    P.apiLatency,
    AWAITING_MONEY_PATH,
    AWAITING_TREASURY,
  ],
};

// ── fully wired — every zone has real data ───────────────────────────────────
const SOLVENCY_POOLS: SolvencyPool[] = [
  { key: "signer_usdc", label: "Signer USDC", amount: 2.0, unit: "USDC", floor: 1.0, status: "degraded" },
  { key: "signer_gas", label: "Signer gas", amount: 4999.99, unit: "PAS", floor: 50, status: "ok" },
  { key: "reward_bank", label: "Reward bank", amount: 184.5, unit: "USDC", floor: 25, status: "ok" },
  { key: "aac", label: "Agent core", amount: 512.0, unit: "USDC", floor: 100, status: "ok" },
  { key: "reserve", label: "Treasury reserve", amount: 1240.0, unit: "USDC", floor: 250, status: "ok" },
  { key: "escrow", label: "Escrow (in-flight)", amount: 96.0, unit: "USDC", status: "ok", informational: true },
];

function ramp(len: number, fn: (i: number) => number): number[] {
  return Array.from({ length: len }, (_, i) => fn(i));
}

const INCIDENTS: OpsIncident[] = [
  {
    id: "chain-freeze-q3",
    probe: "chain_height",
    severity: "degraded",
    startedAt: FIXTURE_NOW - (3 * DAY + 20 * HOUR),
    endedAt: null,
    note: "Paseo testnet frozen for Q3 reset — degraded, not paging",
  },
  {
    id: "latency-blip",
    probe: "api_latency",
    severity: "degraded",
    startedAt: FIXTURE_NOW - (28 * HOUR),
    endedAt: FIXTURE_NOW - (27 * HOUR + 20 * MIN),
    note: "API latency spiked to 2.4s",
  },
];

export const OPS_FIXTURE_POPULATED: ProductHealth = {
  ...OPS_FIXTURE_LIVE,
  probes: [
    P.productApi,
    P.chainHeight,
    P.signerLiquidity,
    P.capabilities,
    P.apiLatency,
    { name: "money_path", status: "degraded", detail: "1 stuck · 0 failed 24h · 37 settled", sparkline: spark("ok") },
    { name: "treasury_liquidity", status: "ok", detail: "reserve 1240 · AAC 512 · reward 184.5 USDC", sparkline: spark("ok") },
  ],
  solvency: {
    pools: SOLVENCY_POOLS,
    runwayNote: "≈ 6 payouts to floor at today's burn",
  },
  flow: {
    claimed: 41,
    submitted: 39,
    settled24h: 37,
    stuck: 1,
    failed24h: 0,
    asOf: FIXTURE_NOW - 2 * MIN,
  },
  history: {
    uptimePct24h: 98.2,
    uptimeSeries: Array.from({ length: 48 }, (_, i) =>
      i === 11 || i === 30 ? "degraded" : ("ok" as ProbeStatus),
    ),
    latencySeriesMs: ramp(48, (i) => 92 + Math.round(26 * Math.abs(Math.sin(i / 3.1)))),
    balanceSeries: ramp(48, (i) => Number((2.62 - i * 0.013).toFixed(3))),
    incidents: INCIDENTS,
  },
};

// ── mainnet page-worthy — a fresh red the surface should auto-flip to ────────
export const OPS_FIXTURE_RED: ProductHealth = {
  ...OPS_FIXTURE_POPULATED,
  status: "red",
  chainId: 420420419,
  network: "mainnet",
  probes: [
    P.productApi,
    { name: "chain_height", status: "ok", detail: "block #9,481,204 · 3s old", sparkline: spark("ok") },
    { name: "signer_liquidity", status: "degraded", detail: "gas ok · USDC 0.80 (floor 1.00) — below floor", sparkline: spark("degraded") },
    P.capabilities,
    P.apiLatency,
    { name: "money_path", status: "red", detail: "6 stuck ≥ threshold — settlements not landing", sparkline: spark("red") },
    { name: "treasury_liquidity", status: "ok", detail: "reserve 1240 · AAC 512 · reward 184.5 USDC", sparkline: spark("ok") },
  ],
  flow: {
    claimed: 44,
    submitted: 42,
    settled24h: 30,
    stuck: 6,
    failed24h: 2,
    asOf: FIXTURE_NOW - 1 * MIN,
  },
  solvency: {
    pools: SOLVENCY_POOLS.map((p) =>
      p.key === "signer_usdc" ? { ...p, amount: 0.8, status: "red" } : p,
    ),
    runwayNote: "signer USDC below floor — top up before next payout",
  },
};
