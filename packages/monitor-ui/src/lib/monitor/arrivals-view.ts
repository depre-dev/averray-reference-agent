// ARRIVALS view-model — the wallet-journey shape behind the OUTSIDERS panel.
//
// The visual grammar comes from the Averray design system's operator kit
// (records as KPI cards, instrumentation as a table, counts in mono); this
// module derives the one shape that needs derivation, without crossing the
// lines the registry design drew:
//
//   · pre-identity counters (reached/browsed/evaluated) are CALLS from
//     independent instruments and stay un-charted — a bar chart over them was
//     deliberately removed once, and this module must not resurrect it;
//   · from `identified` onward, rows are distinct SIWE wallets reaching AT
//     LEAST that stage — monotonic by construction, which is what makes a
//     fill drawn behind the count honest;
//   · the two doors carry different windows and different cut-overs, so each
//     door scales to its OWN maximum and nothing ever sums or compares them.

import type { ArrivalAgent, ArrivalOperatorView, ArrivalsBlock } from "./product-health.js";

export interface JourneyStageView {
  stage: string;
  /** Distinct wallets reaching at least this stage, this door, its window. */
  count: number;
  /** 0..100 against THIS door's own busiest wallet stage. Zero draws no fill. */
  fillPct: number;
}

export interface DoorJourneyView {
  door: "mcp" | "http";
  label: string;
  sinceMs: number | null;
  window: string;
  /** Empty when the producer reported no wallet-unit rows for this door. */
  stages: JourneyStageView[];
}

/**
 * The wallet half of each door's instrumentation.
 *
 * Only rows whose unit is `agents` qualify — the producer's own declaration of
 * "distinct wallets reaching at least this stage". Rows keep producer order; a
 * nonzero count always gets a visible fill (a 1-wallet stage beside a
 * 164-wallet stage rounds to nothing, and "too small to draw" must not look
 * like "nobody ever got here").
 */
export function doorJourneys(view: ArrivalOperatorView): DoorJourneyView[] {
  return (["mcp", "http"] as const).map((door) => {
    const evidence = view.doors[door];
    const wallets = (evidence?.rows ?? []).filter((r) => r.unit === "agents");
    const max = Math.max(1, ...wallets.map((r) => r.outsider));
    return {
      door,
      label: door === "mcp" ? "MCP" : "HTTP",
      sinceMs: evidence?.sinceMs ?? null,
      window: evidence?.window ?? "all-time",
      stages: wallets.map((r) => ({
        stage: r.stage,
        count: r.outsider,
        fillPct: r.outsider === 0 ? 0 : Math.max(5, Math.round((r.outsider / max) * 100)),
      })),
    };
  });
}

// ── WHO SHOWED UP — the named-identity roster ───────────────────────────────
//
// The registry (`arrivals.agents`) is the only per-identity evidence the board
// gets. It answers what every count above it cannot: an outsider that reached
// `submitted` by calling /auth/nonce → /jobs/claim → /jobs/submit is demand;
// an anonymous caller that made 127 requests in 18 seconds asking for
// /wp-login.php and /.env is a scanner. Both are "an outsider reached us", and
// only the routes tell them apart.
//
// ── THE THREE BANDS ARE DERIVED FROM ONE FIELD ────────────────────────────
//
// Depth comes from `furthestStage`, which the producer decides. Nothing here
// infers intent from a route, a name, or a key prefix: the roster shows what
// was called and lets the operator read it. Calling something "hostile" would
// be a judgement this board has no evidence for — `GET /wp-login.php` on a
// service that has no WordPress is evidence, and it speaks for itself.

/** The stages that mean an outsider did WORK, not just looked around. */
const WORKED_STAGES = new Set(["claimed", "submitted", "settled"]);
/** Reached us and got as far as identifying — interest, not yet work. */
const ENGAGED_STAGES = new Set(["browsed", "evaluated", "identified", "authenticated"]);

export type OutsiderBand = "worked" | "engaged" | "knocked";

export interface OutsiderRow {
  key: string;
  /** "mcpbeat 0.1" · "0x191c…3b0e" · "unattributed caller" — never invented. */
  label: string;
  band: OutsiderBand;
  furthestStage: string;
  calls: number;
  lastSeenMs: number;
  firstSeenMs: number;
  doors: string[];
  /** Busiest routes/tools first, capped. Empty when none were recorded. */
  topRoutes: Array<{ route: string; calls: number }>;
  /** True when nothing at all was recorded — "none recorded", never "none". */
  routesUnrecorded: boolean;
}

export interface OutsiderRoster {
  /** Newest activity first, within band order: worked → engaged → knocked. */
  rows: OutsiderRow[];
  counts: Record<OutsiderBand, number>;
  /** Named identities beyond the cap, still in the registry. Never hidden. */
  more: number;
}

/** Which band a stage falls in. Unknown stages are `knocked` — the floor. */
export function outsiderBand(stage: string): OutsiderBand {
  if (WORKED_STAGES.has(stage)) return "worked";
  if (ENGAGED_STAGES.has(stage)) return "engaged";
  return "knocked";
}

/**
 * A readable name for an identity, from what the producer actually gave.
 *
 * Order is deliberate: a declared client name is what the caller told us, a
 * wallet is what they proved, and an unattributed key is neither. The key's
 * own prefix is never dressed up — `anon:7eba…` becomes "unattributed
 * caller", which is what it is.
 */
export function outsiderLabel(agent: ArrivalAgent): string {
  if (agent.name) return agent.version ? `${agent.name} ${agent.version}` : agent.name;
  if (agent.wallet) return `${agent.wallet.slice(0, 6)}…${agent.wallet.slice(-4)}`;
  if (agent.key.startsWith("wallet:")) {
    const w = agent.key.slice(7);
    return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
  }
  return "unattributed caller";
}

/**
 * The roster, outsiders only, deepest band first and newest within it.
 *
 * `null` when the producer sent no registry — the caller says so rather than
 * drawing an empty list, because "we cannot see who arrived" and "nobody
 * arrived" are the two states this whole panel exists to keep apart.
 */
export function outsiderRoster(
  arrivals: ArrivalsBlock | undefined,
  max = 8,
  maxRoutes = 4,
): OutsiderRoster | null {
  if (!arrivals || "unavailable" in arrivals || !arrivals.agents) return null;

  // Ours and ambiguous never enter: a self-marked probe read as an arrival
  // manufactures demand evidence, and an ambiguous one cannot be claimed.
  const outsiders = arrivals.agents.filter((a) => !a.self && !a.ambiguous);
  const bandRank: Record<OutsiderBand, number> = { worked: 0, engaged: 1, knocked: 2 };

  const rows: OutsiderRow[] = outsiders
    .map((agent) => {
      const routes = Object.entries(agent.tools ?? {})
        .filter(([, n]) => typeof n === "number" && n > 0)
        .sort((a, b) => b[1] - a[1]);
      return {
        key: agent.key,
        label: outsiderLabel(agent),
        band: outsiderBand(agent.furthestStage),
        furthestStage: agent.furthestStage,
        calls: agent.calls,
        lastSeenMs: agent.lastSeenMs,
        firstSeenMs: agent.firstSeenMs,
        doors: agent.doors ?? [],
        topRoutes: routes.slice(0, maxRoutes).map(([route, calls]) => ({ route, calls })),
        routesUnrecorded: routes.length === 0,
      };
    })
    .sort((a, b) => bandRank[a.band] - bandRank[b.band] || b.lastSeenMs - a.lastSeenMs);

  const counts: Record<OutsiderBand, number> = { worked: 0, engaged: 0, knocked: 0 };
  for (const row of rows) counts[row.band] += 1;

  return { rows: rows.slice(0, max), counts, more: Math.max(0, rows.length - max) };
}

export interface OutsiderPresence {
  /** The deepest band any named outsider reached. */
  band: OutsiderBand | null;
  counts: Record<OutsiderBand, number>;
  /** Epoch ms of the most recent named outsider activity; null when none. */
  lastSeenMs: number | null;
  /**
   * The clock every age on this strip is measured against — the PRODUCER's,
   * never the reader's. See below.
   */
  asOfMs: number;
  /** True while that activity is inside the live window (default 1h). */
  live: boolean;
  /**
   * Epoch ms the registry has been observing since, when the producer says.
   * The counts are all-time against this, and the strip states it: "1 worked"
   * with no window reads as today, and the registry has never meant that.
   */
  observingSinceMs: number | null;
}

/**
 * The glanceable version, for the top band: is anyone out there, how deep did
 * they get, and how long ago?
 *
 * ── ONE CLOCK, AND IT IS THE PRODUCER'S ───────────────────────────────────
 *
 * `lastSeenMs` is a producer timestamp, so its age is measured against
 * `generatedAtMs` — the same snapshot clock the trust panel uses, for the same
 * reason: a reader's clock ticking on its own keeps a dead feed looking alive,
 * and mixing the two puts two different ages for ONE event on one screen. That
 * is not hypothetical — this strip and the roster below it disagreed by a
 * minute the first time they rendered together.
 *
 * `null` when the registry is absent — the strip renders nothing at all rather
 * than a confident zero.
 */
export function outsiderPresence(
  arrivals: ArrivalsBlock | undefined,
  fallbackNowMs: number,
  liveWindowMs = 3_600_000,
): OutsiderPresence | null {
  const roster = outsiderRoster(arrivals, Number.MAX_SAFE_INTEGER);
  if (!roster || !arrivals || "unavailable" in arrivals) return null;
  // The producer's own clock when it sent one; the reader's only as a last
  // resort, and then it is the same clock the rest of the board falls back to.
  const asOfMs = arrivals.generatedAtMs ?? fallbackNowMs;
  const lastSeenMs = roster.rows.reduce<number | null>(
    (acc, r) => (acc == null || r.lastSeenMs > acc ? r.lastSeenMs : acc),
    null,
  );
  const band: OutsiderBand | null = roster.counts.worked > 0
    ? "worked"
    : roster.counts.engaged > 0
      ? "engaged"
      : roster.counts.knocked > 0
        ? "knocked"
        : null;
  return {
    band,
    counts: roster.counts,
    lastSeenMs,
    asOfMs,
    live: lastSeenMs != null && asOfMs - lastSeenMs <= liveWindowMs,
    observingSinceMs: arrivals.observingSinceMs ?? null,
  };
}
