// The operator verdict — ONE implementation, shared by the board and the API.
//
// The board renders this. `GET /monitor/product-health` emits it. An agent
// reading that endpoint therefore reads the board's CONCLUSION, not the raw
// facts it would otherwise have to judge for itself.
//
// That matters more than it sounds. Without this, an agent watching the product
// forms its own opinion from the same probes, and the two verdicts disagree —
// one deterministic and tested, one able to hallucinate. The first time the
// agent calls the deliberately-empty treasury reserve a problem, or reports
// long-acknowledged capability warnings as a new fault, the operator stops
// believing it. Then the agent is worse than nothing, because it also costs
// attention.
//
// So: the verdict is decided here, once. The board displays it. The agent
// explains it. Neither re-derives it.
//
// Inputs are STRUCTURAL on purpose — the service and the UI each keep their own
// ProductHealth interface, and this module deliberately depends on neither.

export type VerdictStatus = "ok" | "degraded" | "red";
export type VerdictTone = "ok" | "degraded" | "red" | "awaiting";

export interface VerdictProbe {
  name: string;
  status: VerdictStatus;
  detail: string;
}

export interface VerdictPool {
  label: string;
  /** null = not readable. Never coerce to 0 — that would be a claim. */
  amount: number | null;
  floor?: number | null;
  status: VerdictStatus;
}

export interface VerdictPayout {
  status: "confirmed" | "shortfall" | "unverified";
  confirmedCount: number | null;
  settledCount: number | null;
}

/**
 * A floored pool's projected time to its floor.
 *
 * `estimable` and a non-null `hoursToFloor` are the producer's own honesty
 * gates — too few samples, too short a window, flat, or refilling all resolve
 * to not-estimable — so a single reading cannot manufacture urgency.
 */
export interface VerdictRunway {
  label: string;
  hoursToFloor: number | null;
  burnPerHour: number | null;
  unit: string;
  estimable: boolean;
  status: VerdictStatus;
}

export interface VerdictInput {
  /** false = the heartbeat routine is off. Not a healthy state — an unknown one. */
  enabled: boolean;
  checks: number;
  probes: VerdictProbe[];
  pools?: VerdictPool[];
  payout?: VerdictPayout;
  /** Time-to-floor projections. Absent → no projection is made. */
  runway?: VerdictRunway[];
}

/**
 * Why the verdict is what it is, as an enum.
 *
 * An agent must never string-match "BELOW FLOOR" out of the headline. The
 * headline is prose for a human and may be reworded; `reason` is the contract.
 */
export type VerdictReason =
  | "not-watching"
  | "no-data"
  | "floor-breach"
  | "probe-red"
  | "payout-shortfall"
  | "probe-degraded"
  | "pool-draining"
  | "nominal";

export interface OpsVerdict {
  /** The one line, sized on the board to be read across a room. */
  headline: string;
  tone: VerdictTone;
  /** Counts and the leading detail — never vibes. */
  sub: string;
  /** "7 ok / 1 degraded (acknowledged) / 0 red". */
  census: string;
  reason: VerdictReason;
}

// Forward-compat phrasings from the product: "awaiting …", "not exposed [by
// /health] yet", "does not expose … yet", "not wired yet". `not expose` (no
// trailing d) matches both "not exposed" and "does not expose".
const AWAITING_RE = /awaiting|not expose|not wired|not configured|unconfigured|no data/i;

/**
 * A probe whose degraded status is really "upstream data not wired yet".
 *
 * ONLY `degraded`. This read `status !== "red"` until it was found to also sweep
 * in `ok` — and matching here is not cosmetic. An awaiting probe is dropped from
 * `unacknowledgedDegraded` (so it cannot raise the verdict) and is subtracted
 * from the ok count, rendering grey.
 *
 * So an `ok` probe whose prose merely contained one of these words was silently
 * demoted. `external_funnel` hit exactly that: it reported `ok` with the detail
 * "1 awaiting review" — a real job under review, nothing missing — and the board
 * greyed it and stopped counting it green. Renaming that one string fixed the
 * symptom and left the mechanism armed for the next probe to word itself badly.
 *
 * The rule that makes it unrepresentable: a probe reporting `ok` HAS its data.
 * That is what ok means, so prose cannot demote it. Only a `degraded` probe can
 * be degraded *because* something upstream is missing. `red` was already
 * excluded for the mirror-image reason — page-worthy leads whatever its detail
 * says.
 *
 * Note this now matches the shape of `isAcknowledgedProbe` below, which has
 * required `degraded` all along. They are siblings and should never have
 * differed.
 */
export function isAwaitingProbe(probe: { status: VerdictStatus; detail: string }): boolean {
  return probe.status === "degraded" && AWAITING_RE.test(probe.detail);
}

// A degradation the operator has already triaged and declared expected. On
// mainnet `capabilities` reads "4/7 up · 2 warnings acknowledged", and has done
// for weeks.
const ACKNOWLEDGED_RE = /\backnowledged\b/i;

/**
 * Has this degradation already been looked at and accepted?
 *
 * A permanently-lit alarm is one the operator learns to scroll past, and that
 * makes the NEXT alarm invisible — a false red costs as much as a false green.
 * An acknowledged probe therefore does not take the headline.
 *
 * It is never hidden: it keeps its amber dot on the board and is counted by
 * name in the census. Only the shouting stops. A `red` probe is never
 * acknowledgeable — page-worthy always leads, whatever its detail says.
 */
export function isAcknowledgedProbe(probe: { status: VerdictStatus; detail: string }): boolean {
  return probe.status === "degraded" && ACKNOWLEDGED_RE.test(probe.detail);
}

/** Degraded, and nobody has signed it off — the ones that earn the headline. */
function unacknowledgedDegraded(probes: readonly VerdictProbe[]): VerdictProbe[] {
  return probes.filter(
    (p) => p.status === "degraded" && !isAwaitingProbe(p) && !isAcknowledgedProbe(p),
  );
}

/** Acknowledged degradations are COUNTED and LABELLED, never dropped. */
export function probeCensus(probes: readonly VerdictProbe[]): string {
  const awaiting = probes.filter(isAwaitingProbe).length;
  const red = probes.filter((p) => p.status === "red").length;
  const acked = probes.filter((p) => isAcknowledgedProbe(p) && !isAwaitingProbe(p)).length;
  const degraded = unacknowledgedDegraded(probes).length;
  const ok = probes.length - red - degraded - acked - awaiting;
  const parts = [`${ok} ok`];
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (acked > 0) parts.push(`${acked} degraded (acknowledged)`);
  if (awaiting > 0) parts.push(`${awaiting} awaiting data`);
  parts.push(`${red} red`);
  return parts.join(" / ");
}

/** "−2", or "gap unknown" when either side of the comparison is missing. */
export function payoutGap(payout: VerdictPayout | undefined): string {
  if (!payout || payout.confirmedCount == null || payout.settledCount == null) return "gap unknown";
  return `−${Math.max(0, payout.settledCount - payout.confirmedCount)}`;
}

/** Human label for a probe name, e.g. `money_path` → "Money path". */
const PROBE_LABELS: Record<string, string> = {
  product_api: "Product API",
  api_latency: "API latency",
  disk_headroom: "Disk headroom",
  chain_height: "Chain height",
  capabilities: "Capabilities",
  signer_liquidity: "Signer liquidity",
  treasury_liquidity: "Treasury",
  money_path: "Money path",
};

export function verdictProbeLabel(name: string): string {
  return PROBE_LABELS[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Decide the verdict.
 *
 * The ordering IS the hierarchy, and it is deliberate:
 *
 *   breached floor  — the money stops moving when a pool empties
 *   red probe       — page-worthy
 *   payout shortfall— the chain says money did not move
 *   degradation     — watch it
 *   draining pool   — nothing has breached, but one is heading for its floor
 *   nominal
 *
 * `unverified` payout evidence is NOT in that list. It means we cannot see the
 * chain, which is an instrument fault, not a money fault; raising the verdict
 * on it is the false red that trains an operator to ignore verdicts.
 *
 * Note what this function does NOT take: any notion of a client connection, or
 * a clock. Data age and transport state are properties of the READER, not of
 * the product — the board layers its own "last known state" relabeling on top,
 * and an agent polling the endpoint applies its own staleness judgement.
 */
export function deriveOpsVerdict(input: VerdictInput): OpsVerdict {
  const { enabled, checks, probes, pools = [], payout, runway = [] } = input;

  if (!enabled) {
    return {
      headline: "NOT WATCHING",
      tone: "awaiting",
      sub: "PRODUCT_HEALTH_ENABLED is unset — nothing is probing the live product.",
      census: probeCensus(probes),
      reason: "not-watching",
    };
  }
  if (checks === 0) {
    return {
      headline: "NO DATA YET",
      tone: "awaiting",
      sub: "The heartbeat runs every couple of minutes. Nothing is known until it does.",
      census: probeCensus(probes),
      reason: "no-data",
    };
  }

  const census = probeCensus(probes);
  const shortfall = payout?.status === "shortfall";

  // A pool is only "breached" when we can actually READ it against a real
  // floor. An unreadable balance is unknown, and unknown is not a breach.
  const breached = pools.filter(
    (p) => p.status === "red" && p.amount != null && p.floor != null && p.floor > 0,
  );
  if (breached.length > 0) {
    const lead = breached[0]!;
    const extra = breached.length > 1 ? ` +${breached.length - 1}` : "";
    return {
      headline: `${lead.label.toUpperCase()} BELOW FLOOR${extra}`,
      tone: "red",
      sub: [
        shortfall ? `on-chain payout shortfall (${payoutGap(payout)})` : null,
        census,
        "payouts halt when the reward bank empties",
      ]
        .filter(Boolean)
        .join(" · "),
      census,
      reason: "floor-breach",
    };
  }

  const reds = probes.filter((p) => p.status === "red");
  if (reds.length > 0) {
    const lead = reds[0]!;
    const extra = reds.length > 1 ? ` +${reds.length - 1}` : "";
    return {
      headline: `${verdictProbeLabel(lead.name).toUpperCase()} RED${extra}`,
      tone: "red",
      sub: `${lead.detail} · ${census}`,
      census,
      reason: "probe-red",
    };
  }

  if (shortfall) {
    return {
      headline: "PAYOUT SHORTFALL",
      tone: "red",
      // The funnel can read perfectly clean while this is true. Say so — the
      // reader is about to look at counts that disagree with this verdict.
      sub: `${payoutGap(payout)} settled jobs have no on-chain proof · the funnel reads clean · ${census}`,
      census,
      reason: "payout-shortfall",
    };
  }

  const degraded = unacknowledgedDegraded(probes);
  if (degraded.length > 0) {
    const lead = degraded[0]!;
    const extra = degraded.length > 1 ? ` +${degraded.length - 1}` : "";
    return {
      headline: `${verdictProbeLabel(lead.name).toUpperCase()} DEGRADED${extra}`,
      tone: "degraded",
      sub: `${lead.detail} · ${census}`,
      census,
      reason: "probe-degraded",
    };
  }

  // Nothing has BREACHED — but a pool can be visibly draining toward its floor
  // while every probe still reads green. That was live on mainnet: seven probes
  // green while the co-pilot was simultaneously saying "signer gas ~13h to
  // floor, top up before settlement halts". A board that says NOMINAL through
  // that is technically correct and operationally useless.
  //
  // A projection is NOT a breach, so this never takes the red tone and never
  // outranks a real degradation — it only stops the board claiming all-clear
  // while something is heading for a cliff.
  const draining = runway
    .filter((r) => r.estimable && r.hoursToFloor !== null && (r.status === "red" || r.status === "degraded"))
    .sort((a, b) => (a.hoursToFloor ?? 0) - (b.hoursToFloor ?? 0));
  if (draining.length > 0) {
    const lead = draining[0]!;
    const extra = draining.length > 1 ? ` +${draining.length - 1}` : "";
    const hours = lead.hoursToFloor ?? 0;
    const when = hours <= 0 ? "at its floor" : hours < 1 ? "<1h to floor" : `~${Math.round(hours)}h to floor`;
    const burn =
      lead.burnPerHour && lead.burnPerHour > 0
        ? `${lead.burnPerHour >= 1 ? lead.burnPerHour.toFixed(1) : lead.burnPerHour.toFixed(2)} ${lead.unit}/h`
        : null;
    return {
      headline: `${lead.label.toUpperCase()} ${when.toUpperCase()}${extra}`,
      tone: "degraded",
      sub: [
        burn ? `projected from a ${burn} trend` : "projected from the recent trend",
        "nothing has breached yet",
        census,
      ].join(" · "),
      census,
      reason: "pool-draining",
    };
  }

  return {
    headline: "NOMINAL",
    tone: "ok",
    sub: [
      payout?.status === "confirmed" ? "money is moving and proven on-chain" : null,
      pools.some((p) => p.floor != null && p.floor > 0) ? "all floors clear" : null,
      census,
    ]
      .filter(Boolean)
      .join(" · "),
    census,
    reason: "nominal",
  };
}
