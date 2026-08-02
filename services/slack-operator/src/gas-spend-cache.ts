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

/**
 * A read that has never succeeded, with the reason it has not.
 *
 * Before this existed, a first read that failed produced no snapshot, no log
 * and no payload field — the board simply said nothing, forever, and the only
 * way to discover it was to ask why a number was missing. That is the failure
 * mode this whole board exists to prevent, and I built it into the board.
 */
export interface GasUnreadable {
  unreadable: true;
  reason: string;
  /** When the failing attempt happened. */
  at: number;
}

export function isGasUnreadable(v: GasSpendSnapshot | GasUnreadable | null): v is GasUnreadable {
  return v !== null && (v as GasUnreadable).unreadable === true;
}

export interface GasSpendCache {
  /**
   * The current snapshot, or — when no read has ever succeeded — the reason
   * why. Null only before the first attempt has finished.
   */
  read(nowMs: number): GasSpendSnapshot | GasUnreadable | null;
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
  // Kept separately: a failure BEFORE any success has no snapshot to attach to,
  // and dropping it is what made the whole feature silent in production.
  let firstError: { reason: string; at: number } | null = null;
  // One refresh at a time. Without this a slow read plus a fast heartbeat
  // stacks passes, and each is 174 RPC calls against an endpoint that
  // rate-limits by answering 404.
  let running = false;

  return {
    read(nowMs) {
      if (snapshot) return { ...snapshot, ageMs: Math.max(0, nowMs - snapshot.at) };
      // Never succeeded. Say why rather than nothing — "the board shows no gas
      // line" and "gas could not be read" are different facts and only one of
      // them is actionable.
      if (firstError) return { unreadable: true, reason: firstError.reason, at: firstError.at };
      return null;
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
            else firstError = { reason: result.reason, at: nowMs };
            deps.onError?.(result.reason);
            return;
          }
          const summary = summarizeGasSpend(result.txs, {
            ...(deps.labels ? { labels: deps.labels } : {}),
            settledCount: deps.settledCount(),
          });
          firstError = null;
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
          else firstError = { reason: message, at: nowMs };
          deps.onError?.(message);
        } finally {
          running = false;
        }
      })();
    },
  };
}
