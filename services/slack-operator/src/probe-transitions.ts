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

import { probeLabel } from "./ops-voice.js";
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
  /**
   * Consecutive ticks each reason class has held, carried from the last call.
   * The caller threads this exactly like `posted` and `previous`.
   */
  streaks?: ReadonlyMap<string, number>;
  /**
   * How many consecutive ticks a DEGRADED class must hold before it is worth
   * saying. Default 3. `red` ignores this entirely — see holdRequired().
   */
  minDegradedTicks?: number;
}

export interface ProbeTransitionDecision {
  alerts: ProbeTransitionAlert[];
  /** Keys to retain for the next tick — the caller replaces its set with this. */
  keys: Set<string>;
  /** Probe state to carry into the next tick. */
  next: Map<string, ProbeResult>;
  /** Consecutive-tick counts to carry into the next tick. */
  streaks: Map<string, number>;
}

/**
 * How long a class must hold before it is worth saying out loud.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * On 2026-08-04 the #Ops channel carried eight near-identical capability
 * alerts, three of them inside the same minute:
 *
 *   1:25 PM  ⚠ new capability warning: indexer_lagging, external_posting_staged
 *   1:25 PM  ⚠ new capability warning: external_posting_staged
 *   1:25 PM  ⚠ new capability warning: indexer_lagging, external_posting_staged
 *   1:25 PM  ✓ capabilities recovered …
 *
 * Nothing was happening. One warning was entering and leaving the product's
 * warnings array as a watcher lag crossed a threshold, and because the reason
 * class is built from the detail text, each flip read as a NEW problem. The
 * existing `reasonClass` blanking handles a number that drifts; it cannot help
 * when the words themselves alternate.
 *
 * Keying more cleverly is the wrong fix — it means guessing which text changes
 * are meaningful, and guessing wrong in the quiet direction is how a real alert
 * gets swallowed. Requiring a state to PERSIST is the honest test: a condition
 * that cannot survive three polls was not worth waking someone for.
 *
 * ── WHY RED IS EXEMPT ──────────────────────────────────────────────────────
 *
 * `red` means the money path. Delaying that by three heartbeats to spare the
 * channel some noise is trading the only alert that matters against the ones
 * that do not. Red says it the moment it sees it; degraded has to prove it
 * meant it.
 */
export function holdRequired(status: ProbeStatus, minDegradedTicks: number, from?: ProbeStatus): number {
  // Anything arriving at red is immediate — see above.
  if (status === "red") return 1;
  // LEAVING RED IS ALSO IMMEDIATE. red→degraded is a material de-escalation:
  // the situation changed and is not over, and an operator watching a money
  // alarm needs that now, not in three heartbeats. The first version of this
  // held it, and the pre-existing suite caught it — which I had not run,
  // because I searched services/slack-operator/test/ and the file lives in the
  // repo-root test/unit/. Asserting "this module has no tests" from one
  // directory was the actual mistake; the regression was its consequence.
  if (from === "red") return 1;
  return Math.max(1, minDegradedTicks);
}

const DEFAULT_MIN_DEGRADED_TICKS = 3;

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

/**
 * Human line for the channel: the probe's human name, a plain-words verb for
 * what changed, then the probe's own detail verbatim. The machine enum used to
 * lead ("⚠ money_path: …") for grep-ability; operator feedback 2026-08-05 —
 * these land on a phone now — outranked grep, and the reason-class `key`
 * still carries the enum for anything programmatic.
 */
function alertText(probe: ProbeResult, kind: "opened" | "recovered", before?: ProbeStatus): string {
  const label = probeLabel(probe.name);
  if (kind === "recovered") return `✓ ${label} recovered — ${probe.detail}`;
  if (probe.status === "red") return `✗ ${label} is red — ${probe.detail}`;
  if (before === "red") return `⚠ ${label} eased to degraded — ${probe.detail}`;
  return `⚠ ${label} degraded — ${probe.detail}`;
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
  const streaks = new Map<string, number>();
  const minDegradedTicks = input.minDegradedTicks ?? DEFAULT_MIN_DEGRADED_TICKS;
  const priorStreaks = input.streaks ?? new Map<string, number>();

  // `posted` NOW MEANS ANNOUNCED, WHICH IS WHAT IT WAS ALWAYS CALLED.
  //
  // It used to mean "this class was present last tick" — the old code added to
  // it whether or not it actually posted, because with no streak map that set
  // was the only persistence bookkeeping available. The hold collides with that
  // reading head-on: a class gets marked on its first tick, and by the time it
  // earns the right to speak the dedupe guard has already silenced it forever.
  // Caught by the tests below, not by reading.
  //
  // `streaks` does the persistence bookkeeping now, so the set is free to carry
  // the meaning its name implies, and both the dedupe guard and the recovery
  // gate can rely on it.
  const heldFor = (key: string): number => priorStreaks.get(key) ?? 0;

  for (const probe of input.current) {
    next.set(probe.name, probe);
    const before = input.previous.get(probe.name);

    // First sight — say nothing, but REMEMBER what it was.
    //
    // Silence here is right: a probe already broken when the process started is
    // not news, and alerting would page on every redeploy. But the key has to be
    // retained anyway. Without it the posted set comes back empty, and on the
    // NEXT tick the same unchanged alarm looks brand new and posts.
    //
    // Production found this, not the tests: three deploys in one night produced
    // three duplicate money_path alerts, each one tick after a restart.
    if (!before) {
      if (isAlarm(probe.status)) {
        // Marked ANNOUNCED on first sight, deliberately. An alarm that was
        // already burning when this process started is not news, and without
        // this it would simply re-earn its hold and page three ticks after every
        // redeploy — which is the "three deploys, three duplicate money_path
        // alerts" bug production found, rediscovered by a different route.
        const key = reasonClass(probe);
        keys.add(key);
        streaks.set(key, heldFor(key) + 1);
      }
      continue;
    }
    if (before.status === probe.status && !isAlarm(probe.status)) continue;

    const recovered = !isAlarm(probe.status) && isAlarm(before.status);

    if (isAlarm(probe.status)) {
      const key = reasonClass(probe);

      // THE HOLD. A class that keeps flipping never accumulates a streak, so it
      // never speaks — which is the whole point. A class that persists reaches
      // the threshold and says it once. Red's threshold is 1, so this is a
      // no-op for anything on the money path.
      const held = heldFor(key) + 1;
      streaks.set(key, held);

      // An already-announced class stays announced for as long as it persists,
      // so it is never said twice.
      if (input.posted.has(key)) {
        keys.add(key);
        continue;
      }
      if (held < holdRequired(probe.status, minDegradedTicks, before.status)) continue;

      // Muted burns the announcement without making it. The alternative —
      // announcing on unmute — would replay an edge that happened hours ago,
      // which is the behaviour index.ts documents as deliberately avoided. The
      // operator unmutes to a board that already shows the state; the channel
      // does not owe them the history.
      keys.add(key);
      if (input.muted) continue;

      alerts.push({ probe: probe.name, kind: "opened", from: before.status, to: probe.status, text: alertText(probe, "opened", before.status), key });
      continue;
    }

    if (recovered) {
      const key = `${probe.name}:recovered:${reasonClass(before)}`;
      // ONLY ANNOUNCE THE END OF SOMETHING THAT WAS ANNOUNCED.
      //
      // Half of 2026-08-04's noise was `✓ capabilities recovered` for a warning
      // that had never been worth mentioning in the first place. Under the hold
      // above that gets worse, not better: a flapping class now never posts an
      // "opened", so an unconditional recovery would be the ONLY thing in the
      // channel — all-clears for alarms nobody was ever given. Silence about a
      // problem you were never told about is correct.
      // ONLY ANNOUNCE THE END OF SOMETHING THAT WAS ANNOUNCED — but "was it
      // announced" has to be decided from EVIDENCE OF SUPPRESSION, not from
      // membership of `posted`. A caller that hands us a prior alarm without its
      // key (every standalone call in the suite, and any state rebuilt from a
      // partial source) is not telling us the alarm was silent; it is telling us
      // nothing. Defaulting to silence there swallowed every recovery in the
      // pre-existing tests.
      //
      // A class we actively held below its threshold IS evidence: we know we
      // suppressed it, so its all-clear would be about a problem nobody heard.
      const beforeClass = reasonClass(before);
      const heldBack = (input.streaks?.get(beforeClass) ?? Number.MAX_SAFE_INTEGER)
        < holdRequired(before.status, minDegradedTicks);
      if (!heldBack && !input.posted.has(key) && !input.muted) {
        alerts.push({ probe: probe.name, kind: "recovered", from: before.status, to: probe.status, text: alertText(probe, "recovered"), key });
      }
      // Recovery keys are NOT retained: the next time this probe breaks and
      // heals, that is genuinely new and must be sayable again.
    }
  }

  return { alerts, keys, next, streaks };
}
