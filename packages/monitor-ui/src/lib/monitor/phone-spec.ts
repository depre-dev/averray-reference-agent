// The phone board's view-model.
//
// Same product and same rules as the desktop board, opposite medium. Desktop
// hierarchy is SPATIAL — everything is on screen and the verdict is bigger.
// Phone hierarchy is SEQUENTIAL — the verdict is FIRST and may never be
// scrolled past, and anything below the fold has to have earned it.
//
// So this module is mostly about CUTS, and the cuts are load-bearing:
//   · eight probe rows collapse to four one-line rollups, and a probe only
//     spends a second line when it is not ok;
//   · the three unfloored pools collapse to a single grey line — on desktop
//     "a meter needs a scale" means no bar, here it means no row;
//   · LLM spend is gone entirely.
//
// The verdict, the meters and the payout evidence are NOT re-derived here. They
// come from ops-spec / @avg/schemas so the two surfaces cannot disagree about
// what is wrong — which was the whole reason the verdict moved server-side.

import { ARRIVAL_STAGES } from "./product-health.js";
import type { HealthHistory, ProductHealth, SolvencyPool , ArrivalStage } from "./product-health.js";
import { deriveOpsVerdict, verdictProbeLabel } from "@avg/schemas/ops-verdict";
import { formatAgo, formatAmount, formatDuration, groupProbesByPillar, probeOpsTone, type OpsTone } from "./ops-model.js";
import { formatPoolAmount, poolMeter, shortEndpoint, staleAfterMs, type MeterView } from "./ops-spec.js";

// ── the verdict field ───────────────────────────────────────────────────────

export interface PhoneVerdict {
  /** Small caps line above. Re-captions to LAST KNOWN when untrusted. */
  kicker: string;
  headline: string;
  sub: string;
  tone: OpsTone;
  /** A long headline needs smaller type; the field is fixed-width, not the text. */
  compact: boolean;
}

/**
 * The verdict, as a solid filled field.
 *
 * This is the only filled surface in the product, and it is filled on purpose:
 * a phone is read at arm's length, often outdoors, and shape plus colour resolve
 * before any word does. The operator should know whether to go back to their day
 * without reading.
 *
 * The verdict itself is `deriveOpsVerdict` — the same decision the desktop
 * renders and the API emits. Only the framing is phone-specific.
 */
export function phoneVerdict(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  nowMs: number;
}): PhoneVerdict {
  const { health, streamDegraded, nowMs } = input;
  const core = deriveOpsVerdict({
    enabled: health.enabled,
    checks: health.checks,
    probes: health.probes,
    pools: health.solvency?.pools ?? [],
    runway: health.solvency?.runway ?? [],
    ...(health.flow?.payout ? { payout: health.flow.payout } : {}),
  });

  const untrusted = isUntrusted({ health, streamDegraded, nowMs });
  const asOf = health.at == null ? null : clockOf(health.at);
  const kicker = untrusted
    ? `LAST KNOWN — UNCONFIRMED ${health.at == null ? "—" : formatAgo(health.at, nowMs).replace(" ago", "")}`
    : `VERDICT · API-DECIDED${asOf ? ` · ${asOf}` : ""}`;

  return {
    kicker,
    headline: core.headline,
    sub: phoneSub(core.sub, core.reason, untrusted ? asOf : null),
    tone: core.tone,
    // The field is a fixed width; a long headline gets smaller type rather than
    // a taller field, so the fold below it does not move around.
    compact: core.headline.length > 12,
  };
}

/**
 * The desktop subline, cut to phone length.
 *
 * Desktop appends the full probe census ("6 ok / 1 degraded (acknowledged) /
 * 1 red") because it has the width. On a phone that wraps to four lines and
 * pushes the money below the fold — and the census is already downstairs as the
 * four pillar rollups, so carrying it here costs the fold and says nothing new.
 * Drop it; keep the clauses that name the fault, and stamp the as-of when the
 * reading is not confirmable.
 */
function phoneSub(sub: string, reason: string, asOf: string | null): string {
  if (reason === "nominal") {
    return ["floors clear · money moving · proven on-chain", asOf ? `as of ${asOf}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  const kept = sub
    .split(" · ")
    // The census is the only clause shaped "<n> ok …"; everything else is prose
    // about what is actually wrong.
    .filter((clause) => !/^\d+ ok\b/.test(clause.trim()))
    .join(" · ");
  return [kept, asOf ? `as of ${asOf}` : null].filter(Boolean).join(" · ");
}



/** Stream down, or a snapshot older than the cadence allows. */
export function isUntrusted(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  nowMs: number;
}): boolean {
  const { health, streamDegraded, nowMs } = input;
  if (streamDegraded) return true;
  if (health.at == null) return false;
  return nowMs - health.at > staleAfterMs(health);
}

function clockOf(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(11, 19)}Z`;
}

// ── the trust strip ─────────────────────────────────────────────────────────

export interface PhoneTrust {
  line: string;
  tone: OpsTone;
}

/**
 * Desktop's four-row trust panel, compressed to one line and welded under the
 * verdict.
 *
 * It cannot be cut: "should I believe this screen" matters MORE on a phone, not
 * less, because the operator has no second way to check. So it compresses
 * rather than disappearing, and when it degrades it does not merely turn red —
 * the verdict above it re-captions itself LAST KNOWN.
 */
export function phoneTrust(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  streamStatus: string;
  nowMs: number;
}): PhoneTrust {
  const { health, streamDegraded, streamStatus, nowMs } = input;
  const parts: string[] = [];

  if (streamDegraded) parts.push(`stream DOWN · ${streamStatus}`);
  else parts.push(health.at == null ? "no check yet" : `live · ${formatAgo(health.at, nowMs)}`);

  const self = health.self;
  parts.push(
    !self
      ? "build unknown"
      : self.status === "current"
        ? `${(self.runningSha ?? "").slice(0, 8) || "sha ?"} current`
        : self.status === "behind"
          ? `${self.behindBy ?? "?"} behind main`
          : "build unknown",
  );

  // Whether the alert channel works belongs on the PHONE more than anywhere
  // else: this screen is what an operator reaches for after a notification, so
  // "you would not have been told" is the one fact that changes what they do
  // next. Only said when it is not fine — a healthy channel does not need to
  // spend a phone's trust line saying so.
  const buzz = health.buzz;
  if (buzz && buzz.status === "failing") parts.push("#ops NOT DELIVERING");
  else if (buzz && buzz.status === "armed") parts.push("#ops untested");

  const rem = health.remediation;
  if (rem?.enabled && rem.state !== "off") {
    // The host, not the URL — in prod this is a full endpoint and it took the
    // whole line, which on a phone is the entire trust budget.
    parts.push(shortEndpoint(rem.activeEndpoint) ?? rem.state);
  }

  const tone: OpsTone = streamDegraded
    ? "red"
    : isUntrusted({ health, streamDegraded, nowMs })
      ? "red"
      // A channel that cannot deliver means the next alert will not arrive.
      // Degraded, not red: the product is fine and colouring it red would be
      // the false alarm this board is careful never to raise.
      : health.buzz?.status === "failing"
        ? "degraded"
        : self && self.status === "behind"
          ? "degraded"
          : "ok";

  return { line: parts.join(" · "), tone };
}

// ── the breach card (alert landing only) ────────────────────────────────────

export interface BreachCard {
  label: string;
  amount: string;
  unit: string;
  /** "short 0.58" — the absolute gap, never a percentage. */
  short: string;
  floorLabel: string;
  meter: MeterView;
  /** When it first breached, from the durable incident log. */
  since: string;
  /** Whether we can still see it — with the stream down, honestly "unknown". */
  stillTrue: string;
  stillTrueTone: OpsTone;
  /** What happens if it empties. */
  consequence: string;
  /** Where to send funds, when the breached pool is one you can top up.
   *  Absent for pools that are not wallets — see topUpAddress. */
  topUp?: { evm: string; ss58?: string };
}

/**
 * Which breached pools an operator can actually FUND from their phone.
 *
 * Only signer gas. The reward bank is an in-contract position with no address
 * of its own, and the rest are contracts — DOT sent to EscrowCore lands
 * somewhere with no way back. Showing an address beside a pool you cannot top
 * up would invite exactly that mistake, at the worst moment, on the smallest
 * screen.
 */
const TOP_UP_POOLS = new Set(["signer_gas"]);

const POOL_CONSEQUENCE: Record<string, string> = {
  reward_bank: "payouts halt — the reward bank funds every payout",
  signer_gas: "transactions stop being signed — no settlement can land",
  aac: "agent balances cannot be credited",
};

/**
 * The alert-landing card: what the notification could NOT say.
 *
 * Buzz already told the operator WHAT is wrong. Tapping through has to earn the
 * tap by answering how bad, since when, and — crucially — whether it is still
 * true, because with the stream down the honest answer is "unknown" and a board
 * that implies otherwise is worse than one that says nothing.
 */
export function breachCard(input: {
  health: ProductHealth;
  streamDegraded: boolean;
  nowMs: number;
}): BreachCard | null {
  const { health, streamDegraded, nowMs } = input;
  const breached = (health.solvency?.pools ?? []).find(
    (p) => p.status === "red" && p.amount != null && p.floor != null && p.floor > 0,
  );
  if (!breached) return null;
  const meter = poolMeter(breached);
  if (!meter) return null;

  const amount = breached.amount!;
  const floor = breached.floor!;
  const untrusted = isUntrusted({ health, streamDegraded, nowMs });

  return {
    label: breached.label,
    amount: formatAmount(amount),
    unit: breached.unit,
    short: `short ${formatAmount(floor - amount)}`,
    floorLabel: `of floor ${formatAmount(floor)}`,
    meter,
    since: breachSince(health.history, breached, nowMs),
    stillTrue: untrusted
      ? `unknown — ${streamDegraded ? "stream down" : "data stale"}; last confirmed ${health.at == null ? "—" : clockOf(health.at)}`
      : `yes — confirmed ${health.at == null ? "—" : formatAgo(health.at, nowMs)}`,
    stillTrueTone: untrusted ? "degraded" : "ok",
    consequence: POOL_CONSEQUENCE[breached.key] ?? "this pool is below the level the system needs",
    ...(TOP_UP_POOLS.has(breached.key) && breached.address
      ? {
          topUp: {
            evm: breached.address,
            ...(breached.addressSs58 ? { ss58: breached.addressSs58 } : {}),
          },
        }
      : {}),
  };
}

/**
 * When the breach started, from the DURABLE incident log — not from the
 * in-memory series, which a deploy empties.
 *
 * When there is no matching episode we say the start is unknown rather than
 * guessing at one. A fabricated "since" on a money alert is exactly the kind of
 * number an operator would act on.
 */
function breachSince(
  history: HealthHistory | undefined,
  pool: SolvencyPool,
  nowMs: number,
): string {
  const episodes = (history?.incidents ?? []).filter((i) => i.endedAt == null);
  // Solvency breaches surface through the liquidity probes.
  const match = episodes.find((i) => i.probe === "signer_liquidity" || i.probe === "treasury_liquidity");
  if (!match) return "start not recorded in the incident log";
  return `${clockOf(match.startedAt)} · ${formatDuration(Math.max(0, nowMs - match.startedAt))} ago${priorValue(history, pool)}`;
}

/**
 * "· was 2.31 at 09:15Z" — the last reading above the floor.
 *
 * Only rendered when the series carries its own timestamps (`seriesAt`). The
 * series used to be a bare number[] with no clock, and labelling a point with a
 * time we never recorded would be inventing evidence on a money alert.
 */
function priorValue(history: HealthHistory | undefined, pool: SolvencyPool): string {
  const series = history?.balanceSeries ?? [];
  const at = history?.seriesAt ?? [];
  const floor = pool.floor;
  if (series.length === 0 || at.length !== series.length || floor == null) return "";
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (typeof value === "number" && value >= floor) {
      return ` · was ${formatAmount(value)} at ${clockOf(at[i]!)}`;
    }
  }
  return "";
}

// ── probe rollups (below the fold) ──────────────────────────────────────────

export interface PillarRollup {
  name: string;
  tone: OpsTone;
  rollup: string;
  /** Only present when the pillar is NOT ok — otherwise the row is one line. */
  detail?: string;
  detailTone?: OpsTone;
}

const TONE_RANK: Record<OpsTone, number> = { red: 3, degraded: 2, awaiting: 1, ok: 0 };

/**
 * Four one-line rollups instead of eight probe rows.
 *
 * A probe earns a second line only when it is not ok, and the failing pillars
 * sort to the top — below the fold, reading order is the only hierarchy left.
 */
export function pillarRollups(health: ProductHealth): PillarRollup[] {
  const rows = groupProbesByPillar(health.probes).map((group) => {
    const tones = group.probes.map(probeOpsTone);
    const tone = tones.reduce<OpsTone>((acc, t) => (TONE_RANK[t] > TONE_RANK[acc] ? t : acc), "ok");
    const notOk = group.probes.filter((p) => probeOpsTone(p) !== "ok");
    const row: PillarRollup = {
      name: group.label.toUpperCase(),
      tone,
      rollup: summarise(group.probes.length, tones),
    };
    if (notOk.length > 0) {
      const lead = notOk[0]!;
      row.detail = `${verdictProbeLabel(lead.name).toLowerCase()}: ${lead.detail}`;
      row.detailTone = probeOpsTone(lead);
    }
    return row;
  });
  return rows.sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
}

function summarise(total: number, tones: OpsTone[]): string {
  const count = (t: OpsTone) => tones.filter((x) => x === t).length;
  const red = count("red");
  const degraded = count("degraded");
  const awaiting = count("awaiting");
  if (red > 0) return `${red} red`;
  if (degraded > 0) return `${degraded} degraded`;
  if (awaiting > 0) return `${count("ok")} ok · ${awaiting} awaiting`;
  return `${total}/${total} ok`;
}

// ── DEPOSIT POOL AND ARRIVALS, CUT TO PHONE SIZE ───────────────────────────
//
// Both facts arrived on the desktop board as full panels — six pool facts in a
// grid, and a two-column arrivals funnel of seven stages each. The phone was
// rendering the desktop pool tile verbatim (its own `ops-deposit-pool-*` CSS
// and all) and no arrivals at all, which is the one thing this module exists to
// prevent: a screen whose rule is "anything below the fold has to have earned
// it" cannot inherit a desktop grid unchanged.
//
// So each becomes ONE line, and expands only when it has something to ask for.

export interface PhoneLane {
  /** The line to render. Always present — absence is expressed IN the words. */
  line: string;
  tone: "ok" | "degraded" | "red" | "awaiting";
  /** Set when the reading itself failed, so the caller can fence it. */
  unreadable?: boolean;
}

/**
 * The deposit pool in one line.
 *
 * An empty pool is NOT a fault: this one was born empty and its zeroes are
 * measured, which the desktop says with a `BORN EMPTY · ZEROES ARE MEASURED`
 * kicker. On a phone there is no room for the kicker, so the line must not
 * imply alarm — an empty, readable pool is `ok` and says so plainly.
 *
 * `unavailable` (no producer) and `fault` (producer contradicted itself) stay
 * distinct, because "we cannot see the pool" and "the pool reported nonsense"
 * call for different operator moves.
 */
export function phonePool(pool: ProductHealth["depositPool"]): PhoneLane | null {
  if (!pool) return null;
  if ("unavailable" in pool) {
    return { line: `POOL — ${pool.unavailable}`, tone: "awaiting", unreadable: true };
  }
  if ("fault" in pool) {
    return { line: `POOL FAULT — ${pool.fault}`, tone: "red", unreadable: true };
  }

  const snap = pool.snapshot;
  // Same formatter the desktop tile uses — see formatPoolAmount in ops-spec.
  const deposits = snap.totalAssets ? formatPoolAmount(snap.totalAssets, "USDC") : null;
  const depositors = snap.flows?.depositorCount;
  const earning = snap.yieldStatus === "earning";

  const parts: string[] = [];
  // Absent is not zero: a pool whose amount did not come through says so
  // rather than rendering "0 USDC", which reads as a measured empty pool.
  parts.push(deposits ? `${deposits} in` : "amount not reported");
  if (depositors != null) parts.push(`${depositors} depositor${depositors === 1 ? "" : "s"}`);
  parts.push(earning ? "earning" : "not yet earning");

  return { line: `POOL ${parts.join(" · ")}`, tone: "ok" };
}

/** The last stage with a nonzero count, or null when the series is empty. */
function furthestReached(funnel: Record<string, number> | undefined): ArrivalStage | null {
  if (!funnel) return null;
  let furthest: ArrivalStage | null = null;
  for (const stage of ARRIVAL_STAGES) {
    if ((funnel[stage] ?? 0) > 0) furthest = stage;
  }
  return furthest;
}

/** What a stage MEANS, in the words an operator would use. */
const STAGE_DID: Record<ArrivalStage, string> = {
  reached: "arrived but went no further",
  browsed: "browsed jobs",
  evaluated: "sized up a job",
  identified: "identified itself",
  authenticated: "signed in",
  claimed: "claimed a job",
  submitted: "submitted work",
};

/**
 * Arrivals in one line: did anyone from outside show up, what did they do,
 * and how far did they get.
 *
 * ── WHY THE DOORS ARE COMBINED, AND WHY ON THIS AXIS ──────────────────────
 *
 * The first version named the two front doors (MCP and HTTP) and reported each
 * separately. The operator's verdict, 2026-08-06: the transport names mean
 * nothing to the person reading, who only wants to know whether somebody came
 * and how far they got.
 *
 * But the doors CANNOT be combined by adding. The board's own footnote records
 * that HTTP arrivals are counted only from a cutover and earlier traffic was
 * never backfilled, so the two series cover different spans of time. Summing
 * them would be arithmetic across unlike windows — the same class of error as
 * comparing a 24h chain read against a 25h ledger.
 *
 * FURTHEST-STAGE is the axis that survives the merge. "The furthest anybody
 * got" is well-defined however long each door has been watched: a stranger who
 * claimed a job did so whether or not the other door's history is complete.
 *
 * ── WHAT AN UNWATCHED DOOR DOES TO THE SENTENCE ───────────────────────────
 *
 * "Nobody came" is only sayable about doors we actually watched. When a door
 * has no external series the line says so, because a confident "nobody yet"
 * over an unmeasured door is a claim we did not earn.
 */
export function phoneArrivals(arrivals: ProductHealth["arrivals"]): PhoneLane | null {
  if (!arrivals) return null;
  if ("unavailable" in arrivals) {
    return { line: `OUTSIDERS — ${arrivals.unavailable}`, tone: "awaiting", unreadable: true };
  }

  // Prefer the registry-backed cross-door journey. The legacy call funnels
  // remain below only for deploy skew; they cannot express settlement history
  // or separate per-run canaries from outsiders as completely as this view.
  if (arrivals.operatorView && !("unavailable" in arrivals.operatorView)) {
    const { furthestEver, lastActivity } = arrivals.operatorView.outsiders;
    if (!furthestEver) return { line: "OUTSIDERS — no identified outsider yet", tone: "ok" };
    const did = furthestEver.stage === "settled" ? "settled work" : STAGE_DID[furthestEver.stage];
    const recency = lastActivity
      ? ` · last activity ${formatAgo(lastActivity.atMs, arrivals.operatorView.generatedAtMs)}`
      : "";
    return { line: `OUTSIDERS — someone ${did}${recency}`, tone: "ok" };
  }

  // The AMBIGUOUS bucket is in neither door's series on purpose: traffic under
  // a client name we also use ourselves cannot be called outside demand
  // without manufacturing it, nor ours without erasing a real stranger.
  const doors = [arrivals.funnelExternal, arrivals.funnelHttpExternal];
  const measured = doors.filter((d): d is Record<string, number> => d !== undefined);
  const unmeasured = doors.length - measured.length;

  if (measured.length === 0) {
    return { line: "OUTSIDERS — not measured", tone: "awaiting", unreadable: true };
  }

  // The furthest stage ANY door saw. Max, never sum — see above.
  let furthest: ArrivalStage | null = null;
  for (const door of measured) {
    const reached = furthestReached(door);
    if (reached && (furthest === null || ARRIVAL_STAGES.indexOf(reached) > ARRIVAL_STAGES.indexOf(furthest))) {
      furthest = reached;
    }
  }

  const caveat = unmeasured > 0 ? " · one door not measured" : "";
  const line = furthest
    ? `OUTSIDERS — someone ${STAGE_DID[furthest]}${caveat}`
    : unmeasured > 0
      ? "OUTSIDERS — nobody yet on the doors we measure"
      : "OUTSIDERS — nobody from outside yet";

  // Never red, never degraded. Nobody arriving is a demand fact, not a fault —
  // colouring it as a problem would put a business outcome in the same visual
  // language as a broken money path.
  return { line, tone: "ok" };
}
