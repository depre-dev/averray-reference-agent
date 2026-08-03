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

export interface CrossCheckCache {
  /** The current verdict. Never null — "never run" is itself a verdict. */
  read(): CrossCheckView;
  /** Re-compare if the verdict has aged past the interval. Returns at once. */
  maybeRefresh(nowMs: number): void;
}

/** Weekly. Two providers that agree today will agree this afternoon. */
export const DEFAULT_CROSSCHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CrossCheckRun {
  primary: EndpointReading | null;
  secondary: EndpointReading | null;
  secondaryReason?: string | null;
  range?: { fromBlock: number; toBlock: number } | null;
}

export function createCrossCheckCache(deps: {
  /** False when no second endpoint is configured. */
  configured: boolean;
  /** Performs both pinned reads. Injected so this is testable without a chain. */
  run: () => Promise<CrossCheckRun>;
  intervalMs?: number;
  onError?: (message: string) => void;
}): CrossCheckCache {
  const intervalMs = deps.intervalMs ?? DEFAULT_CROSSCHECK_INTERVAL_MS;
  let verdict: CrossCheckView = crossCheckNeverRun(deps.configured);
  // Survives failures on purpose — see the header.
  let lastAgreedAtMs: number | null = null;
  let lastRunAtMs: number | null = null;
  let running = false;

  return {
    read: () => verdict,

    maybeRefresh(nowMs) {
      if (!deps.configured) return;
      if (running) return;
      if (lastRunAtMs !== null && nowMs - lastRunAtMs < intervalMs) return;
      running = true;
      void (async () => {
        try {
          const run = await deps.run();
          verdict = decideCrossCheck({
            configured: true,
            primary: run.primary,
            secondary: run.secondary,
            ...(run.secondaryReason ? { secondaryReason: run.secondaryReason } : {}),
            ...(run.range ? { range: run.range } : {}),
            lastAgreedAtMs,
            nowMs,
          });
          if (verdict.status === "agree") lastAgreedAtMs = nowMs;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          verdict = decideCrossCheck({
            configured: true,
            primary: null,
            secondary: null,
            secondaryReason: message,
            lastAgreedAtMs,
            nowMs,
          });
          deps.onError?.(message);
        } finally {
          // Set even on failure: a provider that is down must not be retried
          // every heartbeat until it comes back.
          lastRunAtMs = nowMs;
          running = false;
        }
      })();
    },
  };
}
