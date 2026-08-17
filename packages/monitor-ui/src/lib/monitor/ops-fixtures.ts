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

// The three CONTRACT addresses are the real mainnet ones, taken from GET
// /health.addresses and each verified against the chain: balanceOf returns
// exactly the figure beside it here. A made-up hex would not exercise the
// wrapping that 42 real characters cause in a narrow panel, which is the layout
// risk this feature carries.
//
// The signer is a PLACEHOLDER of the right shape, and deliberately so. The real
// signer lives only in PRODUCT_HEALTH_SIGNER_ADDRESS on the box, and an earlier
// draft of this fixture used an address recalled from memory that turned out to
// hold zero DOT — a wrong address in a fixture is one copy-paste away from being
// a wrong address someone sends funds to.
const MAINNET_POOLS: SolvencyPool[] = [
  {
    key: "signer_gas",
    label: "Signer gas",
    amount: 2.6931,
    unit: "DOT",
    floor: 1,
    status: "ok",
    address: "0x00000000000000000000000000000000000f1x7e",
    addressLabel: "signer EOA",
  },
  // No address: this figure comes from the product's own /health, not a balance
  // read, so the row must show none rather than borrow the AAC's.
  { key: "reward_bank", label: "Reward bank", amount: 15.89, unit: "USDC", floor: 2, status: "ok" },
  {
    key: "aac",
    label: "Agent core (AAC)",
    amount: 26.15,
    unit: "USDC",
    floor: 1,
    status: "ok",
    address: "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57",
    addressSs58: "151MENb3J9ZiBv147yhNkPDiY8rXF7TrWc13PqWYJeLuupBd",
    addressLabel: "AgentAccountCore",
  },
  // Deliberately unfunded, and it must never render as a full meter. The note is
  // the operator's own declaration of why the zero is correct.
  {
    key: "reserve",
    label: "Treasury reserve",
    amount: 0,
    unit: "USDC",
    status: "ok",
    note: "no floor — intentionally unfunded: payouts fund from the signer reward bank; the treasury multisig holds no USDC float",
    address: "0x01e6eed856e989201f4ff6346e18eab7e46c874c",
    addressSs58: "13VefHVLFhdvis2hA75gVSrAR6psiRqaqBzFPdwxW6GG6aJ",
    addressLabel: "treasury reserve",
  },
  {
    key: "escrow",
    label: "Escrow (in-flight)",
    amount: 0,
    unit: "USDC",
    status: "ok",
    informational: true,
    note: "informational — funds currently between claim and settlement",
    address: "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC",
    addressSs58: "131meCLjePjUWf9dRC7RuhNcsGx9nHa1wasKVfy6u3M7mZBL",
    addressLabel: "EscrowCore",
  },
  {
    key: "protocol_revenue",
    label: "Protocol revenue — poster fees + gas retention",
    amount: 0.39,
    unit: "USDC",
    status: "ok",
    note: "external poster fees: 0.29 USDC · of which operator-self-paid: 0.10 USDC",
    address: "0x01e6eed856e989201f4ff6346e18eab7e46c874c",
    addressSs58: "13VefHVLFhdvis2hA75gVSrAR6psiRqaqBzFPdwxW6GG6aJ",
    addressLabel: "treasury multisig",
  },
];

const MAINNET_PROBES: ProductHealthProbe[] = [
  { name: "product_api", status: "ok", detail: "api.averray.com/health → 200 · chain 420420419", sparkline: spark("ok") },
  { name: "api_latency", status: "ok", detail: "/health 51 ms", sparkline: spark("ok") },
  { name: "disk_headroom", status: "ok", detail: "142.3 GiB free of 193 GiB (26% used)", sparkline: spark("ok") },
  { name: "chain_height", status: "ok", detail: "block #18,894,637 · chain 420420419", sparkline: spark("ok") },
  { name: "capabilities", status: "degraded", detail: "2/2 required up · xcmObserver staged, gasSponsor disabled (acknowledged) · external-posting watcher lag 160s", sparkline: spark("degraded") },
  { name: "signer_liquidity", status: "ok", detail: "gas 2.6931 DOT · reward bank 15.89 USDC", sparkline: spark("ok") },
  { name: "treasury_liquidity", status: "ok", detail: "reward 15.89 · reserve 0.00 · AAC 26.15 · escrow 0.00 · revenue 0.01", sparkline: spark("ok") },
  { name: "money_path", status: "ok", detail: "settled24h 9 (0 stuck · 0 failed)", sparkline: spark("ok") },
];

export const OPS_FIXTURE_NOMINAL: ProductHealth = {
  // The lane as it stands TODAY, on the v2.1 wrapper: leg 1 executed, 149,475
  // raw of asset 22 live at the converted account, and the position still
  // honestly unverified because leg 2 has not yet proven the aToken read path.
  //
  // Every figure here described the RETIRED v2.0 generation until 2026-08-04 —
  // 1.51 DOT at the old wrapper image, 149,412 at the old converted account —
  // under a comment claiming to be current. A fixture is documentation, and
  // this one was a small copy of the exact defect the lane spent that day
  // learning to detect.
  bank: {
    lane: {
      position: {
        status: "unverified" as const,
        raw: null,
        detail:
          "zero from erc20:0x2ec48840…acfa93.balanceOf(0x85663dfd…99f8f4), and this read path has never observed funds — not yet evidence of an empty position",
      },
      float: { text: "0.149475 USDC · 149,475 raw", tone: "ok" as const },
      // 0.3 DOT committed at the v2.1 arming, ~0.2697 after leg 1's delivery
      // fees. A far thinner cushion over the 0.07 floor than v2.0's 1.51
      // bought, which is the operationally interesting part of the repoint.
      postage: { text: "0.2697 DOT · 2,697,000,000 raw · committed postage, no withdraw path", tone: "ok" as const },
      requests: { text: "no requests in flight", tone: "ok" as const },
      overdueRequestId: null,
      // The honest state: the producer does not emit `subject`. It was dropped
      // from platform #932 rather than shipped weaker than specified — both
      // sides rendered from `contracts.xcmWrapper` in one pass, so they agreed
      // by construction and would have read green straight through the incident
      // that motivated the field. A real discriminator (the armed bit over the
      // append-only deployment history) is specced separately.
      subject: {
        text: "subject not declared by the feed — cannot confirm which wrapper generation these read",
        tone: "awaiting" as const,
      },
      tone: "degraded" as const,
    },
  },
  enabled: true,
  at: FIXTURE_NOW - 2_000,
  status: "degraded",
  checks: 1_284,
  checkIntervalMs: 2 * 60_000,
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
  // Configured and delivering — the state after the first real narration lands.
  buzz: { status: "ok", detail: "delivered 4m ago" },
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
      // A whole day read, with real texture: busy stretches and hours where
      // genuinely nothing paid out. Both are covered — a quiet hour observed
      // is a fact, and it must look different from an hour nobody read.
      byHour: {
        slices: [{ hoursAgo: 1, count: 0, covered: true }, { hoursAgo: 2, count: 1, covered: true }, { hoursAgo: 3, count: 0, covered: true }, { hoursAgo: 4, count: 2, covered: true }, { hoursAgo: 5, count: 1, covered: true }, { hoursAgo: 6, count: 0, covered: true }, { hoursAgo: 7, count: 0, covered: true }, { hoursAgo: 8, count: 1, covered: true }, { hoursAgo: 9, count: 3, covered: true }, { hoursAgo: 10, count: 0, covered: true }, { hoursAgo: 11, count: 1, covered: true }, { hoursAgo: 12, count: 0, covered: true }, { hoursAgo: 13, count: 2, covered: true }, { hoursAgo: 14, count: 0, covered: true }, { hoursAgo: 15, count: 1, covered: true }, { hoursAgo: 16, count: 0, covered: true }, { hoursAgo: 17, count: 0, covered: true }, { hoursAgo: 18, count: 2, covered: true }, { hoursAgo: 19, count: 0, covered: true }, { hoursAgo: 20, count: 1, covered: true }, { hoursAgo: 21, count: 0, covered: true }, { hoursAgo: 22, count: 0, covered: true }, { hoursAgo: 23, count: 1, covered: true }, { hoursAgo: 24, count: 0, covered: true }],
        total: 16, peak: 3, coveredHours: 24, blocksPerHour: 1704.5,
      },
    },
  },
  history: {
    uptimePct24h: 100,
    // A full window's worth — so the label reads a bare "uptime 100.0%". Drop
    // uptimeSpanMs below the window and it becomes "100.0% over 47m" instead.
    uptimeSamples: 48,
    uptimeSpanMs: 24 * 3_600_000,
    uptimeWindowMs: 24 * 3_600_000,
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
  // A breach opens an incident and leaves a balance trail — without both, the
  // phone's "SINCE" row correctly falls back to "start not recorded", which is
  // honest but never exercises the real path.
  history: {
    ...OPS_FIXTURE_NOMINAL.history,
    balanceSeries: [15.89, 12.4, 8.1, 4.02, 2.31, 1.42],
    seriesAt: [
      FIXTURE_NOW - 90 * MIN,
      FIXTURE_NOW - 75 * MIN,
      FIXTURE_NOW - 60 * MIN,
      FIXTURE_NOW - 45 * MIN,
      FIXTURE_NOW - 30 * MIN,
      FIXTURE_NOW - 10 * MIN,
    ],
    incidents: [
      {
        id: "reward-bank-floor",
        probe: "signer_liquidity",
        severity: "red",
        startedAt: FIXTURE_NOW - 14 * MIN,
        endedAt: null,
        note: "reward bank 1.42 below floor 2.00",
      },
    ],
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
      // THE CASE THE HATCHING EXISTS FOR: the lookback ceiling bound and only
      // 9 hours were ever read. The other 15 are not quiet — they are unread,
      // and drawing them as zero-height bars would be a claim nobody made.
      byHour: {
        slices: [{ hoursAgo: 1, count: 0, covered: true }, { hoursAgo: 2, count: 2, covered: true }, { hoursAgo: 3, count: 1, covered: true }, { hoursAgo: 4, count: 0, covered: true }, { hoursAgo: 5, count: 3, covered: true }, { hoursAgo: 6, count: 1, covered: true }, { hoursAgo: 7, count: 0, covered: true }, { hoursAgo: 8, count: 1, covered: true }, { hoursAgo: 9, count: 0, covered: true }, { hoursAgo: 10, count: 0, covered: false }, { hoursAgo: 11, count: 0, covered: false }, { hoursAgo: 12, count: 0, covered: false }, { hoursAgo: 13, count: 0, covered: false }, { hoursAgo: 14, count: 0, covered: false }, { hoursAgo: 15, count: 0, covered: false }, { hoursAgo: 16, count: 0, covered: false }, { hoursAgo: 17, count: 0, covered: false }, { hoursAgo: 18, count: 0, covered: false }, { hoursAgo: 19, count: 0, covered: false }, { hoursAgo: 20, count: 0, covered: false }, { hoursAgo: 21, count: 0, covered: false }, { hoursAgo: 22, count: 0, covered: false }, { hoursAgo: 23, count: 0, covered: false }, { hoursAgo: 24, count: 0, covered: false }],
        total: 8, peak: 3, coveredHours: 9, blocksPerHour: 1704.5,
      },
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
