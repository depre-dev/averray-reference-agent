import { useCallback, useState } from "react";
import useSWR from "swr";
import {
  parseAdminDemandFeed,
  type AdminDemandFeed,
  type AdminDemandWindow,
} from "../lib/monitor/admin-demand.js";

const DEFAULT_URL = "/monitor/admin-demand";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JOURNEY_LIMIT = 50;

export interface UseAdminDemandOptions {
  url?: string;
  intervalMs?: number;
  journeyLimit?: number;
  fetcher?: (url: string) => Promise<AdminDemandFeed>;
  enabled?: boolean;
}

export interface AdminDemandState {
  feed: AdminDemandFeed | undefined;
  error: unknown;
  isLoading: boolean;
  window: AdminDemandWindow;
  setWindow: (window: AdminDemandWindow) => void;
  refresh: () => void;
}

async function defaultFetcher(url: string): Promise<AdminDemandFeed> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`admin demand fetch failed: ${response.status}`);
  return parseAdminDemandFeed(await response.json());
}

export function useAdminDemand(options: UseAdminDemandOptions = {}): AdminDemandState {
  const {
    url = DEFAULT_URL,
    intervalMs = DEFAULT_INTERVAL_MS,
    journeyLimit = DEFAULT_JOURNEY_LIMIT,
    fetcher = defaultFetcher,
    enabled = true,
  } = options;
  const [window, setWindow] = useState<AdminDemandWindow>("48h");
  const requestUrl = enabled ? withQuery(url, window, journeyLimit) : null;
  const { data, error, isLoading, mutate } = useSWR<AdminDemandFeed>(requestUrl, fetcher, {
    refreshInterval: intervalMs,
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    keepPreviousData: true,
  });
  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return { feed: data, error, isLoading, window, setWindow, refresh };
}

function withQuery(url: string, window: AdminDemandWindow, journeyLimit: number): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}window=${encodeURIComponent(window)}&limit=${encodeURIComponent(String(journeyLimit))}`;
}
