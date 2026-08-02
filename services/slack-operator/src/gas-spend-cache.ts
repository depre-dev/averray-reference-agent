// Gas attribution on its own cadence, so the heartbeat never waits for it.
//
// A pass is ~174 RPC calls (a receipt AND a transaction for each of ~87 txs).
// The heartbeat runs every few minutes and has a money path to watch; making it
// block on that would be trading the thing that matters for the thing that is
// merely interesting.
//
// So: the heartbeat always gets an ANSWER IMMEDIATELY — the last computed
// snapshot, with its age — and a refresh runs in the background when the value
// has aged past the interval.
//
// ── STALE IS LABELLED, NEVER LAUNDERED ─────────────────────────────────────
//
// `ageMs` is on every snapshot and the caller renders it. A forty-minute-old
// gas breakdown is useful; a forty-minute-old gas breakdown presented as
// current is the same lie as any other stale number, and this board has already
// been caught out once by reading a snapshot as live state.
//
// ── NOTHING ELSE WAITS ON IT ───────────────────────────────────────────────
//
// Before the first refresh completes there is no snapshot, and `null` is the
// honest answer — not an empty breakdown, which would render as "0 DOT spent"
// and read as free rather than as not-yet-known. A refresh that fails leaves
// the previous snapshot in place with its age still climbing, so a broken
// reader degrades into visibly-old data rather than into a fabricated zero.

import { summarizeGasSpend, type GasSpend } from "./gas-spend.js";
import type { GasReadResult } from "./gas-spend-read.js";

export interface GasSpendSnapshot extends GasSpend {
  /** Epoch ms this was computed. */
  at: number;
  /** How old the figures are, filled in at read time. */
  ageMs: number;
  /** Blocks the read covered, for the window the numbers describe. */
  blocksScanned: number;
  /** True when the transaction cap bit — some spend is NOT counted. */
  truncated: boolean;
  /** Other signing keys seen; their gas is excluded from these totals. */
  otherSenders: Array<{ address: string; count: number }>;
  /** Present when the last refresh failed. The figures are the PREVIOUS ones. */
  staleReason?: string;
}

export interface GasSpendCache {
  /** The current snapshot with a fresh age, or null before the first success. */
  read(nowMs: number): GasSpendSnapshot | null;
  /**
   * Refresh if the snapshot has aged out. Returns immediately; the work happens
   * in the background. Safe to call every heartbeat.
   */
  maybeRefresh(nowMs: number): void;
}

/** Long enough that the RPC cost is negligible; short enough to be useful. */
export const DEFAULT_GAS_REFRESH_MS = 30 * 60 * 1000;

export function createGasSpendCache(deps: {
  /** Performs the read. Injected so the cache is testable without a chain. */
  read: () => Promise<GasReadResult>;
  /** Settlements in the same window, for the per-job unit cost. */
  settledCount: () => number | null;
  labels?: Readonly<Record<string, string>>;
  refreshMs?: number;
  onError?: (message: string) => void;
}): GasSpendCache {
  const refreshMs = deps.refreshMs ?? DEFAULT_GAS_REFRESH_MS;
  let snapshot: GasSpendSnapshot | null = null;
  // One refresh at a time. Without this a slow read plus a fast heartbeat
  // stacks passes, and each is 174 RPC calls against an endpoint that
  // rate-limits by answering 404.
  let running = false;

  return {
    read(nowMs) {
      if (!snapshot) return null;
      return { ...snapshot, ageMs: Math.max(0, nowMs - snapshot.at) };
    },

    maybeRefresh(nowMs) {
      if (running) return;
      if (snapshot && nowMs - snapshot.at < refreshMs) return;
      running = true;
      void (async () => {
        try {
          const result = await deps.read();
          if (result.reason) {
            // Keep the previous figures and say why they stopped moving. An
            // unreadable chain is not zero spend.
            if (snapshot) snapshot = { ...snapshot, staleReason: result.reason };
            deps.onError?.(result.reason);
            return;
          }
          const summary = summarizeGasSpend(result.txs, {
            ...(deps.labels ? { labels: deps.labels } : {}),
            settledCount: deps.settledCount(),
          });
          snapshot = {
            ...summary,
            at: nowMs,
            ageMs: 0,
            blocksScanned: result.blocksScanned,
            truncated: result.truncated,
            otherSenders: result.otherSenders,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (snapshot) snapshot = { ...snapshot, staleReason: message };
          deps.onError?.(message);
        } finally {
          running = false;
        }
      })();
    },
  };
}
