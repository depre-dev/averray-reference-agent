// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useMonitorBoard } from "./useMonitorBoard.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import { SNAPSHOT_KEY_PREFIX, type StorageLike } from "../lib/monitor/snapshot-store.js";

afterEach(cleanup);

// ── Fakes ───────────────────────────────────────────────────────────

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
  emitNamed(type: string, data: string): void {
    this.listeners.get(type)?.({ type, data } as MessageEvent);
  }
}

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  // Fresh SWR cache per test; no dedupe so refresh re-fetches immediately.
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function board(cards: Array<{ id: string }>, at: string): MonitorBoard {
  return { cards, at } as unknown as MonitorBoard;
}

const ES = FakeEventSource as unknown as typeof EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe("useMonitorBoard", () => {
  test("loads the initial board over HTTP", async () => {
    const fetcher = vi.fn(async () => board([{ id: "agent #1" }], "2026-05-28T10:00:00Z"));
    const { result } = renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage: memStorage() }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.board?.cards.length).toBe(1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.lastUpdated).toBe("2026-05-28T10:00:00Z");
  });

  test("an SSE board.snapshot replaces the board and persists to storage", async () => {
    const storage = memStorage();
    const fetcher = vi.fn(async () => board([{ id: "agent #1" }], "2026-05-28T10:00:00Z"));
    const { result } = renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage }), { wrapper });

    await waitFor(() => expect(result.current.board).toBeDefined());
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;

    // M1' BoardSnapshotV2 payload — no `type` field; the client tags it.
    act(() => {
      es.emitNamed(
        "board.snapshot",
        JSON.stringify({ cards: [{ id: "agent #9" }, { id: "agent #10" }], at: "2026-05-28T11:00:00Z", repo: "x/y" }),
      );
    });

    await waitFor(() => expect(result.current.board?.cards.map((c) => c.id)).toEqual(["agent #9", "agent #10"]));
    expect(result.current.lastUpdated).toBe("2026-05-28T11:00:00Z");
    // Snapshot persisted for the future time-travel UI.
    expect(storage.getItem(`${SNAPSHOT_KEY_PREFIX}2026-05-28T11:00:00Z`)).toBeTruthy();
  });

  test("an SSE board.card.added appends without a refetch (the spawn path)", async () => {
    const fetcher = vi.fn(async () => board([{ id: "agent #1" }], "2026-05-28T10:00:00Z"));
    const { result } = renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage: memStorage() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.board?.cards.length).toBe(1));
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;

    act(() => {
      es.emitNamed(
        "board.card.added",
        JSON.stringify({ card: { id: "agent #2", lane: "operator-review" }, at: "2026-05-28T10:05:00Z" }),
      );
    });

    await waitFor(() => expect(result.current.board?.cards.map((c) => c.id)).toContain("agent #2"));
    // No extra HTTP fetch — the event patched the cache in place.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("status follows the stream lifecycle (connecting → open)", async () => {
    const fetcher = vi.fn(async () => board([], "2026-05-28T10:00:00Z"));
    const { result } = renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage: memStorage() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe("connecting"));
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    act(() => es.onopen?.({}));
    expect(result.current.status).toBe("open");
  });

  test("refresh re-fetches the board snapshot", async () => {
    const fetcher = vi.fn(async () => board([{ id: "agent #1" }], "2026-05-28T10:00:00Z"));
    const { result } = renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage: memStorage() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.board).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  test("live:false skips the SSE connection entirely", async () => {
    const fetcher = vi.fn(async () => board([{ id: "agent #1" }], "2026-05-28T10:00:00Z"));
    renderHook(() => useMonitorBoard({ fetcher, EventSourceCtor: ES, storage: memStorage(), live: false }), {
      wrapper,
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(FakeEventSource.instances.length).toBe(0);
  });
});
