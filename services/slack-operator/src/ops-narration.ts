// Proactive ops narration — the pure decision for whether Hermes should post a
// co-pilot turn about a product-health change, and what to say.
//
// Fires ONLY on an overall-status edge across the red boundary (entered-red /
// recovered). A probe staying red never re-posts, and the operator-configured
// product-health cooldown damps rapid red/recovered/red edge churn. It stays
// silent on the boot transition (prev "unknown", so a restart doesn't spam), on
// routine degraded↔healthy moves (those live in the Digest ops line), and while
// the operator is muted. Network tunes the wording: a mainnet red pages on-call;
// a testnet red is informational.
//
// ── AN ANNOUNCED ALARM MUST BE CLOSED ───────────────────────────────────────
//
// The cooldown used to apply symmetrically, and on 2026-08-06 that produced the
// worst possible outcome from a five-minute container DNS blip:
//
//   14:58  ⚠ Ops — Product API red …            posted, Buzz-published, paged
//   15:03  (recovered)                          {"edge":"recovered",
//                                                "suppressed":"cooldown"}
//
// The default cooldown is six hours, so the all-clear was not delayed — it was
// deleted. For the rest of the day the last thing any human had heard was an
// alarm about an outage that had already ended, and the board read as an
// ongoing incident.
//
// The asymmetry is the fix, and it is not a special case — it follows from what
// the two edges MEAN. A repeated red is redundant: the operator already knows,
// which is exactly what a cooldown is for. A recovery is never redundant, and a
// recovery that closes an announced alarm is the single most load-bearing
// message this channel sends. Suppressing it does not reduce noise; it converts
// a resolved incident into a permanent false alarm.
//
// So: the cooldown may silence reds. It may never silence the edge that closes
// a red we announced.
//
// Mute is deliberately still honoured. It is an explicit operator action rather
// than an automatic damper, it silences the opening red too (so in the ordinary
// case there is no announced alarm left hanging), and the board and the Digest
// both still show the state. That boundary is the same one probe-transitions.ts
// draws, and the two should not disagree.
//
// Kept pure (no I/O, no @avg deps) so it runs in the local unit suite; the
// caller (index.ts checkProductHealth) supplies prev/curr, the probes, the
// resolved network, current mute state, and the last successful narration time.

import { probeLabel } from "./ops-voice.js";

export type OpsStatus = "healthy" | "degraded" | "red" | "unknown";
export type OpsNetwork = "testnet" | "mainnet" | "unknown";

export interface OpsNarrationProbe {
  name: string;
  status: string;
  detail: string;
}

export interface DecideOpsNarrationInput {
  prev: OpsStatus;
  curr: OpsStatus;
  probes: readonly OpsNarrationProbe[];
  network: OpsNetwork;
  muted: boolean;
  /** Timestamp of the last successfully persisted narration post. */
  lastPostedAtMs?: number;
  nowMs?: number;
  /** Reuses PRODUCT_HEALTH_ALERT_COOLDOWN_MINUTES for transition narration. */
  cooldownMs?: number;
  /**
   * Was the currently-open red edge actually ANNOUNCED? Threaded across ticks by
   * the caller from the previous decision's `redAnnounced`.
   *
   * `undefined` is NOT "no". It means nobody told us — a fresh process that
   * booted into an ongoing red, or a standalone call — and the safe reading
   * there is that the alarm WAS announced, so the all-clear still goes out.
   * Silence is only correct when we have positive evidence we suppressed the
   * red ourselves. probe-transitions.ts learned this the hard way: defaulting
   * absent bookkeeping to "silent" swallowed every recovery it had.
   */
  redAnnounced?: boolean;
}

export interface OpsNarrationDecision {
  post: boolean;
  /** The edge that was detected (present even when suppressed, for logging). */
  edge?: "red" | "recovered";
  /** The Hermes turn text — present only when `post` is true. */
  text?: string;
  /** Why a real edge did not post (for observability). */
  suppressed?: "muted" | "cooldown" | "never-announced";
  /**
   * Whether an announced red is still open, to carry into the next tick. The
   * caller stores this and hands it back as `redAnnounced`; it is the state
   * that lets a recovery know whether it has an alarm to close.
   */
  redAnnounced: boolean;
}

// Probe naming lives in ops-voice.ts — one map for every chat surface.

function trim(detail: string, max = 160): string {
  const d = detail.trim();
  return d.length > max ? `${d.slice(0, max - 1)}…` : d;
}

export function decideOpsNarration(input: DecideOpsNarrationInput): OpsNarrationDecision {
  const { prev, curr, probes, network, muted } = input;
  // Carried through every non-posting path so the caller's state never resets
  // by accident — an announced red stays open until something closes it.
  const carried = input.redAnnounced ?? false;

  // Never narrate the boot transition — a restart shouldn't spam the thread.
  if (prev === "unknown") return { post: false, redAnnounced: carried };

  const enteredRed = prev !== "red" && curr === "red";
  const recovered = prev === "red" && curr !== "red";
  if (!enteredRed && !recovered) return { post: false, redAnnounced: carried };

  const edge: "red" | "recovered" = enteredRed ? "red" : "recovered";

  // Was there an alarm to close? Absent bookkeeping means "we don't know", and
  // the honest default is that there was — see `redAnnounced` on the input.
  const closesAnAnnouncedRed = recovered && (input.redAnnounced ?? true);

  // Mute = quiet everywhere; the state still shows passively in the Digest ops
  // line. Applied to both edges, so a muted red is not announced and there is
  // no dangling alarm for the matching recovery to owe an all-clear to.
  if (muted) return { post: false, edge, suppressed: "muted", redAnnounced: recovered ? false : carried };

  // A recovery for a red we KNOW we suppressed is an all-clear for an alarm
  // nobody was ever given. Saying it is its own small lie — it implies there was
  // something to be clear of. Same rule probe-transitions.ts applies per-probe.
  //
  // Decided BEFORE the cooldown so the log says why it was quiet. Both would be
  // true here, and "never-announced" is the one that explains itself; "cooldown"
  // would read as "delayed", which is what sent someone looking for a recovery
  // message that was never coming.
  if (recovered && !closesAnAnnouncedRed) {
    return { post: false, edge, suppressed: "never-announced", redAnnounced: false };
  }

  // A health probe can briefly cross red and recover when its upstream flakes.
  // Use the same operator-configured cooldown as D4 alerts so those edges remain
  // visible on the board without producing a red → recovered → red chat storm.
  //
  // This now governs RED EDGES ONLY. Every recovery that reaches this line
  // closes an announced alarm, and a cooldown exists to stop repeating what the
  // operator already heard — an all-clear is by definition something they
  // have not.
  const lastPostedAtMs = input.lastPostedAtMs ?? 0;
  const nowMs = input.nowMs ?? Date.now();
  const cooldownMs = Math.max(0, input.cooldownMs ?? 0);
  if (
    edge === "red"
    && cooldownMs > 0
    && lastPostedAtMs > 0
    && nowMs - lastPostedAtMs < cooldownMs
  ) {
    return { post: false, edge, suppressed: "cooldown", redAnnounced: carried };
  }

  if (edge === "red") {
    const reds = probes.filter((p) => p.status === "red");
    const lead = reds[0];
    const extra = reds.length > 1 ? ` (+${reds.length - 1} more)` : "";
    const tone = network === "mainnet" ? "On-call is paged." : "Testnet — informational.";
    const detail = lead?.detail ? `: ${trim(lead.detail)}` : "";
    return {
      post: true,
      edge,
      text: `⚠ Ops — ${lead ? probeLabel(lead.name) : "a probe"} red${detail}${extra}. ${tone}`,
      redAnnounced: true,
    };
  }

  return {
    post: true,
    edge,
    text: `✓ Ops recovered — product health back to ${curr}.`,
    redAnnounced: false,
  };
}
