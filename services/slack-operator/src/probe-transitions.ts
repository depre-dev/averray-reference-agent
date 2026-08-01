// Per-probe transition alerts — what gets said in #Ops when a single probe
// crosses, as opposed to when the whole board does.
//
// `decideOpsNarration` already speaks on the OVERALL status crossing the red
// boundary. That is the right granularity for "the product is in trouble" and
// the wrong one for "external_funnel says a bond slashes in 9h" — which is
// actionable, specific, and does not necessarily move the overall verdict at
// all. This module covers the second case and leaves the first alone.
//
// ── EDGE-TRIGGERED, AND WHY THE KEY IS NOT THE DETAIL ───────────────────────
//
// Firing on state rather than on transitions is how a channel becomes noise: a
// probe that stays degraded for six hours would repost every heartbeat, and an
// operator learns to scroll past the one channel built to be worth reading.
//
// But "has the detail changed" is the WRONG test for whether something is new,
// and the external_funnel probe proves it: its detail counts down — "slashes in
// 9h", then "8h", then "7h". Keyed on the raw string, that re-alerts every
// single poll while saying nothing new. Same trap the payout alert hit, where
// the detail carried drifting USDC totals and the key had to become the gap.
//
// So the key is a REASON CLASS: the probe, its status, and its detail with the
// volatile parts blanked. A countdown ticking is the same alert; a countdown
// becoming a different problem is a new one.
//
// Kept pure — no clock, no I/O, no config — so every rule here is testable
// without a relay or a heartbeat.

import type { ProbeResult, ProbeStatus } from "./product-health.js";

export interface ProbeTransitionAlert {
  probe: string;
  /** "opened" — entered degraded/red. "recovered" — returned to ok. */
  kind: "opened" | "recovered";
  from: ProbeStatus;
  to: ProbeStatus;
  /** The message to post, carrying the probe's own reason verbatim. */
  text: string;
  /** Stable identity of THIS alert; the caller stores it to avoid repeats. */
  key: string;
}

export interface DecideProbeTransitionsInput {
  /** Probe status + detail as of the previous tick. Empty on first run. */
  previous: ReadonlyMap<string, ProbeResult>;
  current: readonly ProbeResult[];
  /** Keys already posted; a key present here is not posted again. */
  posted: ReadonlySet<string>;
  /** Operator mute — quiet everywhere, same rule the narration follows. */
  muted: boolean;
}

export interface ProbeTransitionDecision {
  alerts: ProbeTransitionAlert[];
  /** Keys to retain for the next tick — the caller replaces its set with this. */
  keys: Set<string>;
  /** Probe state to carry into the next tick. */
  next: Map<string, ProbeResult>;
}

/**
 * Collapse a probe's detail to its SHAPE, so a moving number is not mistaken
 * for a new problem.
 *
 * Hex ids and digits are the two things that drift while the situation holds
 * still: a countdown, a balance, a job id rotating through a queue. Blanking
 * them means "rejected 0xaa4b… slashes in 9h" and "…in 8h" share a class, while
 * "…slashes in 9h" and "…dispute window LAPSED" do not.
 */
export function reasonClass(probe: ProbeResult): string {
  const shape = probe.detail
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "0x*")
    .replace(/\d+(\.\d+)?/g, "*");
  return `${probe.name}:${probe.status}:${shape}`;
}

/** Human line for the channel. The probe's own words, prefixed so it is greppable. */
function alertText(probe: ProbeResult, kind: "opened" | "recovered"): string {
  return kind === "opened"
    ? `⚠ ${probe.name}: ${probe.detail}`
    : `✓ ${probe.name} recovered: ${probe.detail}`;
}

const isAlarm = (status: ProbeStatus): boolean => status === "degraded" || status === "red";

/**
 * Decide which probes changed in a way worth saying out loud.
 *
 * Rules, each with a reason:
 *  · A probe with no previous reading NEVER alerts. First sight is the boot
 *    transition — the same reason `decideOpsNarration` stays silent on prev
 *    "unknown". Otherwise every restart pages the operator about a state that
 *    has not changed.
 *  · Entering degraded or red alerts, including degraded→red and red→degraded:
 *    both are a material change in what is wrong.
 *  · Returning to ok alerts once, because a channel that only reports bad news
 *    leaves you to guess whether it is over.
 *  · A probe that vanishes says nothing. Absence is not recovery, and claiming
 *    it would be the same lie as a fake green.
 */
export function decideProbeTransitions(input: DecideProbeTransitionsInput): ProbeTransitionDecision {
  const alerts: ProbeTransitionAlert[] = [];
  const keys = new Set<string>();
  const next = new Map<string, ProbeResult>();

  for (const probe of input.current) {
    next.set(probe.name, probe);
    const before = input.previous.get(probe.name);

    // First sight — record it, say nothing.
    if (!before) continue;
    if (before.status === probe.status && !isAlarm(probe.status)) continue;

    const enteringAlarm = isAlarm(probe.status) && before.status !== probe.status;
    const recovered = !isAlarm(probe.status) && isAlarm(before.status);

    if (isAlarm(probe.status)) {
      // Carry the key forward whether or not we post: a probe that stays in the
      // same reason class must not re-post when some other probe changes.
      const key = reasonClass(probe);
      keys.add(key);
      if (!enteringAlarm && !input.posted.has(key)) {
        // Status unchanged but the reason CLASS moved — a different problem
        // wearing the same severity. Worth saying; the operator's next action
        // differs.
        if (!input.muted) {
          alerts.push({ probe: probe.name, kind: "opened", from: before.status, to: probe.status, text: alertText(probe, "opened"), key });
        }
        continue;
      }
      if (enteringAlarm && !input.posted.has(key) && !input.muted) {
        alerts.push({ probe: probe.name, kind: "opened", from: before.status, to: probe.status, text: alertText(probe, "opened"), key });
      }
      continue;
    }

    if (recovered) {
      const key = `${probe.name}:recovered:${reasonClass(before)}`;
      if (!input.posted.has(key) && !input.muted) {
        alerts.push({ probe: probe.name, kind: "recovered", from: before.status, to: probe.status, text: alertText(probe, "recovered"), key });
      }
      // Recovery keys are NOT retained: the next time this probe breaks and
      // heals, that is genuinely new and must be sayable again.
    }
  }

  return { alerts, keys, next };
}
