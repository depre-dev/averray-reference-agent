// @vitest-environment jsdom
//
// The ops container's contract (docs/OPS_ONLY_PIVOT.md).
//
// This replaced a 15-test file that was almost entirely delivery and
// conversation: mission spawning, suite run/save/approve, card→drawer wiring,
// /mute, and the autopilot toggle. All retired — missions and suites left with
// the runners, and every command now lives in Buzz rather than a composer.
//
// The two guarantees that are NOT delivery are carried over verbatim in intent:
// the container must wire a resolved fetch through to the board, and it must
// still render chrome when the fetch FAILS rather than showing a blank page.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";

import { MonitorPage } from "./MonitorPage.js";
import type { MonitorBoard } from "./lib/monitor/board-cache.js";

afterEach(cleanup);

/** No-op EventSource so the SSE hook doesn't reach the network in tests. */
class ES {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("MonitorPage — ops container", () => {
  test("wires a resolved fetch through to the rendered board", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => ({ cards: [], at: "2026-05-28T10:30:00Z" }));
    const { container } = render(
      <MonitorPage options={{ fetcher, EventSourceCtor: ES as never }} />,
    );

    await waitFor(() => expect(within(container).getByRole("banner")).toBeTruthy());
    expect(fetcher).toHaveBeenCalled();
  });

  // The guarantee is unchanged by the pivot; only what it renders changed.
  test("renders chrome without crashing when the fetch fails — no blank page", async () => {
    const fetcher = vi.fn(async (): Promise<MonitorBoard> => {
      throw new Error("no backend");
    });
    const { container } = render(
      <MonitorPage options={{ fetcher, EventSourceCtor: ES as never }} />,
    );

    await waitFor(() => expect(within(container).getByRole("banner")).toBeTruthy());
  });
});
