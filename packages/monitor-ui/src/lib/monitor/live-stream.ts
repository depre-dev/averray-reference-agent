// Hermes Handoff Monitor — SSE client + reconnect strategy.
//
// Browser-side EventSource wrapper that opens /monitor/v2/stream,
// emits MonitorEvent objects, and reconnects with exponential backoff.
// On reconnect the server replays board.snapshot, so the client
// catches up automatically.
//
// Pure-logic helpers (backoffDelayMs, nextStatus) are exported so the
// unit tests lock the contract without a DOM. The LiveStream class is
// exercised by the M5' frontend smoke test.

import type { MonitorEvent } from "./board-cache.js";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * Exponential-backoff schedule. attempt 0 → 0 (immediate first
 * connect); 1 → 1000; 2 → 2000; … capped at 30s.
 */
export function backoffDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  const ms = 500 * Math.pow(2, attempt);
  return Math.min(ms, 30_000);
}

export const RECONNECT_CAP_MS = 30_000;

/** State machine driving the LIVE indicator. */
export function nextStatus(
  event: "connect" | "open" | "error" | "close",
  current: StreamStatus
): StreamStatus {
  if (event === "connect") return current === "open" ? "open" : "connecting";
  if (event === "open") return "open";
  if (event === "error") return "reconnecting";
  if (event === "close") return "closed";
  return current;
}

interface StreamLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface LiveStreamOptions {
  /** SSE endpoint. Default "/monitor/v2/stream". */
  url?: string;
  /** Auth token appended as ?token= (EventSource can't send headers). */
  token?: string;
  logger?: StreamLogger;
  /** Dependency-inject for tests / non-browser environments. */
  EventSourceCtor?: typeof EventSource;
}

const NAMED_EVENTS = [
  "board.snapshot",
  "board.card.added",
  "board.card.updated",
  "board.card.moved",
  "board.card.archived",
  "stream.keepalive",
] as const;

/**
 * Connect to the monitor SSE stream and dispatch events to handlers.
 * Browser-side only; pure helpers above carry the unit-tested logic.
 */
export class LiveStream {
  private url: string;
  private token?: string;
  private logger: StreamLogger;
  private EventSourceCtor?: typeof EventSource;
  private status: StreamStatus = "idle";
  private attempt = 0;
  private handlers = new Set<(event: MonitorEvent) => void>();
  private statusHandlers = new Set<(status: StreamStatus) => void>();
  private source: EventSource | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(opts: LiveStreamOptions = {}) {
    this.url = opts.url ?? "/monitor/v2/stream";
    this.token = opts.token;
    this.logger = opts.logger ?? {};
    this.EventSourceCtor =
      opts.EventSourceCtor ??
      (typeof globalThis !== "undefined" ? (globalThis as { EventSource?: typeof EventSource }).EventSource : undefined);
  }

  start(): void {
    this.stopped = false;
    this.openConnection();
  }

  stop(): void {
    this.stopped = true;
    this.setStatus("closed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* already closed */
      }
      this.source = undefined;
    }
  }

  on(handler: (event: MonitorEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(handler: (status: StreamStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status); // fire immediately so the UI starts in sync
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private openConnection(): void {
    if (!this.EventSourceCtor) {
      this.logger.warn?.("LiveStream: no EventSource available; no-op mode");
      this.setStatus("closed");
      return;
    }
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* ignore */
      }
    }
    this.setStatus("connecting");
    const url = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url;
    const src = new this.EventSourceCtor(url);
    this.source = src;

    src.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };

    src.onerror = () => {
      try {
        src.close();
      } catch {
        /* ignore */
      }
      this.source = undefined;
      if (this.stopped) return;
      this.setStatus("reconnecting");
      const delay = backoffDelayMs(++this.attempt);
      this.logger.warn?.(`LiveStream: reconnect in ${delay}ms (attempt ${this.attempt})`);
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.openConnection();
      }, delay);
    };

    src.onmessage = (e: MessageEvent) => this.dispatchRaw(e);
    for (const name of NAMED_EVENTS) {
      src.addEventListener(name, (e) => this.dispatchRaw(e as MessageEvent));
    }
  }

  private dispatchRaw(e: MessageEvent): void {
    if (!e || typeof e.data !== "string") return;
    let parsed: MonitorEvent;
    try {
      parsed = JSON.parse(e.data) as MonitorEvent;
    } catch (err) {
      this.logger.warn?.("LiveStream: failed to parse SSE event payload", err);
      return;
    }
    // The server tags updates with the SSE event name (`event: board.snapshot`)
    // but the JSON payload itself may omit a `type` discriminator — the v2
    // BoardSnapshot body carries board state fields, not its own event type.
    // Recover the type from the event name so board-cache's applyEventToBoard()
    // can dispatch on it. A `type` already in the payload always wins; the
    // default "message" event (unnamed data) is not a meaningful board type,
    // so we ignore it.
    if (typeof parsed.type !== "string" && typeof e.type === "string" && e.type !== "message") {
      parsed = { ...parsed, type: e.type };
    }
    for (const h of this.handlers) {
      try {
        h(parsed);
      } catch (err) {
        this.logger.warn?.("LiveStream: subscriber threw", err);
      }
    }
  }

  private setStatus(status: StreamStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const h of this.statusHandlers) {
      try {
        h(status);
      } catch (err) {
        this.logger.warn?.("LiveStream: status subscriber threw", err);
      }
    }
  }
}
