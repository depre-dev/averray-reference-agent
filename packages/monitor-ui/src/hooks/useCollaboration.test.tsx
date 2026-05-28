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

    expect(poster).toHaveBeenCalledWith({ text: "what's blocking?", relatedPr: { repo: "depre-dev/agent", number: 548 } });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["q", "a"]));
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
  });
});
