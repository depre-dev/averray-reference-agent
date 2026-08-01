// The ops board's view-model — the spec-sheet layout, as pure functions.
//
// The board answers four questions in priority order, and this module is the
// answer to each:
//
//   1. Is anything wrong?          → opsVerdict()
//   2. Is the money OK?            → poolMeter() + flowFunnel() + payoutView()
//   3. Why, specifically?          → the probe pillars (ops-model.ts)
//   4. Can I trust this screen?    → trustRows()
//
// Question 4 is why this module takes `streamDegraded` as an input rather than
// reading a store: a verdict computed from data we cannot trust is not a
// verdict, so the stream state has to be able to override the health verdict
// at the point the verdict is decided.
//
// Everything here is pure with `nowMs` injected, so the whole board is
// deterministic to test — including the age phrasing.

import type {
  MoneyPathSnapshot,
  PayoutEvidence,
  ProductHealth,
  SelfFreshness,
  SolvencyPool,
} from "./product-health.js";
import { deriveOpsVerdict, payoutGap } from "@avg/schemas/ops-verdict";
import { formatAgo, formatAmount, type OpsTone } from "./ops-model.js";

/**
 * When is a snapshot old enough to say so out loud?
 *
 * This was a flat 3 minutes, picked by intuition. The heartbeat runs every 2 —
 * so a single late check lit "DATA STALE · every value below may be wrong" over
 * a perfectly healthy mainnet, and it was lit most of the time. That is exactly
 * the false red the board's own rules forbid: an alarm that is always on is one
 * the operator learns to scroll past, which makes the next one invisible.
 *
 * The threshold now comes from the cadence the SERVER reports, so it follows a
 * config change instead of drifting out of agreement with one. Two and a half
 * intervals tolerates one missed check and not two.
 *
 * Same lesson as the block-time bug: measure the thing you are comparing
 * against, don't assume it.
 */
export const STALE_INTERVAL_MULTIPLE = 2.5;

/** Fallback when the server reports no cadence — generous on purpose, because a
 *  too-tight guess produces precisely the false alarm described above. */
export const DATA_STALE_FALLBACK_MS = 10 * 60 * 1000;

export function staleAfterMs(health: Pick<ProductHealth, "checkIntervalMs">): number {
  const interval = health.checkIntervalMs;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
    return DATA_STALE_FALLBACK_MS;
  }
  return interval * STALE_INTERVAL_MULTIPLE;
}

// ── 1. the verdict ──────────────────────────────────────────────────────────

export interface VerdictView {
  /** Small line above the verdict — context, or the stale warning. */
  kicker: string;
  kickerTone: OpsTone;
  /** The one oversized element on the board. Readable across a room. */
  verdict: string;
  verdictTone: OpsTone;
  /** Counts, not vibes. */
  sub: string;
  subTone: OpsTone;
}

function clockOf(at: number | null | undefined): string {
  if (at == null) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(11, 19)}Z`;
}

/** "10:30:00" from an ISO string, or undefined when there is nothing to show. */
function isoClock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(11, 19);
}

/**
 * The one-glance verdict, as the board shows it.
 *
 * The verdict ITSELF is decided once, in `@avg/schemas`, and the very same
 * function runs server-side so `/monitor/product-health` emits exactly this
 * headline, tone and reason. An agent reading that endpoint therefore reads
 * the board's conclusion instead of forming a competing one — two verdict
 * systems, one of which can hallucinate, is how an operator learns to distrust
 * both.
 *
 * What stays here is only what a server cannot know, because it is a property
 * of the READER rather than of the product: how old this snapshot is in front
 * of this screen, and whether this browser's stream is alive. Those never
 * change the verdict — they RE-LABEL it as "last known state", because a calm
 * verdict rendered over four-minute-old numbers is the exact lie this board
 * exists not to tell.
 */
export function opsVerdict(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  nowMs: number;
}): VerdictView {
  const { health, streamDegraded, nowMs } = input;

  const core = deriveOpsVerdict({
    enabled: health.enabled,
    checks: health.checks,
    probes: health.probes,
    pools: health.solvency?.pools ?? [],
    runway: health.solvency?.runway ?? [],
    ...(health.flow?.payout ? { payout: health.flow.payout } : {}),
  });
  // A red/degraded verdict tones its own subline; a calm one leaves the
  // subline warm grey so the counts read as context, not as reassurance.
  const subTone: OpsTone = core.tone === "ok" ? "awaiting" : core.tone;

  if (core.reason === "not-watching") {
    return {
      kicker: "MONITORING OFF",
      kickerTone: "awaiting",
      verdict: core.headline,
      verdictTone: core.tone,
      sub: core.sub,
      subTone: "awaiting",
    };
  }
  if (core.reason === "no-data") {
    return {
      kicker: "AWAITING FIRST CHECK",
      kickerTone: "awaiting",
      verdict: core.headline,
      verdictTone: core.tone,
      sub: core.sub,
      subTone: "awaiting",
    };
  }

  const ageMs = health.at == null ? null : Math.max(0, nowMs - health.at);
  const stale = streamDegraded || (ageMs != null && ageMs > staleAfterMs(health));
  return {
    kicker: stale
      ? `LAST KNOWN STATE — ${streamDegraded ? "STREAM DOWN" : "DATA STALE"} · ${health.at == null ? "age unknown" : formatAgo(health.at, nowMs)}`
      : `OPERATOR VERDICT · ${clockOf(health.at)}`,
    kickerTone: stale ? "red" : "awaiting",
    verdict: core.headline,
    verdictTone: core.tone,
    sub: core.sub,
    subTone,
  };
}

// ── 4. can I trust this screen? ─────────────────────────────────────────────

export interface TrustRow {
  key: string;
  value: string;
  tone: OpsTone;
}

/**
 * The trust panel. Every row answers "should I believe the big number to my
 * left", and each degrades honestly on its own: an unknown monitor build reads
 * "unknown", never "current".
 */
export function trustRows(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  streamStatus: string;
  /** ISO clock of the last board snapshot the stream delivered. */
  streamAt?: string | undefined;
  nowMs: number;
}): TrustRow[] {
  const { health, streamDegraded, streamStatus, streamAt, nowMs } = input;
  const rows: TrustRow[] = [];

  // The last event time comes from the SNAPSHOT, never the wall clock — a
  // clock that ticks on its own would keep looking live through a dead stream.
  const lastEvent = isoClock(streamAt);
  rows.push(
    streamDegraded
      ? {
          key: "STREAM",
          value: `DISCONNECTED · ${streamStatus}${lastEvent ? ` · last event ${lastEvent}` : ""}`,
          tone: "red",
        }
      : { key: "STREAM", value: lastEvent ? `live · last event ${lastEvent}` : "live", tone: "ok" },
  );

  if (health.at == null) {
    rows.push({ key: "DATA AGE", value: "no check yet", tone: "awaiting" });
  } else {
    const ageMs = Math.max(0, nowMs - health.at);
    const stale = ageMs > staleAfterMs(health);
    rows.push({
      key: "DATA AGE",
      value: `${formatAgo(health.at, nowMs)} — ${stale ? "STALE" : "fresh"}`,
      tone: stale ? "red" : "ok",
    });
  }

  rows.push(monitorRow(health.self));

  const rem = health.remediation;
  if (!rem || !rem.enabled || rem.state === "off") {
    rows.push({ key: "RPC", value: "failover off — single endpoint", tone: "awaiting" });
  } else {
    rows.push({
      key: "RPC",
      value: rem.detail,
      tone: rem.state === "halted" ? "red" : rem.state === "failover" ? "degraded" : "ok",
    });
  }

  return rows;
}

function monitorRow(self: SelfFreshness | undefined): TrustRow {
  // No `self` block at all means the monitor could not determine its own
  // version. That is unknown, not current — the whole point of the probe.
  if (!self) return { key: "MONITOR", value: "build unknown", tone: "awaiting" };
  const sha = self.runningSha ? self.runningSha.slice(0, 8) : "sha unknown";
  if (self.status === "current") return { key: "MONITOR", value: `${sha} · current`, tone: "ok" };
  if (self.status === "behind") {
    const n = self.behindBy;
    return {
      key: "MONITOR",
      value: `${sha} · ${n ?? "?"} behind main — merged work is not live`,
      tone: "degraded",
    };
  }
  return { key: "MONITOR", value: `${sha} · freshness unknown`, tone: "awaiting" };
}

// ── 2a. solvency meters ─────────────────────────────────────────────────────

/**
 * A meter needs a scale, and the scale must not move with the value it is
 * measuring — an auto-fitted bar always looks about two-thirds full, which is
 * the fake-green failure in bar form.
 *
 * So the scale is anchored to the FLOOR and snaps to one of these rungs: the
 * first rung where `floor × rung` contains the current balance. The floor tick
 * therefore always sits at a known fraction of the width (1/4, 1/10, 1/30 …),
 * the bar only re-scales when a balance crosses a rung — a discrete, labelled
 * event — and a draining pool visibly drains toward a tick that stays put.
 */
export const METER_RUNGS = [4, 10, 30, 100, 300, 1000] as const;

export interface MeterView {
  /** 0..100 — the filled portion. Clamped; see `overScale`. */
  fillPct: number;
  /** 0..100 — where the floor tick sits. Fixed per rung. */
  floorPct: number;
  /** Right-hand scale label, e.g. "20". */
  scaleLabel: string;
  floorLabel: string;
  /** The balance exceeds even the top rung; the bar is pegged and says so. */
  overScale: boolean;
}

export interface PoolView {
  pool: SolvencyPool;
  /** null → NO METER. Unfloored or unreadable pools never get a bar. */
  meter: MeterView | null;
  amountLabel: string;
  unit: string;
  /** "×7.9 above floor" / "BELOW FLOOR · short 0.58" / "awaiting data". */
  margin: string;
  marginTone: OpsTone;
  tone: OpsTone;
}

/**
 * The meter for one pool, or null when it must not have one.
 *
 * Returns null for a pool with no floor and for a pool whose amount we could
 * not read. Both used to render as a full bar, which reads as "healthy and
 * full" — the deliberately-empty treasury reserve shipped looking topped up
 * exactly once, and that is the bug this null exists to make impossible.
 */
export function poolMeter(pool: SolvencyPool): MeterView | null {
  const { amount, floor } = pool;
  if (amount == null) return null;
  if (floor == null || floor <= 0) return null;

  const rung = METER_RUNGS.find((r) => floor * r >= amount);
  const overScale = rung === undefined;
  const effective = rung ?? METER_RUNGS[METER_RUNGS.length - 1]!;
  const scale = floor * effective;
  return {
    fillPct: Math.max(0, Math.min(100, (amount / scale) * 100)),
    floorPct: 100 / effective,
    scaleLabel: formatAmount(scale),
    floorLabel: formatAmount(floor),
    overScale,
  };
}

/** How far above (or below) its floor a pool sits — stated in absolute units. */
function marginOf(pool: SolvencyPool): { text: string; tone: OpsTone } {
  const { amount, floor } = pool;
  if (amount == null) return { text: "awaiting data", tone: "awaiting" };
  if (floor == null || floor <= 0) return { text: "no floor", tone: "awaiting" };
  if (amount < floor) {
    return { text: `BELOW FLOOR · short ${formatAmount(floor - amount)}`, tone: "red" };
  }
  const multiple = amount / floor;
  const shown = multiple >= 10 ? Math.round(multiple).toString() : multiple.toFixed(1);
  return { text: `×${shown} above floor`, tone: "awaiting" };
}

export function poolViews(pools: readonly SolvencyPool[]): PoolView[] {
  return pools.map((pool) => {
    const margin = marginOf(pool);
    return {
      pool,
      meter: poolMeter(pool),
      // An unreadable balance is never "0.00" — that is a number, and a number
      // is a claim we cannot make.
      amountLabel: pool.amount == null ? "—" : formatAmount(pool.amount),
      unit: pool.unit,
      margin: margin.text,
      marginTone: margin.tone,
      tone: pool.amount == null ? "awaiting" : pool.status,
    };
  });
}

/** Floored pools get meters; the rest are listed with their reason, no bars. */
export function splitPools(pools: readonly SolvencyPool[]): {
  floored: PoolView[];
  unfloored: PoolView[];
} {
  const views = poolViews(pools);
  return {
    floored: views.filter((v) => v.meter !== null),
    unfloored: views.filter((v) => v.meter === null),
  };
}

// ── 2b. flow + payout evidence ──────────────────────────────────────────────

export interface FunnelView {
  claimed: string;
  submitted: string;
  settled: string;
  /** Claimed but not submitted — normal work in progress. */
  inflight: string;
  /** Submitted but not settled — a real payout backlog. */
  backlog: string;
  backlogTone: OpsTone;
  stuck: string;
  failed: string;
  /** stuck/failed nonzero, or a backlog — the funnel is not clean. */
  tone: OpsTone;
}

const dash = (n: number | null | undefined): string => (typeof n === "number" ? String(n) : "—");

export function flowFunnel(flow: MoneyPathSnapshot | undefined): FunnelView {
  const backlog = flow?.submittedNotSettled;
  const stuck = flow?.stuck;
  const failed = flow?.failed24h;
  const backlogTone: OpsTone =
    typeof backlog !== "number" ? "awaiting" : backlog > 0 ? "degraded" : "ok";
  const tone: OpsTone =
    typeof failed === "number" && failed > 0
      ? "red"
      : (typeof stuck === "number" && stuck > 0) || backlogTone === "degraded"
        ? "degraded"
        : flow == null
          ? "awaiting"
          : "ok";
  return {
    claimed: dash(flow?.claimed24h),
    submitted: dash(flow?.submitted24h),
    settled: dash(flow?.settled24h),
    inflight: dash(flow?.claimedNotSubmitted),
    backlog: dash(backlog),
    backlogTone,
    stuck: dash(stuck),
    failed: dash(failed),
    tone,
  };
}

export interface EvidenceView {
  /** "CONFIRMED" · "SHORTFALL −2" · "UNVERIFIED". */
  status: string;
  tone: OpsTone;
  /** What the chain says. */
  line1: string;
  /** What the product's own ledger says. */
  line2: string;
  /** The comparison — the reason this row exists. */
  delta: string;
  /** Only a real shortfall gets the alarming frame. */
  emphasised: boolean;
}

/**
 * Payout evidence, welded to the funnel it corroborates.
 *
 * The three statuses are three different facts, and the tones keep them apart:
 * confirmed is sage, shortfall is coral (we can see, and money is missing), and
 * unverified is warm grey (we cannot see — the instrument is broken, the money
 * may be perfectly fine). Collapsing the last two into one alarm is how a board
 * trains its operator to ignore it.
 */
export function payoutView(payout: PayoutEvidence | undefined): EvidenceView {
  if (!payout) {
    return {
      status: "UNVERIFIED",
      tone: "awaiting",
      line1: "no on-chain read configured",
      line2: "the funnel above is the product's own ledger, uncorroborated",
      delta: "nothing independent is checking that payouts landed",
      emphasised: false,
    };
  }

  const chainLine =
    payout.confirmedCount == null
      ? "chain not readable in this window"
      : `${payout.confirmedCount} payout${payout.confirmedCount === 1 ? "" : "s"} confirmed on-chain${
          payout.confirmedUsdc == null ? "" : ` · ${formatAmount(payout.confirmedUsdc)} USDC`
        }`;
  const ledgerLine =
    payout.settledCount == null
      ? "settled count unavailable"
      : `${payout.settledCount} marked settled by the monitor`;

  if (payout.status === "shortfall") {
    const gap = payoutGap(payout);
    return {
      status: `SHORTFALL ${gap}`,
      tone: "red",
      line1: chainLine,
      line2: ledgerLine,
      delta: `${gap.replace("−", "")} settled jobs have no on-chain proof — money did not move`,
      emphasised: true,
    };
  }

  if (payout.status === "unverified") {
    return {
      status: "UNVERIFIED",
      tone: "awaiting",
      line1: chainLine,
      line2: ledgerLine,
      // Say which thing is broken, in words, so it cannot be misread as a
      // money problem at a glance.
      delta: payout.detail || "chain unreadable — instrument broken, not money",
      emphasised: false,
    };
  }

  return {
    status: "CONFIRMED",
    tone: "ok",
    line1: chainLine,
    line2: ledgerLine,
    delta: "proof matches ledger — no gap",
    emphasised: false,
  };
}

/** The permanent key under the evidence row — the distinction, always on screen. */
export const EVIDENCE_KEY: readonly { tone: OpsTone; text: string }[] = [
  { tone: "ok", text: "CONFIRMED — proof matches the ledger" },
  { tone: "red", text: "SHORTFALL — proof missing: money broken" },
  { tone: "awaiting", text: "UNVERIFIED — chain unreadable: instrument broken, not money" },
];
