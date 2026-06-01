// Tests for live-stream.js — pure-logic helpers for the monitor
// SSE client (backoff math, status state machine). The LiveStream
// class itself is exercised by the M4 frontend smoke test;
// pure-logic invariants live here.

import { test, assert } from "vitest";

import { backoffDelayMs, nextStatus, RECONNECT_CAP_MS, LiveStream } from "./live-stream.js";
import type { MonitorEvent } from "./board-cache.js";

// ── backoffDelayMs ──────────────────────────────────────────────────

test("backoffDelayMs: attempt 0 returns 0 (immediate first connect)", () => {
  assert.equal(backoffDelayMs(0), 0);
});

test("backoffDelayMs: exponential doubling — 1000 / 2000 / 4000 / 8000 / 16000", () => {
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(5), 16000);
});

test("backoffDelayMs: caps at RECONNECT_CAP_MS (30s)", () => {
  assert.equal(backoffDelayMs(6), RECONNECT_CAP_MS);
  assert.equal(backoffDelayMs(10), RECONNECT_CAP_MS);
  assert.equal(backoffDelayMs(99), RECONNECT_CAP_MS);
});

test("backoffDelayMs: defensive — non-number / negative attempt returns 0", () => {
  // @ts-expect-error — intentional non-number
  assert.equal(backoffDelayMs("not a number"), 0);
  assert.equal(backoffDelayMs(-1), 0);
  assert.equal(backoffDelayMs(NaN), 0);
  assert.equal(backoffDelayMs(undefined), 0);
});

test("backoffDelayMs: cap is exactly 30000ms (matches RECONNECT_CAP_MS export)", () => {
  // Locking the cap value in case the constant gets accidentally bumped
  // without updating the spec / docs.
  assert.equal(RECONNECT_CAP_MS, 30_000);
});

// ── nextStatus state machine ────────────────────────────────────────

test("nextStatus: idle + connect → connecting", () => {
  assert.equal(nextStatus("connect", "idle"), "connecting");
});

test("nextStatus: connecting + open → open", () => {
  assert.equal(nextStatus("open", "connecting"), "open");
});

test("nextStatus: open + error → reconnecting (the connection dropped)", () => {
  assert.equal(nextStatus("error", "open"), "reconnecting");
});

test("nextStatus: connecting + error → reconnecting (connect attempt failed)", () => {
  assert.equal(nextStatus("error", "connecting"), "reconnecting");
});

test("nextStatus: any state + close → closed (terminal)", () => {
  assert.equal(nextStatus("close", "idle"), "closed");
  assert.equal(nextStatus("close", "connecting"), "closed");
  assert.equal(nextStatus("close", "open"), "closed");
  assert.equal(nextStatus("close", "reconnecting"), "closed");
  assert.equal(nextStatus("close", "closed"), "closed");
});

test("nextStatus: idempotent re-open (already open) stays open", () => {
  assert.equal(nextStatus("connect", "open"), "open");
  assert.equal(nextStatus("open", "open"), "open");
});

test("nextStatus: unknown event type leaves status unchanged (defensive)", () => {
  // @ts-expect-error — intentional unknown event
  assert.equal(nextStatus("kaboom", "open"), "open");
  // @ts-expect-error — intentional unknown event
  assert.equal(nextStatus("kaboom", "idle"), "idle");
});

// ── Backoff progression in a realistic reconnect storm ─────────────

test("backoff progression: total wait through attempt 1..6 is bounded", () => {
  // This is the contract that says "we won't burn excessive cycles
  // retrying a dead server" — even after 6 attempts we've waited
  // < 65 seconds total, which is the right order of magnitude
  // for a transient outage.
  let total = 0;
  for (let i = 1; i <= 6; i++) total += backoffDelayMs(i);
  assert.ok(
    total < 65_000,
    `total backoff through attempt 6 should be < 65s; was ${total}ms`
  );
});

test("backoff progression: attempt N steady-state matches the cap", () => {
  // After the cap kicks in, every subsequent attempt waits exactly
  // 30s. This is the "we'll keep trying forever but won't escalate"
  // shape from the spec.
  assert.equal(backoffDelayMs(10), backoffDelayMs(20));
  assert.equal(backoffDelayMs(20), backoffDelayMs(99));
});

// ── LiveStream class — event tagging + delivery ─────────────────────
//
// A minimal EventSource stand-in: captures the named-event listeners
// LiveStream attaches and lets a test drive events synchronously.

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper — dispatch a named SSE event with a JSON string body. */
  emitNamed(type: string, data: string): void {
    this.listeners.get(type)?.({ type, data } as MessageEvent);
  }
  /** Test helper — dispatch an unnamed `message` event. */
  emitMessage(data: string): void {
    this.onmessage?.({ type: "message", data } as MessageEvent);
  }
}

function freshStream() {
  FakeEventSource.instances = [];
  const stream = new LiveStream({
    url: "/monitor/v2/stream",
    EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
  });
  const received: MonitorEvent[] = [];
  stream.on((e) => received.push(e));
  stream.start();
  const source = FakeEventSource.instances.at(-1) as FakeEventSource;
  return { stream, received, source };
}

test("LiveStream: tags a typeless named-event payload with the event name", () => {
  // The v2 BoardSnapshot body has board fields but no `type`.
  const { received, source } = freshStream();
  source.emitNamed("board.snapshot", JSON.stringify({ cards: [], at: "2026-05-28T00:00:00Z", repo: "x/y" }));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "board.snapshot");
  assert.deepEqual((received[0] as { cards: unknown[] }).cards, []);
});

test("LiveStream: an explicit payload type wins over the event name", () => {
  const { received, source } = freshStream();
  source.emitNamed("board.snapshot", JSON.stringify({ type: "board.card.added", card: { id: "agent #1" } }));
  assert.equal(received[0]?.type, "board.card.added");
});

test("LiveStream: the default 'message' event name is not used as a type", () => {
  const { received, source } = freshStream();
  source.emitMessage(JSON.stringify({ cards: [] }));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, undefined);
});

test("LiveStream: malformed JSON is dropped, not delivered", () => {
  const { received, source } = freshStream();
  source.emitNamed("board.snapshot", "{ not json");
  assert.equal(received.length, 0);
});

test("LiveStream: onStatus fires immediately and tracks open/closed", () => {
  FakeEventSource.instances = [];
  const stream = new LiveStream({
    url: "/x",
    EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
  });
  const statuses: string[] = [];
  stream.onStatus((s) => statuses.push(s));
  assert.equal(statuses[0], "idle"); // fires immediately with current status
  stream.start();
  const source = FakeEventSource.instances.at(-1) as FakeEventSource;
  source.onopen?.({});
  assert.equal(statuses.at(-1), "open");
  stream.stop();
  assert.equal(statuses.at(-1), "closed");
  assert.equal(source.closed, true);
});
