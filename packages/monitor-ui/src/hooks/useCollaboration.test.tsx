// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useCollaboration } from "./useCollaboration.js";
import type { CollaborationMessage } from "../lib/monitor/collaboration.js";

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
