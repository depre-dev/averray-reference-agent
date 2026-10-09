// The cross-check on its own cadence, so the heartbeat never waits for it.
//
// A comparison is three RPC calls — one head read plus a getLogs against each
// provider — which is cheap, but it is also weekly-useful information: two
// endpoints that agreed an hour ago are not going to disagree by lunchtime.
// Running it every heartbeat would spend a second provider's rate limit to
// re-learn the same fact hundreds of times a day.
//
// Same contract as the gas cache, for the same reasons:
//
//   · the heartbeat always gets an ANSWER IMMEDIATELY — the last verdict
//   · a failure keeps the previous verdict and says why it stopped moving
//   · before the first run there is a "never run" verdict, NOT silence and
//     NOT a pass
//
// The last-agreement timestamp survives failures deliberately. It is what
// makes "cross-check overdue" possible: an agreement is only reassuring for as
// long as it is recent, and the clock has to keep running while the check is
// broken — otherwise a check that stopped working reads the same as one that
// keeps passing.

import {
  crossCheckNeverRun,
  decideCrossCheck,
  type CrossCheckView,
  type EndpointReading,
} from "./payout-crosscheck.js";
import { describeFeedError } from "./probe-transport.js";

export interface CrossCheckCache {
  /** The current verdict. Never null — "never run" is itself a verdict. */
  read(): CrossCheckView;
  /** Re-compare when success is due and any failure backoff has elapsed. Returns at once. */
  maybeRefresh(nowMs: number): void;
}

/** Weekly. Two providers that agree today will agree this afternoon. */
export const DEFAULT_CROSSCHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** A transient provider failure gets another chance in the same hour. */
export const DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS = 30 * 60 * 1000;

export interface CrossCheckRun {
  primary: EndpointReading | null;
  secondary: EndpointReading | null;
  secondaryReason?: string | null;
  primaryReason?: string | null;
  range?: { fromBlock: number; toBlock: number } | null;
}

export function createCrossCheckCache(deps: {
  /** False when no second endpoint is configured. */
  configured: boolean;
  /** Performs both pinned reads. Injected so this is testable without a chain. */
  run: () => Promise<CrossCheckRun>;
  intervalMs?: number;
  retryIntervalMs?: number;
  onError?: (message: string) => void;
}): CrossCheckCache {
  const intervalMs = deps.intervalMs ?? DEFAULT_CROSSCHECK_INTERVAL_MS;
  const retryIntervalMs = deps.retryIntervalMs ?? DEFAULT_CROSSCHECK_RETRY_INTERVAL_MS;
  let verdict: CrossCheckView = crossCheckNeverRun(deps.configured);
  // Survives failures on purpose — see the header.
  let lastAgreedAtMs: number | null = null;
  // A completed comparison (agree OR disagree) owns the long cadence. A failed
  // attempt owns only the retry cadence; conflating these clocks stranded a
  // transient 429 behind the seven-day interval.
  let lastSuccessAtMs: number | null = null;
  let lastAttemptAtMs: number | null = null;
  let consecutiveFailures = 0;
  let running = false;

  const retryDelayMs = (): number => {
    const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 52);
    return Math.min(intervalMs, retryIntervalMs * 2 ** exponent);
  };

  const decorateFailure = (
    next: CrossCheckView,
    reason: string | null | undefined,
    nowMs: number,
  ): CrossCheckView => {
    const throttled = /(?:\b429\b|throttl)/i.test(reason ?? "");
    return {
      ...next,
      ...(throttled ? { reason: "throttled" as const } : {}),
      retryAtMs: nowMs + retryDelayMs(),
    };
  };

  return {
    read: () => verdict,

    maybeRefresh(nowMs) {
      if (!deps.configured) return;
      if (running) return;
      const successDue = lastSuccessAtMs === null || nowMs - lastSuccessAtMs >= intervalMs;
      if (!successDue) return;
      if (
        consecutiveFailures > 0
        && lastAttemptAtMs !== null
        && nowMs - lastAttemptAtMs < retryDelayMs()
      ) return;
      running = true;
      lastAttemptAtMs = nowMs;
      void (async () => {
        try {
          const run = await deps.run();
          const next = decideCrossCheck({
            configured: true,
            primary: run.primary,
            secondary: run.secondary,
            ...(run.secondaryReason ? { secondaryReason: run.secondaryReason } : {}),
            ...(run.primaryReason ? { primaryReason: run.primaryReason } : {}),
            ...(run.range ? { range: run.range } : {}),
            lastAgreedAtMs,
            nowMs,
          });
          if (next.status === "agree" || next.status === "disagree") {
            verdict = next;
            lastSuccessAtMs = nowMs;
            consecutiveFailures = 0;
            if (next.status === "agree") lastAgreedAtMs = nowMs;
          } else {
            consecutiveFailures += 1;
            verdict = decorateFailure(next, run.secondaryReason, nowMs);
          }
        } catch (error) {
          const message = describeFeedError(error);
          consecutiveFailures += 1;
          verdict = decorateFailure(decideCrossCheck({
            configured: true,
            primary: null,
            secondary: null,
            secondaryReason: message,
            lastAgreedAtMs,
            nowMs,
          }), message, nowMs);
          deps.onError?.(message);
        } finally {
          running = false;
        }
      })();
    },
  };
}
