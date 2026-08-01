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
import { probeLabel } from "./product-health.js";
import {
  formatAgo,
  formatAmount,
  isAcknowledgedProbe,
  isAwaitingProbe,
  type OpsTone,
} from "./ops-model.js";

/** Beyond this, a snapshot is old enough that the board says so out loud. */
export const DATA_STALE_MS = 3 * 60 * 1000;

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

/** Degraded, and nobody has signed it off yet — the ones that earn the headline. */
function unacknowledgedDegraded(health: ProductHealth) {
  return health.probes.filter(
    (p) => p.status === "degraded" && !isAwaitingProbe(p) && !isAcknowledgedProbe(p),
  );
}

/**
 * "7 ok / 1 degraded (acknowledged) / 0 red" — the honest census.
 *
 * Acknowledged degradations are counted and LABELLED, never dropped. The
 * verdict stops shouting about them; the count never stops mentioning them.
 */
function probeCensus(health: ProductHealth): string {
  const awaiting = health.probes.filter(isAwaitingProbe).length;
  const red = health.probes.filter((p) => p.status === "red").length;
  const acked = health.probes.filter((p) => isAcknowledgedProbe(p) && !isAwaitingProbe(p)).length;
  const degraded = unacknowledgedDegraded(health).length;
  const ok = health.probes.length - red - degraded - acked - awaiting;
  const parts = [`${ok} ok`];
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (acked > 0) parts.push(`${acked} degraded (acknowledged)`);
  if (awaiting > 0) parts.push(`${awaiting} awaiting data`);
  parts.push(`${red} red`);
  return parts.join(" / ");
}

/**
 * The one-glance verdict.
 *
 * Ordering is deliberate and is the whole hierarchy: a breached floor or a red
 * probe outranks a payout shortfall outranks a real degradation. A stale stream
 * does not produce its own verdict — it RE-LABELS whatever verdict we last had
 * as "last known state" (the banner above carries the alarm), because a calm
 * verdict rendered over four-minute-old numbers is the exact lie this board
 * exists to not tell.
 *
 * `unverified` payout evidence deliberately does NOT raise the verdict: we
 * cannot see the chain, which is an instrument fault, not a money fault. It
 * shows in its own row, in warm grey.
 */
export function opsVerdict(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  nowMs: number;
}): VerdictView {
  const { health, streamDegraded, nowMs } = input;

  if (!health.enabled) {
    return {
      kicker: "MONITORING OFF",
      kickerTone: "awaiting",
      verdict: "NOT WATCHING",
      verdictTone: "awaiting",
      sub: "PRODUCT_HEALTH_ENABLED is unset — this board is not probing the live product.",
      subTone: "awaiting",
    };
  }
  if (health.checks === 0) {
    return {
      kicker: "AWAITING FIRST CHECK",
      kickerTone: "awaiting",
      verdict: "NO DATA YET",
      verdictTone: "awaiting",
      sub: "The heartbeat runs every couple of minutes. Nothing is known until it does.",
      subTone: "awaiting",
    };
  }

  const ageMs = health.at == null ? null : Math.max(0, nowMs - health.at);
  const stale = streamDegraded || (ageMs != null && ageMs > DATA_STALE_MS);
  const kicker = stale
    ? `LAST KNOWN STATE — ${streamDegraded ? "STREAM DOWN" : "DATA STALE"} · ${health.at == null ? "age unknown" : formatAgo(health.at, nowMs)}`
    : `OPERATOR VERDICT · ${clockOf(health.at)}`;
  const kickerTone: OpsTone = stale ? "red" : "awaiting";
  const census = probeCensus(health);

  const breached = (health.solvency?.pools ?? []).filter(
    (p) => p.status === "red" && p.amount != null && p.floor != null && p.floor > 0,
  );
  const reds = health.probes.filter((p) => p.status === "red");
  const payout = health.flow?.payout;
  const shortfall = payout?.status === "shortfall";

  if (breached.length > 0) {
    const lead = breached[0]!;
    const extra = breached.length > 1 ? ` +${breached.length - 1}` : "";
    return {
      kicker,
      kickerTone,
      verdict: `${lead.label.toUpperCase()} BELOW FLOOR${extra}`,
      verdictTone: "red",
      sub: [
        shortfall ? `on-chain payout shortfall (${shortfallGap(payout)})` : null,
        census,
        "payouts halt when the reward bank empties",
      ]
        .filter(Boolean)
        .join(" · "),
      subTone: "red",
    };
  }

  if (reds.length > 0) {
    const lead = reds[0]!;
    const extra = reds.length > 1 ? ` +${reds.length - 1}` : "";
    return {
      kicker,
      kickerTone,
      verdict: `${probeLabel(lead.name).toUpperCase()} RED${extra}`,
      verdictTone: "red",
      sub: `${lead.detail} · ${census}`,
      subTone: "red",
    };
  }

  if (shortfall) {
    return {
      kicker,
      kickerTone,
      verdict: "PAYOUT SHORTFALL",
      verdictTone: "red",
      // The funnel can read perfectly clean while this is true — say so, because
      // the operator is about to look at a funnel that disagrees.
      sub: `${shortfallGap(payout)} settled jobs have no on-chain proof · the funnel reads clean · ${census}`,
      subTone: "red",
    };
  }

  // Acknowledged degradations are excluded here on purpose — see
  // isAcknowledgedProbe. They stay amber in the pillar strip and counted in the
  // census; they just don't get to own the headline forever.
  const degraded = unacknowledgedDegraded(health);
  if (degraded.length > 0) {
    const lead = degraded[0]!;
    const extra = degraded.length > 1 ? ` +${degraded.length - 1}` : "";
    return {
      kicker,
      kickerTone,
      verdict: `${probeLabel(lead.name).toUpperCase()} DEGRADED${extra}`,
      verdictTone: "degraded",
      sub: `${lead.detail} · ${census}`,
      subTone: "degraded",
    };
  }

  const proven = payout?.status === "confirmed";
  return {
    kicker,
    kickerTone,
    verdict: "NOMINAL",
    verdictTone: "ok",
    sub: [
      proven ? "money is moving and proven on-chain" : null,
      "all floors clear",
      census,
    ]
      .filter(Boolean)
      .join(" · "),
    subTone: "awaiting",
  };
}

function shortfallGap(payout: PayoutEvidence | undefined): string {
  if (!payout || payout.confirmedCount == null || payout.settledCount == null) return "gap unknown";
  return `−${Math.max(0, payout.settledCount - payout.confirmedCount)}`;
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
    const stale = ageMs > DATA_STALE_MS;
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
    const gap = shortfallGap(payout);
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
