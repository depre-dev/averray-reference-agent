// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { reduceStreamingTurn, useCollaboration } from "./useCollaboration.js";
import type {
  CollaborationMessage,
  CopilotStreamEvent,
  CopilotStreamSource,
} from "../lib/monitor/collaboration.js";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function msg(id: string, author: CollaborationMessage["author"], text: string): CollaborationMessage {
  return { id, ts: Date.parse("2026-05-28T10:00:00Z"), author, kind: "chat", text, addressedTo: "everyone" };
}

describe("useCollaboration", () => {
  test("loads the collaboration feed", async () => {
    const fetcher = vi.fn(async () => [msg("1", "hermes", "watching the board")]);
    const { result } = renderHook(() => useCollaboration({ fetcher, refreshIntervalMs: 0 }), { wrapper });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]?.text).toBe("watching the board");
  });

  test("ask posts the question (scoped) and revalidates the feed", async () => {
    let turns: CollaborationMessage[] = [];
    const fetcher = vi.fn(async () => turns);
    const poster = vi.fn(async () => {
      turns = [msg("q", "operator", "what's blocking?"), msg("a", "hermes", "CI is still running")];
    });
    const { result } = renderHook(() => useCollaboration({ fetcher, poster, refreshIntervalMs: 0 }), { wrapper });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());

    await act(async () => {
      result.current.ask("what's blocking?", { repo: "depre-dev/agent", number: 548 });
    });

    expect(poster).toHaveBeenCalledWith({
      text: "what's blocking?",
      addressedTo: "hermes",
      relatedPr: { repo: "depre-dev/agent", number: 548 },
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["q", "a"]));
  });

  test("ask can address a non-Hermes collaboration target", async () => {
    const poster = vi.fn(async () => {});
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], poster, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.ask("please inspect this", undefined, "codex"));

    expect(poster).toHaveBeenCalledWith({ text: "please inspect this", addressedTo: "codex" });
    expect(result.current.messages.at(-1)).toMatchObject({
      author: "operator",
      addressedTo: "codex",
      text: "please inspect this",
    });
  });

  test("a blank question does not post", async () => {
    const poster = vi.fn(async () => {});
    const { result } = renderHook(() => useCollaboration({ fetcher: async () => [], poster, refreshIntervalMs: 0 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.messages).toEqual([]));
    act(() => result.current.ask("   "));
    expect(poster).not.toHaveBeenCalled();
  });

  test("enabled:false neither fetches nor polls", async () => {
    const fetcher = vi.fn(async () => [msg("1", "hermes", "x")]);
    const { result } = renderHook(() => useCollaboration({ enabled: false, fetcher }), { wrapper });
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.enabled).toBe(false);
  });

  // P0-4: Ask-Hermes must produce immediate visible feedback.
  test("ask optimistically renders the operator's message before the reply", async () => {
    // A poster that never resolves: the optimistic message must show anyway.
    let release: () => void = () => {};
    const poster = vi.fn(() => new Promise<void>((res) => (release = res)));
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], poster, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.ask("what's blocking?"));

    // Optimistic operator message is present, and pending is true, with no error.
    expect(result.current.messages.map((m) => m.text)).toContain("what's blocking?");
    expect(result.current.messages.at(-1)?.author).toBe("operator");
    expect(result.current.pending).toBe(true);
    expect(result.current.sendError).toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  test("ask surfaces a send error (does NOT silently swallow) and rolls back the optimistic message", async () => {
    const poster = vi.fn(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], poster, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.ask("did CI pass?");
    });

    await waitFor(() => expect(result.current.sendError).toBeTruthy());
    expect(result.current.pending).toBe(false);
    // Rolled back: the un-sent question is not left dangling as if it landed.
    expect(result.current.messages.map((m) => m.text)).not.toContain("did CI pass?");
    expect(result.current.error).toBeFalsy(); // POST failure is sendError, not the feed error
  });

  test("ask does nothing when collaboration is disabled (honest no-op, not a silent post)", () => {
    const poster = vi.fn(async () => {});
    const { result } = renderHook(
      () => useCollaboration({ enabled: false, fetcher: async () => [], poster }),
      { wrapper },
    );
    act(() => result.current.ask("hello?"));
    expect(poster).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  test("optimistic message is reconciled away once the server feed echoes it", async () => {
    let turns: CollaborationMessage[] = [];
    const fetcher = vi.fn(async () => turns);
    const poster = vi.fn(async () => {
      turns = [msg("q", "operator", "status?"), msg("a", "hermes", "all green")];
    });
    const { result } = renderHook(
      () => useCollaboration({ fetcher, poster, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());

    await act(async () => {
      result.current.ask("status?");
    });

    // After the server echoes the operator message, we render exactly one
    // copy (server's), not the optimistic duplicate.
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["q", "a"]));
    expect(result.current.messages.filter((m) => m.text === "status?")).toHaveLength(1);
  });
});

// Feature #3 — live-token streaming. A synchronous delta source lets the test
// push SSE events; the hook accumulates them into an in-progress Hermes turn.
describe("useCollaboration — live-token streaming (feature #3)", () => {
  /** A DI delta source that captures the handler so the test can drive events. */
  function controllableSource(): { source: CopilotStreamSource; emit: (e: CopilotStreamEvent) => void; unsubscribed: () => boolean } {
    let handler: ((e: CopilotStreamEvent) => void) | undefined;
    let off = false;
    return {
      source: (onEvent) => {
        handler = onEvent;
        return () => {
          off = true;
        };
      },
      emit: (e) => handler?.(e),
      unsubscribed: () => off,
    };
  }

  test("accumulates hermes.delta into a live streaming turn, then finalizes on completion", async () => {
    const { source, emit } = controllableSource();
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], deltaSource: source, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => emit({ type: "hermes.delta", payload: { turnId: "t1", delta: "Operator ", addressedTo: "everyone" } }));
    act(() => emit({ type: "hermes.delta", payload: { turnId: "t1", delta: "review is waiting." } }));

    // Mid-stream: one Hermes turn, text accumulated, flagged streaming + live.
    const streaming = result.current.messages.find((m) => m.id === "t1");
    expect(streaming?.text).toBe("Operator review is waiting.");
    expect(streaming?.author).toBe("hermes");
    expect(streaming?.streaming).toBe(true);
    expect(streaming?.hermesMode).toBe("live");

    act(() =>
      emit({ type: "hermes.turn.completed", payload: { turnId: "t1", text: "Operator review is waiting. Why: board.", hermesMode: "live" } }),
    );

    // Finalized: authoritative text, streaming flag cleared.
    const done = result.current.messages.find((m) => m.id === "t1");
    expect(done?.text).toBe("Operator review is waiting. Why: board.");
    expect(done?.streaming).toBeUndefined();
  });

  test("reconciles the streamed turn away once the polled feed echoes the finalized text", async () => {
    const { source, emit } = controllableSource();
    // The feed starts empty, then (after the turn completes) the poll begins
    // returning the same Hermes reply as a real server message.
    let turns: CollaborationMessage[] = [];
    const fetcher = vi.fn(async () => turns);
    // A small refresh interval lets SWR re-poll so the echo lands on its own.
    const { result } = renderHook(
      () => useCollaboration({ fetcher, deltaSource: source, refreshIntervalMs: 20 }),
      { wrapper },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());

    act(() => emit({ type: "hermes.turn.completed", payload: { turnId: "t1", text: "all green", hermesMode: "live" } }));
    // Before the echo: the streamed turn is the only copy of the reply.
    expect(result.current.messages.filter((m) => m.text === "all green")).toHaveLength(1);
    expect(result.current.messages.find((m) => m.text === "all green")?.id).toBe("t1");

    // The server feed now carries the same Hermes reply under its own id.
    turns = [{ id: "srv-a", ts: Date.now(), author: "hermes", kind: "chat", text: "all green", addressedTo: "everyone" }];

    // Once the poll echoes it, the streamed turn drops — exactly one copy, the
    // server's — so the reply never renders twice.
    await waitFor(() => {
      const green = result.current.messages.filter((m) => m.text === "all green");
      expect(green).toHaveLength(1);
      expect(green[0]?.id).toBe("srv-a");
    });
  });

  test("finalizes an interrupted stream honestly as templated (no stuck live bubble)", async () => {
    const { source, emit } = controllableSource();
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], deltaSource: source, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Partial live tokens streamed…
    act(() => emit({ type: "hermes.delta", payload: { turnId: "t1", delta: "half a th" } }));
    expect(result.current.messages.find((m) => m.id === "t1")?.streaming).toBe(true);
    expect(result.current.messages.find((m) => m.id === "t1")?.hermesMode).toBe("live");

    // …then the gateway failed mid-stream and the co-pilot fell back to a
    // templated reply. The terminal event carries the real text + mode.
    act(() =>
      emit({
        type: "hermes.turn.completed",
        payload: { turnId: "t1", text: "Operator review has 2 cards waiting.", hermesMode: "templated" },
      }),
    );
    const done = result.current.messages.find((m) => m.id === "t1");
    expect(done?.text).toBe("Operator review has 2 cards waiting."); // partial replaced
    expect(done?.streaming).toBeUndefined(); // not stuck
    expect(done?.hermesMode).toBe("templated"); // honest badge, not a live lie
  });

  test("renders exactly as before when no delta events ever arrive (degraded-safe)", async () => {
    const { source } = controllableSource(); // never emits
    const { result } = renderHook(
      () => useCollaboration({ fetcher: async () => [{ id: "1", ts: 1, author: "hermes", kind: "chat", text: "hi", addressedTo: "everyone" }], deltaSource: source, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]?.text).toBe("hi");
    expect(result.current.messages[0]?.streaming).toBeUndefined();
  });

  test("unsubscribes from the delta source on unmount", async () => {
    const { source, unsubscribed } = controllableSource();
    const { unmount, result } = renderHook(
      () => useCollaboration({ fetcher: async () => [], deltaSource: source, refreshIntervalMs: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    unmount();
    expect(unsubscribed()).toBe(true);
  });
});

describe("reduceStreamingTurn (pure)", () => {
  const empty = () => new Map();

  test("delta creates then appends to a turn, marking it streaming", () => {
    let m = reduceStreamingTurn(empty(), { type: "hermes.delta", payload: { turnId: "t", delta: "ab" } });
    m = reduceStreamingTurn(m, { type: "hermes.delta", payload: { turnId: "t", delta: "cd" } });
    expect(m.get("t")).toMatchObject({ text: "abcd", streaming: true });
  });

  test("completion replaces text with the authoritative final and clears streaming", () => {
    let m = reduceStreamingTurn(empty(), { type: "hermes.delta", payload: { turnId: "t", delta: "partial" } });
    m = reduceStreamingTurn(m, { type: "hermes.turn.completed", payload: { turnId: "t", text: "final full text" } });
    expect(m.get("t")).toMatchObject({ text: "final full text", streaming: false });
  });

  test("ignores malformed events (no turnId, non-string/empty delta, empty completed text)", () => {
    const base = empty();
    // @ts-expect-error — exercising a malformed payload at the boundary
    expect(reduceStreamingTurn(base, { type: "hermes.delta", payload: {} })).toBe(base);
    expect(reduceStreamingTurn(base, { type: "hermes.delta", payload: { turnId: "t", delta: "" } })).toBe(base);
    expect(reduceStreamingTurn(base, { type: "hermes.turn.completed", payload: { turnId: "t", text: "" } })).toBe(base);
  });

  test("a completion for an unseen turn still renders (terminal text is authoritative)", () => {
    const m = reduceStreamingTurn(empty(), { type: "hermes.turn.completed", payload: { turnId: "t", text: "solo" } });
    expect(m.get("t")).toMatchObject({ text: "solo", streaming: false });
  });
});
