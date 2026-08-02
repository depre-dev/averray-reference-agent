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
 * Whether the window being compared is the window it claims to be.
 *
 * `decideWindowFit` has always computed this and the board has never shown it —
 * so the one sentence that says whether to BELIEVE the comparison above lived
 * only in JSON. A payout count from a window that does not span 24h, held
 * against a 24h ledger figure, is two different questions rendered as one
 * answer.
 *
 * Silent when the fit is `ok`: a window that matches needs no caption, and a
 * permanent "~24h at 2.16s/block" is the kind of always-true text a reader
 * stops seeing. Spoken when it is suspect or unchecked, which are the two cases
 * where the numbers beside it deserve doubt.
 */
function windowNote(payout: PayoutEvidence): string {
  const fit = payout.window;
  if (!fit || fit.status === "ok") return "";
  if (fit.status === "unknown") return " · window fit UNCHECKED — block time not measured";
  return ` · WINDOW SUSPECT — ${fit.detail}`;
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
      emphasised: false,
    };
  }

  const chainLine =
    payout.confirmedCount == null
      ? "chain not readable in this window"
      : `${payout.confirmedCount} payout${payout.confirmedCount === 1 ? "" : "s"} confirmed on-chain${
          payout.confirmedUsdc == null ? "" : ` · ${formatAmount(payout.confirmedUsdc)} USDC`
        }${feeNote(payout)}`;
  const ledgerLine =
    payout.settledCount == null
      ? "settled count unavailable"
      : `${payout.settledCount} marked settled by the monitor${windowNote(payout)}`;

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
export function payoutRunwayNote(input: {
  pool: SolvencyPool | undefined;
  payout: PayoutEvidence | undefined;
  runwayNote?: string | null | undefined;
}): { text: string; tone: OpsTone } | null {
  const { pool, payout } = input;
  if (!pool || pool.amount == null) return null;

  const usable = pool.amount - (pool.floor ?? 0);
  if (usable <= 0) return { text: "BELOW FLOOR — payouts will fail", tone: "red" };

  const count = payout?.confirmedCount ?? 0;
  const total = payout?.confirmedUsdc ?? null;
  if (count <= 0 || total == null || total <= 0) {
    return { text: "no payout average yet — cannot project", tone: "awaiting" };
  }
  const average = total / count;
  const payouts = Math.floor(usable / average);
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
  "disputeClockLine",
  "payoutRunwayNote",
  "gasPoolNote",
  "economicsLine",
] as const;
