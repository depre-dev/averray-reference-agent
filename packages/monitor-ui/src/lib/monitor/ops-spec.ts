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
  ExternalFunnelView,
  LifecycleClassView,
  LifecycleView,
  GasSpendView,
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

/**
 * An RPC endpoint, short enough to sit on one line.
 *
 * `remediation.activeEndpoint` is a full URL in production —
 * "https://services.polkadothub-rpc.com/mainnet/" — which the desktop hid
 * behind an ellipsis and the phone could not hide at all: it became the longest
 * thing on the trust line. The host is the part that identifies WHICH endpoint
 * we are on, which is the only question the row answers.
 */
export function shortEndpoint(endpoint: string | null | undefined): string | null {
  const raw = (endpoint ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || raw;
  } catch {
    // Already a short name ("rpc-1") or something unparseable — show it as-is
    // rather than dropping the only identifying detail on the row.
    return raw;
  }
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
  rows.push(buzzRow(health.buzz));
  rows.push(askHermesRow(health.buzzInbound));

  const rem = health.remediation;
  if (!rem || !rem.enabled || rem.state === "off") {
    rows.push({ key: "RPC", value: "failover off — single endpoint", tone: "awaiting" });
  } else {
    rows.push({
      key: "RPC",
      value: shortRpcDetail(rem),
      tone: rem.state === "halted" ? "red" : rem.state === "failover" ? "degraded" : "ok",
    });
  }

  return rows;
}

/** The remediation detail with any full URL in it reduced to its host. */
function shortRpcDetail(rem: NonNullable<ProductHealth["remediation"]>): string {
  const host = shortEndpoint(rem.activeEndpoint);
  if (!host) return rem.detail;
  return rem.detail.replace(/https?:\/\/\S+/g, host);
}

/**
 * The #Ops delivery row.
 *
 * "armed" is deliberately NOT ok-toned: a configured channel that has never
 * delivered anything is untested, and showing it green would be the same lie
 * as a fake healthy probe — worse, because the thing it would be lying about
 * is whether you will be TOLD when something breaks.
 *
 * An absent block means an older backend that does not report this. Silence is
 * right there: inventing a status for a field the server never sent is exactly
 * the fabrication this panel exists to avoid.
 */
function buzzRow(buzz: ProductHealth["buzz"]): TrustRow {
  if (!buzz) return { key: "OPS CHANNEL", value: "not reported by this build", tone: "awaiting" };
  const tone: OpsTone =
    buzz.status === "ok" ? "ok" : buzz.status === "failing" ? "red" : "awaiting";
  return { key: "OPS CHANNEL", value: buzz.detail, tone };
}

/**
 * Can Hermes ANSWER? — the other half of the ops channel.
 *
 * `OPS CHANNEL` above says whether alerts get OUT. This says whether a question
 * gets IN, and the two fail differently: a dead listener emits no alert and no
 * error, so it is found by asking something and getting silence — which reads
 * as the agent having nothing to say.
 *
 * Only `listening` is ok. Every other phase means questions go unanswered, and
 * a retrying listener looks exactly like a channel nobody has posted in.
 * `off` is not a fault — a feature nobody enabled must never render as broken,
 * or the row becomes one more permanently-lit thing to scroll past.
 */
export function askHermesRow(inbound: ProductHealth["buzzInbound"]): TrustRow {
  // Absent means this build predates the feature. Inventing a status for a
  // field the server never sent is the fabrication this panel exists to avoid.
  if (!inbound) return { key: "ASK HERMES", value: "not reported by this build", tone: "awaiting" };
  if (inbound.phase === "listening") return { key: "ASK HERMES", value: "listening — questions answered", tone: "ok" };
  if (inbound.phase === "off" || inbound.phase === "closed") {
    return { key: "ASK HERMES", value: inbound.detail || "not enabled", tone: "awaiting" };
  }
  // connecting / authenticating / retrying / misconfigured — all mean a question
  // asked right now goes unanswered. Say which, and say it is not answering.
  const retries = inbound.failures > 0 ? ` · ${inbound.failures} failed attempt${inbound.failures === 1 ? "" : "s"}` : "";
  return { key: "ASK HERMES", value: `${inbound.phase} — NOT answering${retries}`, tone: "degraded" };
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
  /** Whether the two counts were measured over the same period. Never absent. */
  fit: { text: string; tone: OpsTone };
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
/**
 * Why the payout count is not simply every settlement on chain.
 *
 * The protocol fee is credited by the SAME event as a payout and differs only
 * in recipient, so it is excluded from the count. That exclusion moved a number
 * the operator had been reading for weeks, and a money figure that changes with
 * nothing on screen to explain it is its own kind of dishonesty.
 *
 * Silent only when there is genuinely nothing to say: fees were separable and
 * none occurred in the window. `feesSeparated: false` is NOT that case — it
 * means the count may still include fees, and saying so is the whole point.
 */
/**
 * Whether the two counts above were measured over the same period.
 *
 * ── WHY THIS IS NOW ALWAYS ON SCREEN ──────────────────────────────────────
 *
 * This used to render nothing when the fit was `ok`, on the reasoning that a
 * matching window needs no caption and a permanent "~24h at 2.16s/block" is
 * the kind of always-true text a reader stops seeing.
 *
 * That reasoning fails in precisely the case that matters. On 2026-08-02 the
 * live board read SHORTFALL −2 — "2 settled jobs have no on-chain proof, money
 * did not move" — while saying nothing whatsoever about the window, because
 * the fit was `ok` and therefore silent. The operator got the accusation and
 * was denied the fact that decides whether to believe it: whether the chain
 * count and the ledger count cover the same 24 hours, or whether a job simply
 * sat on the edge of one of them.
 *
 * A caveat that hides while things look fine is a caveat that is missing every
 * time it would have carried weight. It costs one quiet line.
 *
 * Tone follows meaning, not alarm. A good fit is stated in grey: it is
 * reassurance about the METHOD, not about the money, and only the line above
 * is entitled to be red.
 */
export function windowFitLine(payout: PayoutEvidence): { text: string; tone: OpsTone } {
  const fit = payout.window;
  if (!fit) return { text: "window fit not reported by this build", tone: "awaiting" };
  if (fit.status === "unknown") {
    return { text: "window fit UNCHECKED — block time not measured", tone: "degraded" };
  }
  if (fit.status !== "ok") return { text: `WINDOW SUSPECT — ${fit.detail}`, tone: "degraded" };
  // State what was actually compared, so "same window" is a claim with numbers
  // behind it rather than a reassuring adjective.
  const blocks = payout.windowBlocks == null ? "" : `${payout.windowBlocks.toLocaleString()} blocks · `;
  const span = fit.spanHours == null ? "window" : `~${fit.spanHours}h`;
  const rate = fit.blockSeconds == null ? "" : ` at ${fit.blockSeconds}s/block`;
  return {
    text: `window fit ok — chain read over ${blocks}${span}${rate}, against a 24h ledger count`,
    tone: "awaiting",
  };
}

function feeNote(payout: PayoutEvidence): string {
  if (payout.feesSeparated === false) return " · fees not separated — count may include them";
  if (payout.feesSeparated !== true) return ""; // older payload, nothing claimed
  const n = payout.feeCount ?? 0;
  if (n === 0) return "";
  const amount = payout.feeUsdc == null ? "" : ` ${formatAmount(payout.feeUsdc)} USDC`;
  return ` · ${n} fee credit${n === 1 ? "" : "s"}${amount} excluded`;
}

export function payoutView(payout: PayoutEvidence | undefined): EvidenceView {
  if (!payout) {
    return {
      status: "UNVERIFIED",
      tone: "awaiting",
      line1: "no on-chain read configured",
      line2: "the funnel above is the product's own ledger, uncorroborated",
      delta: "nothing independent is checking that payouts landed",
      // Nothing was compared, so there is no fit to report — and saying so is
      // not the same as reporting a good one.
      fit: { text: "no comparison window — nothing was read from the chain", tone: "awaiting" },
      emphasised: false,
    };
  }

  const chainLine =
    payout.confirmedCount == null
      ? "chain not readable in this window"
      : `${payout.confirmedCount} payout${payout.confirmedCount === 1 ? "" : "s"} confirmed on-chain${
          payout.confirmedUsdc == null ? "" : ` · ${formatAmount(payout.confirmedUsdc)} USDC`
        }${feeNote(payout)}`;
  const ledgerLine = payoutExpectationLine(payout);
  const fit = windowFitLine(payout);

  // ── A DISAGREEMENT OUTRANKS BOTH VERDICTS ────────────────────────────────
  //
  // If two providers read the same pinned range and return different counts,
  // the instrument is unreliable — and an unreliable instrument cannot assert
  // a shortfall any more than it can assert a confirmation. Suspending the
  // comparison is the honest outcome in BOTH directions.
  //
  // This is the same rule that already makes a `suspect` window suppress a
  // shortfall server-side, applied one layer out.
  if (payout.crossCheck?.status === "disagree") {
    return {
      status: "ENDPOINTS DISAGREE",
      tone: "degraded",
      line1: chainLine,
      line2: ledgerLine,
      delta: payout.crossCheck.detail,
      fit,
      // Not the alarming frame: nothing here says money is missing, and
      // dressing an instrument fault as one is the false red this board keeps
      // having to remove.
      emphasised: false,
    };
  }

  if (payout.status === "shortfall") {
    const gap = payoutGap(payout);
    return {
      status: `SHORTFALL ${gap}`,
      tone: "red",
      line1: chainLine,
      line2: ledgerLine,
      delta: `${gap.replace("−", "")} jobs expected payment but have no on-chain proof — money did not move`,
      fit,
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
      fit,
      emphasised: false,
    };
  }

  return {
    status: "CONFIRMED",
    tone: "ok",
    line1: chainLine,
    line2: ledgerLine,
    delta: confirmedDelta(payout),
    fit,
    emphasised: false,
  };
}

function payoutExpectationLine(payout: PayoutEvidence): string {
  if (payout.settledCount == null) return "payment-expected settlement count unavailable";
  if (payout.zeroPayCount == null) {
    return `${payout.settledCount} expected payment · zero-pay settlement count unavailable`;
  }
  const totalSettled = payout.settledCount + payout.zeroPayCount;
  return `${totalSettled} settled — ${payout.settledCount} expected payment · ${payout.zeroPayCount} settled with zero payout (rejected)`;
}

/**
 * What CONFIRMED actually means, given the numbers printed beside it.
 *
 * "proof matches ledger — no gap" was hard-coded, and `confirmed` does not mean
 * zero gap — it means the gap is within `PRODUCT_HEALTH_PAYOUT_TOLERANCE`,
 * which defaults to 1. So the live board showed
 *
 *     CONFIRMED · 15 payouts confirmed on-chain · 16 marked settled
 *                 proof matches ledger — no gap
 *
 * with 15 and 16 on the same row. Anyone who subtracts gets a different answer
 * from the board's own summary of itself, and the summary is the part written
 * in the reassuring voice.
 *
 * The tolerance is right — a job settling within seconds of the window edge
 * lands on one side of the chain read and the other side of the ledger count,
 * and paging someone for that would be a false red. What was wrong was
 * describing a tolerated gap as no gap. It stays sage, because the money is
 * fine; it just stops claiming more than the evidence does.
 */
function confirmedDelta(payout: PayoutEvidence): string {
  const { settledCount, confirmedCount } = payout;
  if (settledCount == null || confirmedCount == null) return "proof matches ledger";
  const gap = settledCount - confirmedCount;
  if (gap === 0) return "proof matches ledger — no gap";
  if (gap > 0) {
    return `${gap} payment-expected job${gap === 1 ? "" : "s"} not yet proven on-chain — inside the boundary tolerance, not a shortfall`;
  }
  // More proof than ledger: normal at a window edge, where the chain read
  // reaches back slightly further than the 24h settled count.
  const extra = -gap;
  return `${extra} more payout${extra === 1 ? "" : "s"} on-chain than settled in the window — window edge, not a discrepancy`;
}

export interface HourBarView {
  hoursAgo: number;
  count: number;
  /** 0–100. Zero for an unobserved slice, which draws as a gap, not a bar. */
  heightPct: number;
  covered: boolean;
  /** Hover text — the only place the exact count of a 1px bar is legible. */
  title: string;
}

export interface SettledByHourView {
  bars: HourBarView[];
  /** e.g. "Σ 18 confirmed on-chain · peak 4/h" */
  caption: string;
  /** Said out loud when part of the day was never read. Empty otherwise. */
  gapNote: string;
}

/**
 * The hourly row under the funnel — throughput, from the chain.
 *
 * ── IT IS NOT THE FUNNEL'S NUMBER, AND SAYS SO ────────────────────────────
 *
 * These bars come from `ReservationSettled` logs, the same independent read
 * that can contradict the funnel. Labelling them "settled" would quietly
 * reattribute them to the product's own ledger and throw away the only
 * property that makes the row worth its space.
 *
 * ── AN UNOBSERVED HOUR IS A GAP, NOT A SHORT BAR ──────────────────────────
 *
 * A slice the log read never reached has `count: 0` because nobody looked.
 * Drawn at zero height beside real hours it reads as "nothing paid out then",
 * which is a claim the instrument never made. Those slices get no bar at all
 * and the row says how many hours it actually covered.
 *
 * Returns null when there is nothing honest to draw, so the caller can render
 * the reason as a sentence instead.
 */
export function settledByHourView(payout: PayoutEvidence | undefined): SettledByHourView | null {
  const h = payout?.byHour;
  if (!h || "reason" in h) return null;
  if (h.slices.length === 0) return null;

  // Scale against the busiest COVERED hour. Scaling against a peak that
  // included unobserved slices would flatten every real bar toward nothing.
  const peak = Math.max(1, h.peak);
  // Oldest on the left, so the row reads left-to-right as time moving forward.
  const bars = [...h.slices].reverse().map((s) => ({
    hoursAgo: s.hoursAgo,
    count: s.count,
    // A covered hour with payouts always gets a visible bar: a 1-payout hour
    // beside a 40-payout hour rounds to nothing, and "too small to draw" and
    // "did not happen" must not look the same.
    heightPct: !s.covered ? 0 : s.count === 0 ? 0 : Math.max(8, Math.round((s.count / peak) * 100)),
    covered: s.covered,
    title: s.covered
      ? `${s.hoursAgo}h ago · ${s.count} confirmed on-chain`
      : `${s.hoursAgo}h ago · not read — the log window did not reach this far back`,
  }));

  const unread = h.slices.filter((s) => !s.covered).length;
  return {
    bars,
    caption: `Σ ${h.total} confirmed on-chain · peak ${h.peak}/h`,
    gapNote: unread === 0 ? "" : `${unread}h not read`,
  };
}

/** Why there is no hourly row, when there isn't one. Never an empty chart. */
export function settledByHourReason(payout: PayoutEvidence | undefined): string | null {
  const h = payout?.byHour;
  if (!h) return null; // older payload — say nothing rather than invent a fault
  if ("reason" in h) return h.reason;
  return h.slices.length === 0 ? "no hours to slice" : null;
}

/** The permanent key under the evidence row — the distinction, always on screen. */
export const EVIDENCE_KEY: readonly { tone: OpsTone; text: string }[] = [
  { tone: "ok", text: "CONFIRMED — proof matches the ledger" },
  { tone: "red", text: "SHORTFALL — proof missing: money broken" },
  { tone: "awaiting", text: "UNVERIFIED — chain unreadable: instrument broken, not money" },
  // A fourth fact, not a fourth severity. Two providers reading the same
  // pinned range and returning different counts means the proof cannot be
  // trusted in EITHER direction — it suspends the comparison rather than
  // resolving it, which is why it is not coral.
  { tone: "degraded", text: "ENDPOINTS DISAGREE — two providers, two answers: proof suspended" },
];

/**
 * The provenance line: which endpoint served this proof, at what height.
 *
 * "Independent on-chain proof" has meant "whatever RPC the monitor happened to
 * be pointed at", and one week produced three separate endpoint-lens surprises
 * — WSS 1006s on the default host, native accounts invisible to the EVM lens,
 * an Erc20 ledger split. Proof without provenance is one endpoint's opinion.
 *
 * Absent on an older payload: silence rather than a claim about a source we
 * were not told.
 */
export function payoutProvenanceLine(payout: PayoutEvidence | undefined): string | null {
  const e = payout?.endpoint;
  if (!e || !e.host) return null;
  const at = e.block == null ? "" : ` · block ${e.block.toLocaleString()}`;
  return `proved via ${e.host}${at}`;
}

/**
 * Whether a second provider agrees — always rendered, never a silent tick.
 *
 * "cross-checked ✓" with no date is indistinguishable from a check that
 * stopped running months ago, so every state carries its own age and an
 * agreement past its budget reports overdue. A check being broken is a
 * finding, not an absence.
 */
export function crossCheckLine(
  payout: PayoutEvidence | undefined,
  nowMs: number,
): { text: string; tone: OpsTone } | null {
  const c = payout?.crossCheck;
  if (!c) return null; // older payload — do not invent a fault
  if (c.status === "agree") {
    const age = c.lastAgreedAtMs == null ? "" : ` · ${formatAgo(c.lastAgreedAtMs, nowMs)}`;
    return { text: `cross-checked ✓ ${c.detail}${age}`, tone: "awaiting" };
  }
  if (c.status === "disagree") return { text: c.detail, tone: "degraded" };
  if (c.status === "not-configured") return { text: c.detail, tone: "awaiting" };
  // unavailable / never-run: overdue is the part that decides the tone, because
  // a check that has been failing for a fortnight is a different fact from one
  // that failed this morning.
  return { text: `${c.detail}${c.overdue ? " · CROSS-CHECK OVERDUE" : ""}`, tone: c.overdue ? "degraded" : "awaiting" };
}

// ── facts that sit BESIDE their subject ─────────────────────────────────────
//
// These were four prose lines in a strip at the bottom of the board. Read
// together — which is the only way anyone reads them — they were a wall of
// dot-separated sentences on a screen whose entire visual language is a label
// and a number in a column. They also repeated each other and the footer.
//
// So each now sits with its subject: gas and payout runway under the pools they
// describe, the dispute clock in the flow panel, and only the per-job economics
// as a line of its own. The pool row already shows balance, floor and margin, so
// none of that is repeated here.
//
// ── CAVEATS APPEAR ONLY WHEN THEY BITE ────────────────────────────────────
//
// The old lines carried their methodology on the face: "DOT and USDC not summed
// — no price assumed" was the longest phrase on the row and it was a footnote
// about arithmetic. Honest, and in the worst possible place — it crowded out the
// numbers it was qualifying.
//
// A caveat now shows only when it changes what the number MEANS: figures frozen,
// a truncated total, fees that could not be separated, an age old enough to
// matter. Everything else moves to a tooltip or disappears. Silence is the
// correct rendering of "nothing is wrong with this number".

/** Beyond this, the age of a gas snapshot is worth saying out loud. */
const GAS_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * The gas footnote, shown under the signer-gas pool.
 *
 * The pool row above it already gives the balance and the margin, so this
 * answers only the question the meter cannot: what is draining it.
 */
export function gasPoolNote(gas: GasSpendView | undefined): { text: string; tone: OpsTone } | null {
  if (!gas) return null;
  if (gas.txCount === 0) return { text: "no signer transactions in the window", tone: "awaiting" };

  const parts = [`${gas.totalDot.toFixed(3)} DOT burned`];
  if (gas.perSettlement != null) parts.push(`${gas.perSettlement.toFixed(3)} per settlement`);
  const top = gas.buckets[0];
  if (top) parts.push(`${top.label} ${top.sharePct.toFixed(0)}%`);

  // Only what changes the meaning of the numbers above.
  const caveats: string[] = [];
  if (gas.failedCount > 0) caveats.push(`${gas.failedDot.toFixed(3)} DOT REVERTED`);
  if (gas.truncated) caveats.push("capped — UNDERSTATED");
  if (gas.staleReason) caveats.push(`frozen — ${gas.staleReason}`);
  else if (gas.ageMs > GAS_STALE_AFTER_MS) caveats.push(`${Math.round(gas.ageMs / 60000)}m old`);
  if (gas.otherSenders.length > 0) caveats.push(`+${gas.otherSenders.length} other signer${gas.otherSenders.length === 1 ? "" : "s"}`);

  const tone: OpsTone = caveats.length > 0 ? "degraded" : "awaiting";
  return { text: [...parts, ...caveats].join(" · "), tone };
}

/** The unreadable case, so a failed read is a sentence rather than an absence. */
export function gasUnreadableNote(reason: string): { text: string; tone: OpsTone } {
  return { text: `gas unreadable — ${reason}`, tone: "degraded" };
}

/**
 * The reward-bank footnote: how many more payouts, not how many hours.
 *
 * Payouts are event-driven, so an hours figure goes stale the moment the
 * pipeline pauses while a payout count stays true. The balance and floor are on
 * the meter directly above and are deliberately not repeated.
 */
/**
 * How many more payouts the reward bank funds — the projection itself.
 *
 * Split out so the pool's footnote and the KPI strip run the SAME arithmetic
 * instead of one of them reading the other's sentence. The KPI briefly parsed
 * the rendered note with a regex, which is a number that silently changes
 * meaning the day the wording does: exactly the class of drift this module's
 * "decide it once" rule exists to prevent.
 *
 *   null            → no balance to project from
 *   below-floor     → the pool cannot fund anything
 *   no-average      → nothing settled to average over; NOT "zero payouts left"
 */
export type RunwayProjection =
  | { status: "below-floor" }
  | { status: "no-average" }
  | { status: "ok"; payouts: number; average: number };

export function payoutsRemaining(input: {
  pool: SolvencyPool | undefined;
  payout: PayoutEvidence | undefined;
}): RunwayProjection | null {
  const { pool, payout } = input;
  if (!pool || pool.amount == null) return null;

  const usable = pool.amount - (pool.floor ?? 0);
  if (usable <= 0) return { status: "below-floor" };

  const count = payout?.confirmedCount ?? 0;
  const total = payout?.confirmedUsdc ?? null;
  if (count <= 0 || total == null || total <= 0) return { status: "no-average" };

  const average = total / count;
  return { status: "ok", payouts: Math.floor(usable / average), average };
}

export function payoutRunwayNote(input: {
  pool: SolvencyPool | undefined;
  payout: PayoutEvidence | undefined;
  runwayNote?: string | null | undefined;
}): { text: string; tone: OpsTone } | null {
  const projection = payoutsRemaining(input);
  if (!projection) return null;
  if (projection.status === "below-floor") return { text: "BELOW FLOOR — payouts will fail", tone: "red" };
  if (projection.status === "no-average") {
    return { text: "no payout average yet — cannot project", tone: "awaiting" };
  }
  const { payouts, average } = projection;
  const note = input.runwayNote ? ` · ${input.runwayNote}` : "";
  return {
    text: `≈ ${payouts} more payout${payouts === 1 ? "" : "s"} at ${average.toFixed(3)} avg${note}`,
    tone: payouts <= 5 ? "degraded" : "awaiting",
  };
}

/**
 * Per-job economics — the only genuinely new line, and the only one that keeps
 * a row of its own.
 *
 * Units are on every figure, so the reader is not going to add DOT to USDC by
 * accident; the "not summed, no price assumed" caveat that used to dominate this
 * line now lives in `title` where it is available and out of the way.
 */
export function economicsLine(input: {
  payout?: PayoutEvidence | undefined;
  gas?: GasSpendView | undefined;
}): { text: string; title: string; tone: OpsTone } | null {
  const { payout, gas } = input;
  const settled = payout?.confirmedCount ?? null;
  const parts: string[] = [];

  if (settled != null && settled > 0 && payout?.confirmedUsdc != null) {
    parts.push(`${(payout.confirmedUsdc / settled).toFixed(3)} USDC out`);
  }
  if (gas?.perSettlement != null) parts.push(`${gas.perSettlement.toFixed(3)} DOT gas`);
  if (payout?.feesSeparated === true && payout.feeUsdc != null && settled != null && settled > 0) {
    parts.push(`${(payout.feeUsdc / settled).toFixed(3)} USDC in`);
  }

  // Nothing measurable is nothing to show. An empty row is worse than no row.
  if (parts.length === 0) return null;

  // The one caveat that still changes the meaning: an unmade fee split is not
  // zero revenue, and without saying so the missing figure reads as nothing
  // earned rather than nothing known.
  const unsplit = payout?.feesSeparated === false ? " · fee split unavailable" : "";
  return {
    text: `PER JOB — ${parts.join(" · ")}${unsplit}`,
    title: "DOT and USDC are not summed: this monitor has no DOT price and will not assume one.",
    tone: "awaiting",
  };
}

/**
 * The dispute countdown, shown in the flow panel and only while it is running.
 *
 * This is the only clock on the board where doing nothing costs money: a
 * rejected submission opens a window, and if it lapses the worker's bond is
 * slashed. The probe escalates under 48h and takes halt severity under 12h, so
 * urgency is handled — what was missing is visibility while the clock is still
 * comfortable, which is exactly when acting is cheapest.
 *
 * Absent when nothing is counting down. A row that is always present and almost
 * always says "0" is one nobody reads on the day it matters.
 */
export function disputeClockLine(
  funnel: ExternalFunnelView | undefined,
  nowMs: number,
): { text: string; tone: OpsTone } | null {
  const bucket = funnel?.buckets?.rejected_window_running;
  if (!bucket || bucket.count === 0) return null;

  const job = bucket.leadJobId ? ` ${bucket.leadJobId.slice(0, 10)}…` : "";
  const plural = bucket.count === 1 ? "" : "s";

  if (bucket.oldestDeadlineMs == null) {
    // Bonds are in the window and the clock cannot be read. An instrument
    // fault, and it must NOT render as "no bond at risk".
    return { text: `${bucket.count} bond${plural} in dispute window · deadline UNREADABLE${job}`, tone: "degraded" };
  }
  const msLeft = bucket.oldestDeadlineMs - nowMs;
  if (msLeft <= 0) return { text: `dispute window LAPSED${job} · bond slashable now`, tone: "red" };

  const hours = msLeft / 3_600_000;
  const left = hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  return {
    text: `${bucket.count} bond${plural} in dispute window · slashes in ${left}${job}`,
    tone: hours <= 12 ? "red" : hours <= 48 ? "degraded" : "awaiting",
  };
}

/**
 * Every renderer the board must call, by name.
 *
 * I shipped four of these unwired — written, tested, merged, rendered by
 * nobody — and the operator found it by looking at the screen and saying
 * nothing had changed. The paired test asserts each name appears in a
 * component, so "built but not wired" fails the build instead.
 */
export const MONEY_LINE_RENDERERS = [
  "lifecycleNote",
  "disputeClockLine",
  "payoutRunwayNote",
  "gasPoolNote",
  "economicsLine",
  "settledByHourView",
  "volumeMixNote",
  "payoutProvenanceLine",
  "crossCheckLine",
] as const;

/**
 * How long jobs take, and how much of the work is somebody else's.
 *
 * Two facts in one line because they are one measurement. Pipeline work
 * auto-verifies in seconds; external bounties wait on a human for hours. A
 * blended median would move with the mix rather than with either speed — a day
 * with more dogfood would read as the system getting faster.
 *
 * The slowest is shown beside the median because a median of 19s with a slowest
 * of 20h is a different system from one where both are 19s, and only one of them
 * loses the worker who waited.
 */
export function lifecycleNote(
  lifecycle: LifecycleView | undefined,
): { text: string; tone: OpsTone } | null {
  if (!lifecycle) return null;
  const { selfPosted, external } = lifecycle;
  if (selfPosted.count === 0 && external.count === 0) return null;

  const part = (label: string, c: LifecycleClassView): string | null => {
    if (c.count === 0) return null;
    const median = formatSeconds(c.medianSeconds);
    // One sample is not a median. Say so rather than dressing it as a statistic.
    const basis = c.count === 1 ? "" : c.slowestSeconds != null && c.slowestSeconds > (c.medianSeconds ?? 0) * 2
      ? `, slowest ${formatSeconds(c.slowestSeconds)}`
      : "";
    return `${c.count} ${label} ${median}${basis}`;
  };

  const parts = [part("self-posted", selfPosted), part("external", external)].filter(Boolean);
  if (lifecycle.externalPct != null) parts.push(`${lifecycle.externalPct}% external`);
  // Untimed jobs are named: silently excluding them would make the sample look
  // more complete than it is.
  if (lifecycle.unmeasurable > 0) parts.push(`${lifecycle.unmeasurable} not timeable`);

  return { text: parts.join(" · "), tone: "awaiting" };
}

/**
 * WHO POSTED THE WORK — the composition of the settled count, reconciled.
 *
 * ── WHY THIS IS A LINE OF ITS OWN ─────────────────────────────────────────
 *
 * "18 settled" is honest and unexplained, and unexplained is how a number
 * gets misread later. Three months from now — or in a screenshot tomorrow —
 * volume Averray posted to itself reads as demand. The board should not need
 * a footnote in someone's memory to be read correctly, so the composition
 * sits beside the count rather than being inferrable from a latency line.
 *
 * ── IT RECONCILES, OR IT SAYS IT DOESN'T ──────────────────────────────────
 *
 * The chain-classified parts must sum to the ledger's payment-expected count.
 * Deliberate zero-pay terminals are a separate visible part of the total. The
 * split is read from the CHAIN (a fee-bearing settlement is an external bounty;
 * a fee-waived one is Averray's own), while the expected/zero-pay counts come
 * from the product ledger — so they can disagree, and the difference is real
 * information rather than a rounding nuisance.
 *
 * A job the chain read did not see is `unclassified`. It is never folded into
 * either bucket: "external" is the one number on this board that nobody
 * should be able to inflate by accident.
 *
 * ── WHAT THIS CANNOT SAY ──────────────────────────────────────────────────
 *
 * Not canary-vs-ingestion. The chain knows only whether a settlement paid a
 * protocol fee, and both canary walks and ingestion jobs are fee-waived
 * Averray postings — they are identical on-chain. The product's /health
 * settlement block carries counts and no origin, so that split needs a
 * product contract change, not a board change. Guessing it from job ids or
 * titles would be a pattern match that silently reassigns volume the first
 * time something is renamed.
 */
export function volumeMixNote(input: {
  lifecycle: LifecycleView | undefined;
  /** The product's payout-expected settled count — the classified parts reconcile to this. */
  settledCount: number | null | undefined;
  /** Deliberate zero-pay terminals, visible but excluded from unclassified paid work. */
  zeroPayCount?: number | null | undefined;
  /**
   * Gap treated as the expected window-edge artifact rather than a fault.
   *
   * Observed live on three separate reads — 14/15, 15/16, 17/18 — always
   * exactly one: the most recently settled job, confirmed by the ledger before
   * its log is inside the block window. It is structural, it is benign, and
   * lighting it amber on every read forever is how an operator learns to scroll
   * past the line — which would cost exactly the case the line exists for.
   *
   * Same boundary and same reasoning as PRODUCT_HEALTH_PAYOUT_TOLERANCE. The
   * gap is still COUNTED and still NAMED at any size; only the alarm waits.
   */
  edgeTolerance?: number;
}): { text: string; tone: OpsTone } | null {
  const { lifecycle } = input;
  if (!lifecycle) return null;
  const self = lifecycle.selfPosted.count;
  const external = lifecycle.external.count;
  const classified = self + external;
  const zeroPay = input.zeroPayCount ?? 0;
  if (classified === 0 && !input.settledCount && zeroPay === 0) return null;

  const paidTotal = input.settledCount ?? classified;
  const total = paidTotal + zeroPay;
  const parts = [
    // Spelled out rather than "self-posted": the whole point of the line is
    // that a reader who knows nothing about the system cannot mistake it.
    `${self} posted by Averray`,
    `${external} external`,
  ];
  if (zeroPay > 0) parts.push(`${zeroPay} settled with zero payout (rejected)`);

  const gap = paidTotal - classified;
  const tolerance = input.edgeTolerance ?? 1;
  let tone: OpsTone = "awaiting";
  if (gap > 0) {
    // Settled per the ledger, not seen by the chain read. Named, never absorbed
    // — but only ALARMING past the window-edge tolerance, because one is the
    // steady state and a permanent amber is a line nobody reads.
    parts.push(`${gap} unclassified`);
    if (gap > tolerance) tone = "degraded";
  } else if (gap < 0) {
    // The chain read reached slightly further back than the ledger's 24h — a
    // window edge, not a discrepancy, and it must not read as one.
    parts.push(`${-gap} beyond the ledger window`);
  }

  return { text: `${total} settled — ${parts.join(" · ")}`, tone };
}

/** "19s" · "2h 14m" · "5d" — read without converting. */
export function formatSeconds(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) {
    const wh = Math.floor(h);
    const wm = Math.round((h - wh) * 60);
    return wm === 0 ? `${wh}h` : `${wh}h ${wm}m`;
  }
  return `${Math.round(h / 24)}d`;
}

/**
 * Render a pool amount from its exact base-unit string.
 *
 * Lifted out of DepositPoolTile so the PHONE renders the same number the same
 * way. Two surfaces formatting the same money with two functions is the drift
 * this layer exists to prevent — and the phone lane and the desktop tile now
 * quote one another's figures by construction.
 *
 * `decimals` absent ⇒ the raw base-unit string, labelled `raw`. Scaling by a
 * guessed exponent would silently move a decimal point on a money value.
 */
// ── the KPI strip (Direction B) ─────────────────────────────────────────────

export interface KpiView {
  key: string;
  label: string;
  /** The figure, or "—" when it was not reported. Never a fabricated zero. */
  value: string;
  /** Unit or noun beside the figure ("payouts", "DOT"); absent when none. */
  unit?: string;
  /** One line of context, already decided. */
  sub: string;
  /** Tones the SUB line only — the figure stays ink, because a count is not
   *  a verdict and the verdict is upstairs. */
  tone: OpsTone;
}

/**
 * The four numbers an operator checks first, as cards.
 *
 * ── IT IS A SECOND READING, NEVER A SECOND OPINION ───────────────────────
 *
 * Every figure here is taken from the view-model the panel below already
 * renders — `flowFunnel`, `payoutView`, `payoutRunwayNote`, the runway
 * projection — so the strip cannot drift from the board it summarises. A KPI
 * that recomputed its own settled count would eventually disagree with the
 * funnel two hundred pixels underneath it, and the operator would have no way
 * to tell which one was lying.
 *
 * Absence stays absence: a figure the payload did not report renders "—" with
 * the reason in its sub-line, never 0. The reason a strip like this is
 * dangerous is precisely that a big confident numeral reads as measured.
 */
export function boardKpis(health: ProductHealth, gas?: GasSpendView | undefined): KpiView[] {
  const funnel = flowFunnel(health.flow);
  const evidence = payoutView(health.flow?.payout);
  const payout = health.flow?.payout;
  const pools = health.solvency?.pools ?? [];
  const rewardPool = pools.find((p) => p.key === "reward_bank");
  const gasPool = pools.find((p) => p.key === "signer_gas");
  const gasRunway = (health.solvency?.runway ?? []).find((r) => r.key === "signer_gas");

  // 1. SETTLED — the funnel's own terminal count, with its tails.
  const settledSub =
    health.flow == null
      ? "no settlement counts reported"
      : [
          `${funnel.stuck} stuck`,
          `${funnel.failed} failed`,
          health.lifecycle?.externalPct == null ? null : `${health.lifecycle.externalPct}% external`,
        ]
          .filter(Boolean)
          .join(" · ");

  // 2. PROVEN — the independent chain read. Its tone is the evidence tone, so
  //    a shortfall or a blind instrument is visible in the strip, not only in
  //    the panel below.
  const proven: KpiView = {
    key: "proven",
    label: "Proven on-chain",
    value: payout?.confirmedCount == null ? "—" : String(payout.confirmedCount),
    ...(payout?.confirmedCount == null ? {} : { unit: payout.confirmedCount === 1 ? "payout" : "payouts" }),
    sub:
      payout?.confirmedCount == null
        ? evidence.delta
        : `${payout.confirmedUsdc == null ? "amount unreadable" : `${formatAmount(payout.confirmedUsdc)} USDC`} · ${evidence.status.toLowerCase()}`,
    tone: evidence.tone,
  };

  // 3. RUNWAY — payouts remaining, the same projection the reward-bank note
  //    makes. Reusing it keeps one arithmetic on screen.
  const projection = payoutsRemaining({ pool: rewardPool, payout });
  const runwayNote = payoutRunwayNote({ pool: rewardPool, payout, runwayNote: health.solvency?.runwayNote });
  const runway: KpiView = {
    key: "runway",
    label: "Reward runway",
    value: projection?.status === "ok" ? `≈${projection.payouts}` : "—",
    ...(projection?.status === "ok" ? { unit: projection.payouts === 1 ? "payout" : "payouts" } : {}),
    sub:
      projection == null
        ? "reward bank balance not reported"
        : projection.status === "ok"
          ? `${formatAmount(rewardPool!.amount!)} ${rewardPool!.unit} in the bank`
          : (runwayNote?.text ?? "cannot project"),
    tone: runwayNote?.tone ?? "awaiting",
  };

  // 4. GAS — the pool that stops settlement when it empties, with its
  //    time-to-floor when the server could estimate one.
  const gasSub =
    gasRunway?.estimable && gasRunway.hoursToFloor != null
      ? `≈${Math.round(gasRunway.hoursToFloor)}h to floor at the measured burn`
      : gas?.perSettlement != null
        ? `${gas.perSettlement.toFixed(3)} DOT per settlement`
        : gasPool?.floor == null
          ? "no floor declared"
          : `floor ${formatAmount(gasPool.floor)} ${gasPool.unit}`;

  return [
    {
      key: "settled",
      label: "Settled · 24h",
      value: funnel.settled,
      sub: settledSub,
      tone: funnel.tone,
    },
    proven,
    runway,
    {
      key: "gas",
      label: "Signer gas",
      value: gasPool?.amount == null ? "—" : formatAmount(gasPool.amount),
      ...(gasPool?.amount == null ? {} : { unit: gasPool.unit }),
      sub: gasSub,
      tone: gasRunway?.status ?? (gasPool?.amount == null ? "awaiting" : gasPool.status),
    },
  ];
}

/**
 * The deposit pool's cap meter — the one bounded scale on the BANK side.
 *
 * Same rule as the solvency meters: a bar is only honest against a scale that
 * does not move with the value. The configured cap IS such a scale, so
 * utilisation can be drawn against it. Either half missing → no bar at all —
 * a meter against a guessed cap would be the auto-fitted two-thirds-full
 * failure this board removed from the pools.
 */
export function capMeterView(
  caps: { totalAssetCap?: { raw: string; decimals?: number }; utilizationBps?: number } | undefined,
): { fillPct: number; over: boolean; title: string } | null {
  if (!caps || typeof caps.utilizationBps !== "number" || !caps.totalAssetCap) return null;
  const pct = caps.utilizationBps / 100;
  return {
    fillPct: Math.max(0, Math.min(100, pct)),
    // Past the cap (it can be lowered under the current assets) the bar pegs —
    // and says so, exactly like a pool meter past its top rung. A pegged bar
    // that looks merely full conflates "at cap" with "over cap".
    over: pct > 100,
    title: `${pct.toFixed(2)}% of the ${formatPoolAmount(caps.totalAssetCap, "USDC")} cap — scale is the cap, fixed`,
  };
}

export function formatPoolAmount(
  amount: { raw: string; decimals?: number } | undefined,
  unit: string,
): string {
  if (!amount) return `— ${unit}`;
  if (amount.decimals === undefined) return `${groupRaw(amount.raw)} raw`;
  const negative = amount.raw.startsWith("-");
  const digits = negative ? amount.raw.slice(1) : amount.raw;
  const padded = digits.padStart(amount.decimals + 1, "0");
  const split = padded.length - amount.decimals;
  const whole = padded.slice(0, split);
  const fraction = padded.slice(split).replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupRaw(whole)}${fraction ? `.${fraction}` : ""} ${unit}`;
}

function groupRaw(raw: string): string {
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
