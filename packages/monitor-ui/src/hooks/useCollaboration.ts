// Hermes Handoff Monitor — co-pilot collaboration feed (M8').
//
// Polls slack-operator's /monitor/collaboration for the operator ↔ Hermes
// ↔ Codex turn stream, and posts operator questions back. Posting a
// question records it and schedules an async Hermes reply server-side; the
// reply shows up on the next poll, so the rail "answers" even without
// streaming. Dependency-injected (fetcher, poster) for tests.
//
// Feature #3 — live-token streaming (FLAG-GATED backend, default off): when a
// `deltaSource` is wired, the hook also subscribes to co-pilot SSE events
// (`hermes.delta` / `hermes.turn.completed`) and renders the in-progress Hermes
// reply token-by-token ahead of the next poll. DEGRADED-SAFE: if no delta
// events ever arrive (flag off, or the stream fails), the rail renders exactly
// as before off the poll. Streaming turns are reconciled away once the polled
// feed echoes the finalized reply — never a duplicate.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type {
  CollaborationMessage,
  CollaborationRelatedPr,
  CollaborationTarget,
  CopilotStreamEvent,
  CopilotStreamSource,
  HermesReplyMode,
} from "../lib/monitor/collaboration.js";

const DEFAULT_URL = "/monitor/collaboration";
const DEFAULT_REFRESH_MS = 4000;
const DEFAULT_STREAM_URL = "/monitor/v2/stream";

export interface AskInput {
  text: string;
  relatedPr?: CollaborationRelatedPr;
  addressedTo?: CollaborationTarget;
}

export interface UseCollaborationOptions {
  /** When false the hook neither fetches nor polls (rail stays inert). Default true. */
  enabled?: boolean;
  url?: string;
  fetcher?: (url: string) => Promise<CollaborationMessage[]>;
  poster?: (input: AskInput) => Promise<void>;
  refreshIntervalMs?: number;
  limit?: number;
  /**
   * Live-token stream subscription (feature #3). When provided, the hook
   * renders streamed Hermes deltas ahead of the poll. Omit to keep the rail on
   * the poll path (default). Tests inject a synchronous stub; production wires
   * the EventSource-backed default via `streamUrl` + `streamToken`.
   */
  deltaSource?: CopilotStreamSource;
  /** SSE URL for the default EventSource delta source. Default "/monitor/v2/stream". */
  streamUrl?: string;
  /** Auth token appended to the default delta-source SSE URL (EventSource can't send headers). */
  streamToken?: string;
  /**
   * When true, open the default EventSource delta source against `streamUrl`.
   * Off by default so nothing touches the network unless the app opts in
   * (mirrors the backend flag being off by default). Ignored when an explicit
   * `deltaSource` is provided.
   */
  live?: boolean;
  /** Injected EventSource constructor (tests / non-browser). */
  EventSourceCtor?: typeof EventSource;
}

/** An in-progress or just-finalized streamed Hermes turn, keyed by turnId. */
interface StreamingTurn {
  turnId: string;
  text: string;
  addressedTo: CollaborationTarget;
  ts: number;
  /** True while deltas are still arriving; false once `hermes.turn.completed` lands. */
  streaming: boolean;
  /**
   * Provenance badge. Deltas are always "live" (genuinely streamed tokens); the
   * terminal event carries the authoritative mode, so a mid-stream failure that
   * fell back to a templated reply finalizes honestly as "templated".
   */
  hermesMode: HermesReplyMode;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export interface CollaborationState {
  messages: CollaborationMessage[];
  /** Ask Hermes; optionally scoped to a PR. Records + triggers a revalidate. */
  ask: (text: string, relatedPr?: CollaborationRelatedPr, addressedTo?: CollaborationTarget) => void;
  isLoading: boolean;
  error: unknown;
  /** Whether the rail is wired to a live collaboration channel at all. */
  enabled: boolean;
  /** True from the moment a question is posted until Hermes's reply lands
   *  (or the post fails) — drives the "Hermes thinking…" indicator. */
  pending: boolean;
  /** Set when the POST itself failed; surfaced inline so the operator
   *  knows the question did not reach Hermes (no silent drop). */
  sendError: string | null;
  /** Clear a prior send error (e.g. when the operator edits the input). */
  clearSendError: () => void;
}

async function defaultFetcher(url: string): Promise<CollaborationMessage[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`collaboration fetch failed: ${res.status}`);
  const body = (await res.json()) as { messages?: CollaborationMessage[] };
  return Array.isArray(body.messages) ? body.messages : [];
}

function makeDefaultPoster(url: string): (input: AskInput) => Promise<void> {
  return async (input) => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "operator",
        kind: "chat",
        addressedTo: input.addressedTo ?? "hermes",
        text: input.text,
        ...(input.relatedPr ? { relatedPr: input.relatedPr } : {}),
      }),
    });
  };
}

/**
 * EventSource-backed default delta source: opens the board SSE and forwards the
 * named co-pilot events. Degraded-safe — if EventSource is unavailable (SSR /
 * tests without a DOM) it's a no-op that never calls the handler, so the rail
 * stays on the poll path. Only opened when the app sets `live: true`.
 */
function makeEventSourceDeltaSource(
  streamUrl: string,
  streamToken: string | undefined,
  EventSourceCtor: typeof EventSource | undefined,
): CopilotStreamSource {
  return (onEvent) => {
    const Ctor =
      EventSourceCtor ??
      (typeof globalThis !== "undefined"
        ? (globalThis as { EventSource?: typeof EventSource }).EventSource
        : undefined);
    if (!Ctor) return () => {};
    const url = streamToken ? `${streamUrl}?token=${encodeURIComponent(streamToken)}` : streamUrl;
    let source: EventSource | undefined;
    try {
      source = new Ctor(url);
    } catch {
      return () => {};
    }
    const handle = (type: CopilotStreamEvent["type"]) => (e: MessageEvent) => {
      if (!e || typeof e.data !== "string") return;
      try {
        const payload = JSON.parse(e.data);
        onEvent({ type, payload } as CopilotStreamEvent);
      } catch {
        /* ignore malformed frame — a bad event never breaks the rail */
      }
    };
    const onDelta = handle("hermes.delta");
    const onCompleted = handle("hermes.turn.completed");
    source.addEventListener("hermes.delta", onDelta as EventListener);
    source.addEventListener("hermes.turn.completed", onCompleted as EventListener);
    return () => {
      source?.removeEventListener("hermes.delta", onDelta as EventListener);
      source?.removeEventListener("hermes.turn.completed", onCompleted as EventListener);
      try {
        source?.close();
      } catch {
        /* already closed */
      }
    };
  };
}

export function useCollaboration(opts: UseCollaborationOptions = {}): CollaborationState {
  const enabled = opts.enabled ?? true;
  const url = opts.url ?? DEFAULT_URL;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const poster = opts.poster ?? makeDefaultPoster(url);
  const refreshInterval = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;

  // A null key disables SWR entirely — no fetch, no poll.
  const key = enabled ? (opts.limit ? `${url}?limit=${opts.limit}` : url) : null;

  const { data, error, isLoading, mutate } = useSWR<CollaborationMessage[]>(key, fetcher, {
    refreshInterval,
    revalidateOnFocus: false,
  });

  // Optimistic operator messages: rendered immediately so an Ask-Hermes
  // action never sits silent for a poll interval. Each is reconciled away
  // once the same text shows up in the fetched feed (server is the source
  // of truth); on POST failure it's dropped and `sendError` is set.
  const [optimistic, setOptimistic] = useState<CollaborationMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const seq = useRef(0);

  // Feature #3 — in-progress streamed Hermes turns keyed by turnId. Deltas
  // append to a turn's text; the terminal event finalizes it (streaming:false).
  // A finalized turn stays until the polled feed echoes the same text, then it's
  // reconciled away so the reply never renders twice.
  const [streamingTurns, setStreamingTurns] = useState<Map<string, StreamingTurn>>(() => new Map());

  const serverMessages = data ?? [];

  // Resolve the delta source once: an explicit injected source wins; otherwise
  // build the EventSource-backed default only when the app opts in via `live`.
  // No source ⇒ the subscription effect is a no-op and the rail stays on polls.
  const deltaSource = useMemo<CopilotStreamSource | undefined>(() => {
    if (opts.deltaSource) return opts.deltaSource;
    if (!enabled || !opts.live) return undefined;
    return makeEventSourceDeltaSource(
      opts.streamUrl ?? DEFAULT_STREAM_URL,
      opts.streamToken,
      opts.EventSourceCtor,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.deltaSource, enabled, opts.live, opts.streamUrl, opts.streamToken, opts.EventSourceCtor]);

  useEffect(() => {
    if (!deltaSource) return undefined;
    const unsubscribe = deltaSource((event) => {
      setStreamingTurns((prev) => reduceStreamingTurn(prev, event));
    });
    return () => {
      unsubscribe();
    };
  }, [deltaSource]);

  // Drop any optimistic message the server feed has now echoed back, so we
  // don't render the operator's question twice.
  const pendingOptimistic = optimistic.filter(
    (o) => !serverMessages.some((m) => m.author === "operator" && m.text === o.text),
  );
  // Render streamed Hermes turns until the server feed echoes the finalized
  // text (same reconcile-on-echo discipline as optimistic operator messages).
  const liveStreamingTurns = useMemo(
    () =>
      [...streamingTurns.values()].filter(
        (t) => t.streaming || !serverMessages.some((m) => m.author === "hermes" && m.text === t.text),
      ),
    [streamingTurns, serverMessages],
  );
  const streamingMessages = useMemo(
    () => liveStreamingTurns.map(streamingTurnToMessage),
    [liveStreamingTurns],
  );
  const messages = useMemo(
    () => [...serverMessages, ...pendingOptimistic, ...streamingMessages],
    [serverMessages, pendingOptimistic, streamingMessages],
  );

  const clearSendError = useCallback(() => setSendError(null), []);

  const ask = useCallback(
    (text: string, relatedPr?: CollaborationRelatedPr, addressedTo: CollaborationTarget = "hermes") => {
      const trimmed = text.trim();
      if (!trimmed || !enabled) return;
      seq.current += 1;
      const optimisticId = `optimistic-${seq.current}`;
      const optimisticMessage: CollaborationMessage = {
        id: optimisticId,
        ts: Date.now(), // "now" so the feed (sorted ascending by ts) renders it newest/last
        author: "operator",
        kind: "chat",
        text: trimmed,
        addressedTo,
        ...(relatedPr ? { relatedPr } : {}),
      };
      setOptimistic((prev) => [...prev, optimisticMessage]);
      setSendError(null);
      setPending(true);
      void poster({ text: trimmed, addressedTo, ...(relatedPr ? { relatedPr } : {}) })
        .then(() => mutate())
        .catch(() => {
          // Do NOT swallow: roll back the optimistic message and surface
          // the failure inline so the operator knows it didn't send.
          setOptimistic((prev) => prev.filter((m) => m.id !== optimisticId));
          setSendError("Couldn't reach Hermes — your question wasn't sent. Try again.");
        })
        .finally(() => setPending(false));
    },
    [enabled, poster, mutate],
  );

  return {
    messages,
    ask,
    isLoading,
    error,
    enabled,
    pending,
    sendError,
    clearSendError,
  };
}

/**
 * Fold one co-pilot SSE event into the streaming-turns map (pure; exported for
 * unit tests). `hermes.delta` appends the token to its turn (creating it
 * mid-flight, `streaming:true`); `hermes.turn.completed` replaces the text with
 * the authoritative final text and clears `streaming`. Malformed events (no
 * turnId, non-string delta/text) are ignored so a bad frame never corrupts the
 * feed. A completed event for an unseen turn still renders (the terminal text is
 * authoritative even if deltas were dropped). Always returns a NEW map on change
 * so React re-renders.
 */
export function reduceStreamingTurn(
  prev: Map<string, StreamingTurn>,
  event: CopilotStreamEvent,
): Map<string, StreamingTurn> {
  const turnId = event.payload?.turnId;
  if (typeof turnId !== "string" || !turnId) return prev;

  if (event.type === "hermes.delta") {
    const delta = event.payload.delta;
    if (typeof delta !== "string" || delta.length === 0) return prev;
    const next = new Map(prev);
    const existing = next.get(turnId);
    next.set(turnId, {
      turnId,
      text: (existing?.text ?? "") + delta,
      addressedTo: (event.payload.addressedTo ?? existing?.addressedTo ?? "everyone") as CollaborationTarget,
      ts: existing?.ts ?? Date.now(),
      streaming: true,
      hermesMode: "live", // a streamed token is always genuinely live
      ...(event.payload.relatedPr ?? existing?.relatedPr
        ? { relatedPr: event.payload.relatedPr ?? existing?.relatedPr }
        : {}),
      ...(event.payload.relatedCorrelationId ?? existing?.relatedCorrelationId
        ? { relatedCorrelationId: event.payload.relatedCorrelationId ?? existing?.relatedCorrelationId }
        : {}),
    });
    return next;
  }

  // hermes.turn.completed — finalize with the authoritative full text + mode.
  const text = event.payload.text;
  if (typeof text !== "string" || !text) return prev;
  const next = new Map(prev);
  const existing = next.get(turnId);
  next.set(turnId, {
    turnId,
    text,
    addressedTo: (event.payload.addressedTo ?? existing?.addressedTo ?? "everyone") as CollaborationTarget,
    ts: existing?.ts ?? Date.now(),
    streaming: false,
    // Honor the authoritative mode: a mid-stream failure that fell back to a
    // templated reply finalizes as "templated", not a stuck live badge.
    hermesMode: event.payload.hermesMode ?? existing?.hermesMode ?? "live",
    ...(event.payload.relatedPr ?? existing?.relatedPr
      ? { relatedPr: event.payload.relatedPr ?? existing?.relatedPr }
      : {}),
    ...(event.payload.relatedCorrelationId ?? existing?.relatedCorrelationId
      ? { relatedCorrelationId: event.payload.relatedCorrelationId ?? existing?.relatedCorrelationId }
      : {}),
  });
  return next;
}

/** Project a streaming turn into a renderable Hermes CollaborationMessage. */
function streamingTurnToMessage(turn: StreamingTurn): CollaborationMessage {
  return {
    id: turn.turnId,
    ts: turn.ts,
    author: "hermes",
    kind: "chat",
    text: turn.text,
    addressedTo: turn.addressedTo,
    // Carry the turn's authoritative provenance badge. While streaming this is
    // "live" (genuine tokens); a fallback finalizes it to its real mode.
    hermesMode: turn.hermesMode,
    ...(turn.streaming ? { streaming: true } : {}),
    ...(turn.relatedPr ? { relatedPr: turn.relatedPr } : {}),
    ...(turn.relatedCorrelationId ? { relatedCorrelationId: turn.relatedCorrelationId } : {}),
  };
}
