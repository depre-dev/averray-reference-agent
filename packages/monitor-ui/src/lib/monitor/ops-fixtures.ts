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
    claimed24h: 41,
    submitted24h: 39,
    claimedNotSubmitted: 2,
    submittedNotSettled: 1,
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
    claimed24h: 44,
    submitted24h: 42,
    claimedNotSubmitted: 2,
    submittedNotSettled: 6,
    settled24h: 30,
    stuck: 6,
    failed24h: 2,
    asOf: FIXTURE_NOW - 1 * MIN,
  },
  solvency: {
    pools: SOLVENCY_POOLS.map((p) =>
      p.key === "reward_bank"
        ? { ...p, amount: 0.8, status: "red" }
        : p.key === "signer_gas"
          ? { ...p, unit: "DOT" }
          : p,
    ),
    runwayNote: "reward bank below floor — top up before next payout",
  },
};

// ── the two spec-sheet states, on real mainnet values ────────────────────────
//
// These are the board's reference renders (FIG. 1 / FIG. 2 of the design):
// NOMINAL is the all-day state, taken from a real 2026-07-31 mainnet reading.
// STRESS is the same board with a breached floor, a payout shortfall and a dead
// stream at once — the hierarchy has to hold under load, not only when green.

const MAINNET_POOLS: SolvencyPool[] = [
  { key: "signer_gas", label: "Signer gas", amount: 2.6931, unit: "DOT", floor: 1, status: "ok" },
  { key: "reward_bank", label: "Reward bank", amount: 15.89, unit: "USDC", floor: 2, status: "ok" },
  { key: "aac", label: "Agent core (AAC)", amount: 26.15, unit: "USDC", floor: 1, status: "ok" },
  // Deliberately unfunded, and it must never render as a full meter. The note is
  // the operator's own declaration of why the zero is correct.
  {
    key: "reserve",
    label: "Treasury reserve",
    amount: 0,
    unit: "USDC",
    status: "ok",
    note: "no floor — intentionally unfunded: payouts fund from the signer reward bank; the treasury multisig holds no USDC float",
  },
  {
    key: "escrow",
    label: "Escrow (in-flight)",
    amount: 0,
    unit: "USDC",
    status: "ok",
    informational: true,
    note: "informational — funds currently between claim and settlement",
  },
  {
    key: "revenue",
    label: "Protocol revenue",
    amount: 0.01,
    unit: "USDC",
    status: "ok",
    note: "5% poster-side fee · held under the 2-of-3 treasury multisig",
  },
];

const MAINNET_PROBES: ProductHealthProbe[] = [
  { name: "product_api", status: "ok", detail: "api.averray.com/health → 200 · chain 420420419", sparkline: spark("ok") },
  { name: "api_latency", status: "ok", detail: "/health 51 ms", sparkline: spark("ok") },
  { name: "disk_headroom", status: "ok", detail: "142.3 GiB free of 193 GiB (26% used)", sparkline: spark("ok") },
  { name: "chain_height", status: "ok", detail: "block #18,894,637 · chain 420420419", sparkline: spark("ok") },
  { name: "capabilities", status: "degraded", detail: "4/7 capabilities up · 2 warnings acknowledged", sparkline: spark("degraded") },
  { name: "signer_liquidity", status: "ok", detail: "gas 2.6931 DOT · reward bank 15.89 USDC", sparkline: spark("ok") },
  { name: "treasury_liquidity", status: "ok", detail: "reward 15.89 · reserve 0.00 · AAC 26.15 · escrow 0.00 · revenue 0.01", sparkline: spark("ok") },
  { name: "money_path", status: "ok", detail: "settled24h 9 (0 stuck · 0 failed)", sparkline: spark("ok") },
];

export const OPS_FIXTURE_NOMINAL: ProductHealth = {
  enabled: true,
  at: FIXTURE_NOW - 2_000,
  status: "degraded",
  checks: 1_284,
  chainId: 420420419,
  network: "mainnet",
  probes: MAINNET_PROBES,
  self: {
    status: "current",
    detail: "865942ef · current",
    runningSha: "865942ef2d1c4b7a9f30",
    behindBy: 0,
    oldestUnshippedAt: null,
  },
  remediation: {
    state: "armed",
    enabled: true,
    activeEndpoint: "rpc-1",
    onBackup: false,
    detail: "rpc-1 primary · failover armed",
  },
  solvency: { pools: MAINNET_POOLS },
  flow: {
    claimed24h: 9,
    submitted24h: 9,
    claimedNotSubmitted: 0,
    submittedNotSettled: 0,
    settled24h: 9,
    stuck: 0,
    failed24h: 0,
    asOf: FIXTURE_NOW - 90_000,
    payout: {
      status: "confirmed",
      detail: "14 confirmed · 1.70 USDC over 43200 blocks",
      confirmedCount: 14,
      confirmedUsdc: 1.7,
      settledCount: 14,
      windowBlocks: 43200,
      window: { status: "ok", detail: "43200 blocks ≈ 25.3h at 2.112s/block", blockSeconds: 2.112, spanHours: 25.3 },
    },
  },
  history: {
    uptimePct24h: 100,
    uptimeSeries: Array.from({ length: 48 }, () => "ok" as ProbeStatus),
    latencySeriesMs: ramp(48, (i) => 48 + Math.round(9 * Math.abs(Math.sin(i / 2.7)))),
    balanceSeries: ramp(48, () => 15.89),
    incidents: [],
  },
};

/**
 * FIG. 2 — floor breach + payout shortfall + dead stream, all at once.
 *
 * The funnel deliberately still reads a clean 9 → 9 → 9 while the chain can
 * only account for 12 of the 14 settled payouts. The board's job here is to put
 * those two numbers next to each other and name the gap.
 */
export const OPS_FIXTURE_STRESS: ProductHealth = {
  ...OPS_FIXTURE_NOMINAL,
  at: FIXTURE_NOW - 4 * MIN - 12_000,
  status: "red",
  probes: MAINNET_PROBES.map((p) =>
    p.name === "signer_liquidity"
      ? { ...p, status: "red" as ProbeStatus, detail: "gas 2.6931 DOT · reward bank 1.42 USDC — floor 2.00 breached" }
      : p,
  ),
  remediation: {
    state: "failover",
    enabled: true,
    activeEndpoint: "rpc-2",
    onBackup: true,
    detail: "rpc-2 active — failed over from rpc-1",
  },
  solvency: {
    pools: MAINNET_POOLS.map((p) =>
      p.key === "reward_bank" ? { ...p, amount: 1.42, status: "red" as ProbeStatus } : p,
    ),
  },
  flow: {
    ...OPS_FIXTURE_NOMINAL.flow,
    payout: {
      status: "shortfall",
      detail: "12 confirmed vs 14 settled over 43200 blocks",
      confirmedCount: 12,
      confirmedUsdc: 1.44,
      settledCount: 14,
      windowBlocks: 43200,
      window: { status: "ok", detail: "43200 blocks ≈ 25.3h at 2.112s/block", blockSeconds: 2.112, spanHours: 25.3 },
    },
  },
};

/**
 * The instrument is blind, the money may be perfectly fine. This must NOT look
 * like OPS_FIXTURE_STRESS — that distinction is the reason the fixture exists.
 */
export const OPS_FIXTURE_UNVERIFIED: ProductHealth = {
  ...OPS_FIXTURE_NOMINAL,
  flow: {
    ...OPS_FIXTURE_NOMINAL.flow,
    payout: {
      status: "unverified",
      detail: "chain log read failed — cannot compare against 14 settled",
      confirmedCount: null,
      confirmedUsdc: null,
      settledCount: 14,
      windowBlocks: null,
      window: { status: "unknown", detail: "block time not sampled", blockSeconds: null, spanHours: null },
    },
  },
};
