// Hermes Handoff Monitor — live board data hook (M5').
//
// Wires the monitor UI to the slack-operator v2 endpoints:
//   - GET  /monitor/v2/board   → initial snapshot (SWR query cache)
//   - GET  /monitor/v2/stream  → SSE push (LiveStream client)
//
// SWR holds the board as the single source of truth. SSE events patch
// the SWR cache in place via applyEventToBoard() (no refetch); the
// Refresh button revalidates the HTTP query. Full snapshots are
// persisted to localStorage for the future time-travel UI (§21.4).
//
// Everything is dependency-injected (fetcher, EventSource, storage,
// clock) so the hook is testable without a DOM, a network, or a server.

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { applyEventToBoard, type MonitorBoard, type MonitorEvent } from "../lib/monitor/board-cache.js";
import { LiveStream, type StreamStatus } from "../lib/monitor/live-stream.js";
import { writeSnapshot, type StorageLike } from "../lib/monitor/snapshot-store.js";

const DEFAULT_BOARD_URL = "/monitor/v2/board";
const DEFAULT_STREAM_URL = "/monitor/v2/stream";

export interface UseMonitorBoardOptions {
  boardUrl?: string;
  streamUrl?: string;
  /** Auth token appended to the SSE URL (EventSource can't send headers). */
  token?: string;
  /** Initial-snapshot fetcher. Defaults to fetch + JSON. */
  fetcher?: (url: string) => Promise<MonitorBoard>;
  /** Injected EventSource constructor (tests / non-browser). */
  EventSourceCtor?: typeof EventSource;
  /** Snapshot storage override (defaults to localStorage). */
  storage?: StorageLike;
  /** Clock override for snapshot TTL eviction. */
  now?: () => number;
  /** When false, the SSE client is not started (default true). */
  live?: boolean;
}

export interface MonitorBoardState {
  board: MonitorBoard | undefined;
  /** SSE connection status — drives the LIVE indicator + degraded mode. */
  status: StreamStatus;
  /** ISO `at` of the most recently applied board, if any. */
  lastUpdated: string | undefined;
  error: unknown;
  isLoading: boolean;
  /** Re-fetch the board snapshot over HTTP (the Refresh button). */
  refresh: () => void;
}

async function defaultFetcher(url: string): Promise<MonitorBoard> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`monitor board fetch failed: ${res.status}`);
  return (await res.json()) as MonitorBoard;
}

export function useMonitorBoard(opts: UseMonitorBoardOptions = {}): MonitorBoardState {
  const boardUrl = opts.boardUrl ?? DEFAULT_BOARD_URL;
  const fetcher = opts.fetcher ?? defaultFetcher;

  const { data, error, isLoading, mutate } = useSWR<MonitorBoard>(boardUrl, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const [status, setStatus] = useState<StreamStatus>("idle");

  // Latest-value refs so the SSE effect can stay mounted across renders
  // without tearing down the connection when these identities change.
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const storageRef = useRef(opts.storage);
  storageRef.current = opts.storage;
  const nowRef = useRef(opts.now);
  nowRef.current = opts.now;

  useEffect(() => {
    if (opts.live === false) return;

    const stream = new LiveStream({
      url: opts.streamUrl ?? DEFAULT_STREAM_URL,
      token: opts.token,
      EventSourceCtor: opts.EventSourceCtor,
    });

    const offStatus = stream.onStatus(setStatus);
    const off = stream.on((event: MonitorEvent) => {
      // Patch the SWR cache in place — full-state replace on snapshot,
      // targeted edits on per-card events. No HTTP round-trip.
      void mutateRef.current((prev) => applyEventToBoard(prev, event), { revalidate: false });

      if (event.type === "board.snapshot") {
        persistSnapshot(event, storageRef.current, nowRef.current);
      }
    });

    stream.start();
    return () => {
      off();
      offStatus();
      stream.stop();
    };
  }, [opts.live, opts.streamUrl, opts.token, opts.EventSourceCtor]);

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return { board: data, status, lastUpdated: data?.at, error, isLoading, refresh };
}

/** Best-effort persist of a full board snapshot to localStorage. */
function persistSnapshot(event: MonitorEvent, storage: StorageLike | undefined, now: (() => number) | undefined): void {
  // event.cards / event.at are `unknown` via MonitorEvent's index signature.
  const cards = Array.isArray(event.cards) ? event.cards : [];
  const at = typeof event.at === "string" ? event.at : new Date().toISOString();
  try {
    writeSnapshot({ at, cards }, { storage, now });
  } catch {
    /* snapshot persistence is best-effort; never block the UI on it */
  }
}
