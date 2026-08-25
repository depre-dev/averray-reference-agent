// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OvernightLedgerFeed, OvernightWindow } from "../lib/monitor/overnight-ledger.js";
import { useOvernightLedger } from "./useOvernightLedger.js";

function unavailableFeed(window: OvernightWindow): OvernightLedgerFeed {
  return {
    schemaVersion: "averray.monitor.overnight-ledger.v1",
    generatedAt: "2026-08-24T05:00:00.000Z",
    window,
    ledger: { state: "unavailable", reason: "fixture ledger unavailable" },
    topupDestinations: { state: "unavailable", reason: "fixture top-ups unavailable" },
    readIdentity: { state: "unavailable", reason: "fixture identity unavailable" },
  };
}

describe("useOvernightLedger", () => {
  it("uses one selected window for the ledger and top-up reads", async () => {
    const fetcher = vi.fn(async (url: string) => unavailableFeed(
      url.includes("window=48h") ? "48h" : url.includes("window=12h") ? "12h" : "24h",
    ));
    const { result } = renderHook(() => useOvernightLedger({
      url: "/monitor/overnight-ledger?fixture=ledger",
      intervalMs: 0,
      fetcher,
    }));

    await waitFor(() => expect(result.current.ledger.state).toBe("unavailable"));
    expect(fetcher).toHaveBeenCalledWith("/monitor/overnight-ledger?fixture=ledger&window=24h");
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => result.current.setWindow("48h"));
    await waitFor(() => expect(result.current.window).toBe("48h"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/monitor/overnight-ledger?fixture=ledger&window=48h"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not request the operator feed when the desktop board is disabled", () => {
    const fetcher = vi.fn(async () => unavailableFeed("24h"));
    const { result } = renderHook(() => useOvernightLedger({ enabled: false, fetcher }));
    expect(result.current.ledger).toEqual({ state: "unavailable", reason: "feed unavailable — read disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
