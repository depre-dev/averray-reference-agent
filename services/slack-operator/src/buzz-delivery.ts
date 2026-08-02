// Is the #Ops channel actually receiving anything?
//
// WHY THIS EXISTS: narration and per-probe alerts both log WARN when a publish
// fails, and logs are not a surface anybody watches. So a Buzz channel that is
// silently broken looks EXACTLY like one that is quiet because nothing is
// wrong. That is the failure this entire monitor exists to prevent, aimed at
// the monitor's own alerting.
//
// It reports on the INSTRUMENT, not the product. A relay we cannot reach does
// not mean the money path is broken, so this never moves the operator verdict —
// it sits in the trust panel beside DATA AGE and MONITOR, which answer the same
// kind of question: should I believe what this screen is telling me, and will I
// be told if it changes?
//
// ── ARMED IS NOT OK ────────────────────────────────────────────────────────
// The state that matters most is "configured, credentials loaded, and nothing
// has ever been sent". That is not a success. Until a message has actually
// crossed the wire, the only honest thing to say is that the path is untested —
// exactly the position this integration was in for most of its life, when every
// piece had passed against a scripted fake relay and none against the real one.

export type BuzzDeliveryStatus = "off" | "armed" | "ok" | "failing";

export interface BuzzDelivery {
  status: BuzzDeliveryStatus;
  /** Operator-facing sentence. Never contains the agent secret. */
  detail: string;
  lastOkAt?: number;
  lastFailureAt?: number;
}

export interface BuzzDeliveryState {
  lastOkAt?: number;
  lastFailureAt?: number;
  /** Machine reason of the most recent failure, e.g. "auth-rejected". */
  lastFailureReason?: string;
  lastFailureDetail?: string;
}

/**
 * After this long with no fresh attempt, a past failure stops being a claim
 * about NOW.
 *
 * Deliveries are edge-triggered — narration speaks when the verdict crosses,
 * probe alerts when a probe does — so hours can pass between attempts, and the
 * row would otherwise keep asserting FAILING long after the relay recovered.
 * That is a fake red, and this codebase treats one as costing exactly what a
 * fake green costs: the operator learns to scroll past the row, and the next
 * real failure is invisible.
 *
 * Six hours is deliberately generous. The one real outage so far ran four hours
 * and reading FAILING throughout was correct and useful.
 */
export const FAILURE_GOES_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Failures the inbound listener can DISPROVE.
 *
 * The listener holds a persistent socket to the same relay, authenticated with
 * the same key and the same NIP-OA tag. So while it reports `listening`, the
 * relay is reachable and those credentials are accepted — which contradicts a
 * stored connect/auth/timeout failure directly.
 *
 * `publish-rejected` is NOT in this set, and that is the important part: the
 * relay accepted our auth and refused the message itself. A healthy listener
 * says nothing about that, so it must not clear it.
 */
const LISTENER_DISPROVABLE = new Set(["connect-failed", "auth-rejected", "timeout"]);

function ago(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Describe the delivery path.
 *
 * `configured` and `problem` come from readBuzzConfig, which already separates
 * "not set up" from "set up wrong" — a distinction this preserves, because one
 * is a choice and the other is a mistake.
 */
export function describeBuzzDelivery(input: {
  configured: boolean;
  /** Non-null when the configuration is present but broken. */
  problem?: string | null;
  state: BuzzDeliveryState;
  nowMs: number;
  /**
   * Is the relay reachable RIGHT NOW, per the inbound listener's live socket?
   *
   * `undefined` means nobody is listening and there is no live evidence either
   * way — which is different from `false` (we looked, it is not reachable) and
   * must not be collapsed into it.
   */
  relayReachableNow?: boolean;
}): BuzzDelivery {
  const { state, nowMs } = input;

  // Half-configured. Somebody meant to turn this on and left it broken, which
  // must not read the same as deliberately leaving it off.
  if (!input.configured && input.problem) {
    return { status: "failing", detail: `misconfigured — ${input.problem}` };
  }

  // Deliberately off. Quiet, and NOT an alarm: Buzz is an optional surface, and
  // a permanently-lit row for a feature nobody enabled is how a panel teaches
  // its reader to ignore it.
  if (!input.configured) {
    return { status: "off", detail: "not configured" };
  }

  const failedAt = state.lastFailureAt;
  const okAt = state.lastOkAt;

  // Most recent attempt failed. Say what kind of failure — an auth rejection
  // and an unreachable relay need different responses, and "delivery failed"
  // sends the operator looking in the wrong place.
  if (failedAt !== undefined && (okAt === undefined || failedAt >= okAt)) {
    const reason = state.lastFailureReason ? `${state.lastFailureReason}` : "unknown reason";
    const since = okAt === undefined ? "never delivered" : `last delivered ${ago(okAt, nowMs)}`;
    const carry = {
      lastFailureAt: failedAt,
      ...(okAt !== undefined ? { lastOkAt: okAt } : {}),
    };

    // The listener disproves it. Its socket is open to the same relay on the
    // same credentials, so a stored connect/auth/timeout failure is a fact
    // about the past, not a claim about now.
    //
    // `armed` rather than `ok` is the honest landing: nothing has actually been
    // published since the failure, so the delivery path itself is untested —
    // which is exactly what armed has always meant here. It renders grey and
    // reads "#ops untested", not green.
    if (input.relayReachableNow === true && LISTENER_DISPROVABLE.has(reason)) {
      return {
        status: "armed",
        detail: `last attempt failed ${ago(failedAt, nowMs)} (${reason}) — relay reachable now · nothing delivered since`,
        ...carry,
      };
    }

    // Nobody has tried in a long time. We do not know that it is failing; we
    // know it failed once and was never retried. Say the unknown out loud
    // instead of asserting a red we cannot currently support.
    if (input.relayReachableNow === undefined && nowMs - failedAt > FAILURE_GOES_STALE_AFTER_MS) {
      return {
        status: "armed",
        detail: `last attempt failed ${ago(failedAt, nowMs)} (${reason}) · untested since — delivery is UNKNOWN`,
        ...carry,
      };
    }

    return {
      status: "failing",
      detail: `FAILING ${ago(failedAt, nowMs)} — ${reason} · ${since}`,
      ...carry,
    };
  }

  if (okAt !== undefined) {
    return { status: "ok", detail: `delivered ${ago(okAt, nowMs)}`, lastOkAt: okAt };
  }

  // Configured, credentials loaded, nothing ever sent. NOT ok — see the header.
  // A listening socket proves the relay accepts these credentials, which is
  // worth saying, but it is still not a delivery.
  if (input.relayReachableNow === true) {
    return { status: "armed", detail: "armed · relay reachable, nothing delivered yet" };
  }
  return { status: "armed", detail: "armed · nothing delivered yet" };
}

/** Fold one publish outcome into the running state. Pure. */
export function recordBuzzDelivery(
  state: BuzzDeliveryState,
  outcome: { ok: boolean; reason?: string; detail?: string; atMs: number },
): BuzzDeliveryState {
  if (outcome.ok) return { ...state, lastOkAt: outcome.atMs };
  return {
    ...state,
    lastFailureAt: outcome.atMs,
    ...(outcome.reason ? { lastFailureReason: outcome.reason } : {}),
    ...(outcome.detail ? { lastFailureDetail: outcome.detail } : {}),
  };
}
