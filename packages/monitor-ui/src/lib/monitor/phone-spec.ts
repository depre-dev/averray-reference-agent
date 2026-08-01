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

import type { HealthHistory, ProductHealth, SolvencyPool } from "./product-health.js";
import { deriveOpsVerdict, verdictProbeLabel } from "@avg/schemas/ops-verdict";
import { formatAgo, formatAmount, formatDuration, groupProbesByPillar, probeOpsTone, type OpsTone } from "./ops-model.js";
import { poolMeter, staleAfterMs, type MeterView } from "./ops-spec.js";

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

  const rem = health.remediation;
  if (rem?.enabled && rem.state !== "off") {
    parts.push(rem.activeEndpoint ?? rem.state);
  }

  const tone: OpsTone = streamDegraded
    ? "red"
    : isUntrusted({ health, streamDegraded, nowMs })
      ? "red"
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
}

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
