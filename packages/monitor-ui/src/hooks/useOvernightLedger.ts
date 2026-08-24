import { useCallback, useState } from "react";
import useSWR from "swr";

import {
  loadingReading,
  parseOvernightLedgerFeed,
  unavailableReading,
  type OvernightLedgerFeed,
  type OvernightLedgerPayload,
  type OvernightWindow,
  type RemoteFeedReading,
  type TopupDestinationsPayload,
} from "../lib/monitor/overnight-ledger.js";

const DEFAULT_URL = "/monitor/overnight-ledger";
const DEFAULT_INTERVAL_MS = 60_000;

export interface UseOvernightLedgerOptions {
  url?: string;
  intervalMs?: number;
  fetcher?: (url: string) => Promise<OvernightLedgerFeed>;
  enabled?: boolean;
}

export interface OvernightLedgerState {
  ledger: RemoteFeedReading<OvernightLedgerPayload>;
  topupDestinations: RemoteFeedReading<TopupDestinationsPayload>;
  window: OvernightWindow;
  setWindow: (window: OvernightWindow) => void;
  refresh: () => void;
}

async function defaultFetcher(url: string): Promise<OvernightLedgerFeed> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`overnight ledger fetch failed: ${response.status}`);
  return parseOvernightLedgerFeed(await response.json());
}

export function useOvernightLedger(options: UseOvernightLedgerOptions = {}): OvernightLedgerState {
  const {
    url = DEFAULT_URL,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetcher = defaultFetcher,
    enabled = true,
  } = options;
  const [window, setWindow] = useState<OvernightWindow>("24h");
  const requestUrl = enabled ? withQuery(url, window) : null;
  const { data, error, isLoading, mutate } = useSWR<OvernightLedgerFeed>(requestUrl, fetcher, {
    refreshInterval: intervalMs,
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    keepPreviousData: true,
  });
  const current = data?.window === window ? data : undefined;
  const fallback = error
    ? unavailableReading<never>(`feed unavailable — ${errorMessage(error)}`)
    : isLoading
      ? loadingReading<never>()
      : unavailableReading<never>(enabled ? "feed unavailable — no reading returned" : "feed unavailable — read disabled");
  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return {
    ledger: current?.ledger ?? fallback,
    topupDestinations: current?.topupDestinations ?? fallback,
    window,
    setWindow,
    refresh,
  };
}

function withQuery(url: string, window: OvernightWindow): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}window=${encodeURIComponent(window)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
