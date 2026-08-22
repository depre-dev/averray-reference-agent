// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminDemandFeed, AdminDemandWindow } from "../lib/monitor/admin-demand.js";
import { useAdminDemand } from "./useAdminDemand.js";

function unavailableFeed(window: AdminDemandWindow): AdminDemandFeed {
  return {
    schemaVersion: "averray.monitor.arrivals-journeys.v1",
    generatedAt: "2026-08-22T10:00:00.000Z",
    window,
    timeline: { unavailable: "fixture" },
    journeys: { unavailable: "fixture" },
  };
}

describe("useAdminDemand", () => {
  it("reads the monitor-authenticated proxy and refetches the selected window", async () => {
    const fetcher = vi.fn(async (url: string) => unavailableFeed(url.includes("window=30d") ? "30d" : "48h"));
    const { result } = renderHook(() => useAdminDemand({
      url: "/monitor/admin-demand?fixture=journeys",
      intervalMs: 0,
      journeyLimit: 50,
      fetcher,
    }));

    await waitFor(() => expect(result.current.feed?.window).toBe("48h"));
    expect(fetcher).toHaveBeenCalledWith("/monitor/admin-demand?fixture=journeys&window=48h&limit=50");

    act(() => result.current.setWindow("30d"));
    await waitFor(() => expect(result.current.feed?.window).toBe("30d"));
    expect(fetcher).toHaveBeenCalledWith("/monitor/admin-demand?fixture=journeys&window=30d&limit=50");
  });

  it("does not touch the admin feed when the desktop panel is disabled", () => {
    const fetcher = vi.fn(async () => unavailableFeed("48h"));
    const { result } = renderHook(() => useAdminDemand({ enabled: false, fetcher }));
    expect(result.current.feed).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
