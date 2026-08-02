// The Buzz subscribe transport: hold one WebSocket open, stay authenticated,
// and hand every channel message to a callback.
//
// ── THIS CONTRADICTS buzz-client.ts ON PURPOSE ──────────────────────────────
//
// That module opens a connection per message and says why:
//
//   "A persistent socket for that traffic buys nothing and costs the thing we
//    can least afford: reconnect logic, backoff state, and a socket that can be
//    silently half-dead for hours inside the process whose entire job is
//    noticing when something has gone quiet."
//
// That reasoning is right, and it still is — for publishing. Narration is
// edge-triggered and rare, so a connection per message is free and self-
// verifying. Listening has no such option: you cannot poll for a message that
// has not been sent. The socket has to stay open, which means the cost that
// paragraph names is now real and has to be PAID rather than avoided.
//
// It is paid in three places:
//
//  · A WATCHDOG. Relays go quiet legitimately, so silence alone proves nothing.
//    But a socket that has heard nothing at all — not a message, not a ping,
//    not a NOTICE — for longer than the idle limit is treated as dead and
//    reconnected, because the failure being guarded against is precisely the
//    one that looks identical to a quiet channel.
//  · OBSERVABLE STATE. Every transition is reported to `onState`, so a listener
//    that is down appears on the board as down. This is the actual answer to
//    the objection: the danger was never the half-dead socket, it was the
//    half-dead socket NOBODY COULD SEE. The relay already taught us this the
//    hard way — it hung mid-startup and #Ops was silently dead for four hours.
//  · BACKOFF WITH A CEILING. A relay that is down stays down for a while;
//    reconnecting in a tight loop turns one outage into two.
//
// Nothing here throws into the caller. A transport whose job is to report
// problems must not become one.

import {
  BuzzEventError,
  KIND_STREAM_MESSAGE,
  agentPubkey,
  buildAuthEvent,
  signEvent,
} from "./buzz-event.js";
import type { BuzzConfig } from "./buzz-client.js";
import type { InboundEvent } from "./buzz-inbound.js";

export type ListenerPhase =
  | "connecting"
  | "authenticating"
  | "listening"
  | "retrying"
  | "closed"
  | "misconfigured";

export interface ListenerState {
  phase: ListenerPhase;
  /** Operator-facing sentence. Safe to log; never contains the secret key. */
  detail: string;
  /** Consecutive failed connection attempts. Zero once listening. */
  failures: number;
}

export interface SubscribeHandlers {
  onMessage: (event: InboundEvent) => void;
  onState?: (state: ListenerState) => void;
}

interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", handler: (event: any) => void): void;
}

export interface SubscribeOptions {
  openSocket?: (url: string) => Socket;
  /** Injected for tests. Defaults to wall clock. */
  nowMs?: () => number;
  /** Injected for tests so backoff does not actually sleep. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** No frame of any kind for this long means the socket is presumed dead. */
  idleTimeoutMs?: number;
  firstRetryMs?: number;
  maxRetryMs?: number;
  /** Only events at or after this second are requested from the relay. */
  sinceSeconds?: number;
}

/**
 * Long enough that a genuinely quiet channel does not churn the connection,
 * short enough that a dead socket is noticed within one coffee break. Relays
 * that implement ping/pong will refresh this far more often.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FIRST_RETRY_MS = 2_000;
export const DEFAULT_MAX_RETRY_MS = 60_000;

const SUBSCRIPTION_ID = "avg-ops";

export interface BuzzSubscription {
  /** Stop listening. Idempotent. */
  close(): void;
  /** Current state, for the board and for tests. */
  state(): ListenerState;
}

/**
 * Compute the next backoff delay: exponential, capped, with jitter.
 *
 * Jitter matters even with a single client, because the common failure is the
 * relay restarting — and a fixed delay means every reconnect attempt lands on
 * the same instant of its startup, which is when it is least able to serve one.
 */
export function nextRetryDelayMs(failures: number, firstMs: number, maxMs: number): number {
  const base = Math.min(maxMs, firstMs * 2 ** Math.max(0, failures - 1));
  const jitter = base * 0.2 * Math.random();
  return Math.round(base - base * 0.1 + jitter);
}

/**
 * Build the REQ filter.
 *
 * `since` is not an optimisation. Without it the relay replays channel history
 * on every connect, and each reconnect would hand the listener the same old
 * messages again — the decision layer rejects them as replays, but asking for
 * them at all makes an outage expensive and the logs unreadable.
 */
export function buildReqFrame(channelId: string, sinceSeconds: number): string {
  return JSON.stringify([
    "REQ",
    SUBSCRIPTION_ID,
    { kinds: [KIND_STREAM_MESSAGE], "#h": [channelId], since: sinceSeconds },
  ]);
}

/** Parse a relay frame into an inbound event, or null if it is not one. */
export function eventFromFrame(frame: unknown): InboundEvent | null {
  if (!Array.isArray(frame) || frame[0] !== "EVENT") return null;
  const raw = frame[2];
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== "string"
    || typeof e.pubkey !== "string"
    || typeof e.kind !== "number"
    || typeof e.content !== "string"
    || typeof e.created_at !== "number"
    || !Array.isArray(e.tags)
  ) {
    return null;
  }
  const tags = (e.tags as unknown[]).filter(
    (t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"),
  );
  return {
    id: e.id,
    pubkey: e.pubkey,
    kind: e.kind,
    tags,
    content: e.content,
    created_at: e.created_at,
  };
}

/**
 * Open a subscription and keep it open.
 *
 * Returns immediately with a handle; connection happens in the background and
 * is reported through `onState`. There is no "wait until connected" because
 * there is no useful thing for the caller to do while waiting — the monitor has
 * a money path to watch.
 */
export function subscribeToBuzz(
  config: BuzzConfig,
  handlers: SubscribeHandlers,
  options: SubscribeOptions = {},
): BuzzSubscription {
  const openSocket = options.openSocket ?? defaultOpenSocket;
  const nowMs = options.nowMs ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const firstRetryMs = options.firstRetryMs ?? DEFAULT_FIRST_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const sinceSeconds = options.sinceSeconds ?? Math.floor(nowMs() / 1000);

  let pubkey: string;
  try {
    pubkey = agentPubkey(config.agentSecretKeyHex);
  } catch (error) {
    const state: ListenerState = {
      phase: "misconfigured",
      detail: error instanceof BuzzEventError ? error.message : String(error),
      failures: 0,
    };
    handlers.onState?.(state);
    return { close: () => {}, state: () => state };
  }

  let current: ListenerState = { phase: "connecting", detail: "opening the relay connection", failures: 0 };
  let socket: Socket | null = null;
  let retryHandle: unknown = null;
  let watchdogHandle: unknown = null;
  let stopped = false;
  let failures = 0;

  function setState(phase: ListenerPhase, detail: string): void {
    current = { phase, detail, failures };
    handlers.onState?.(current);
  }

  function clearWatchdog(): void {
    if (watchdogHandle !== null) {
      clearTimer(watchdogHandle);
      watchdogHandle = null;
    }
  }

  /**
   * Restart the idle countdown. Called on EVERY frame, not just messages —
   * a NOTICE or an EOSE proves the socket is alive just as well as a message
   * does, and treating only messages as liveness would reconnect a healthy
   * connection to a quiet channel.
   */
  function touch(): void {
    clearWatchdog();
    watchdogHandle = setTimer(() => {
      if (stopped) return;
      // Not an error the relay reported — an absence we inferred. Say so.
      drop(`no frame from the relay for ${Math.round(idleTimeoutMs / 1000)}s — presuming the socket is dead`);
    }, idleTimeoutMs);
  }

  function drop(reason: string): void {
    if (stopped) return;
    clearWatchdog();
    try {
      socket?.close();
    } catch {
      // Closing an already-dead socket is not a new failure.
    }
    socket = null;
    failures += 1;
    const delay = nextRetryDelayMs(failures, firstRetryMs, maxRetryMs);
    setState("retrying", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
    retryHandle = setTimer(() => {
      retryHandle = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    setState("connecting", `opening ${config.relayUrl}`);

    let sock: Socket;
    try {
      sock = openSocket(config.relayUrl);
    } catch (error) {
      drop(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = sock;
    touch();

    sock.addEventListener("error", () => {
      // The WS error event carries no detail by design; the URL is what helps.
      if (socket === sock) drop(`could not reach ${config.relayUrl}`);
    });

    sock.addEventListener("close", () => {
      if (socket === sock) drop("relay closed the connection");
    });

    sock.addEventListener("message", (event: { data: unknown }) => {
      if (socket !== sock || stopped) return;
      touch();

      let frame: unknown;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return; // Unparseable frames are not ours to act on.
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

      if (frame[0] === "AUTH" && typeof frame[1] === "string") {
        setState("authenticating", "answering the relay's AUTH challenge");
        try {
          const auth = signEvent(
            buildAuthEvent({
              agentPubkeyHex: pubkey,
              relayUrl: config.relayUrl,
              challenge: frame[1],
              createdAt: Math.floor(nowMs() / 1000),
              authTag: config.authTag,
            }),
            config.agentSecretKeyHex,
          );
          sock.send(JSON.stringify(["AUTH", auth]));
          // Subscribe straight away, same reasoning as the publish path: the
          // relay applies the session's authority to subsequent frames, and a
          // rejected AUTH surfaces as a CLOSED on the subscription with a
          // reason, which is more informative than an OK we would have to
          // correlate ourselves.
          sock.send(buildReqFrame(config.channelId, sinceSeconds));
        } catch (error) {
          // A signing failure is configuration, not transport. Retrying cannot
          // fix it, so stop rather than spin.
          stopped = true;
          clearWatchdog();
          setState("misconfigured", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (frame[0] === "EOSE" && frame[1] === SUBSCRIPTION_ID) {
        // Stored events are done; everything after this is live. This is the
        // first moment the listener is genuinely working, so it is the first
        // moment it may claim to be.
        failures = 0;
        setState("listening", `subscribed to channel ${config.channelId}`);
        return;
      }

      if (frame[0] === "CLOSED" && frame[1] === SUBSCRIPTION_ID) {
        const why = typeof frame[2] === "string" && frame[2] ? frame[2] : "no reason given";
        drop(`relay closed the subscription: ${why}`);
        return;
      }

      const inbound = eventFromFrame(frame);
      if (inbound) {
        // The relay may deliver stored events before EOSE. Hand them over
        // regardless — the decision layer owns replay rejection, and duplicating
        // that judgement here would create a second place for it to be wrong.
        try {
          handlers.onMessage(inbound);
        } catch {
          // A handler that throws must not take the socket down with it.
        }
      }
    });
  }

  connect();

  return {
    close(): void {
      if (stopped) return;
      stopped = true;
      clearWatchdog();
      if (retryHandle !== null) clearTimer(retryHandle);
      try {
        socket?.close();
      } catch {
        // Nothing to salvage.
      }
      socket = null;
      setState("closed", "listener stopped");
    },
    state: () => current,
  };
}

function defaultOpenSocket(url: string): Socket {
  if (typeof WebSocket === "undefined") {
    throw new BuzzEventError("global WebSocket is unavailable — Node 22.4+ is required to reach Buzz");
  }
  return new WebSocket(url) as unknown as Socket;
}

/**
 * One line for the board's trust row.
 *
 * `listening` is the only phase that means questions will be answered.
 * Everything else says so plainly, because a listener that is retrying looks
 * exactly like a channel nobody has posted in.
 */
export function describeListenerRow(state: ListenerState | null): { status: "ok" | "degraded" | "off"; text: string } {
  if (!state) return { status: "off", text: "inbound replies are off" };
  switch (state.phase) {
    case "listening":
      return { status: "ok", text: "listening for questions" };
    case "connecting":
    case "authenticating":
      return { status: "degraded", text: `${state.phase} — not answering yet` };
    case "retrying":
      return { status: "degraded", text: `not listening — ${state.detail}` };
    case "misconfigured":
      return { status: "degraded", text: `misconfigured — ${state.detail}` };
    case "closed":
      return { status: "off", text: "listener stopped" };
  }
}
