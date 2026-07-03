// useProductHealth — polls GET /monitor/product-health (the live-product probes)
// for the Monitoring lane. Degraded-safe: a failed fetch leaves the last good
// snapshot + surfaces the error; it never throws into render.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductHealth } from "../lib/monitor/product-health.js";

const DEFAULT_URL = "/monitor/product-health";
const DEFAULT_INTERVAL_MS = 20_000;

export interface UseProductHealthOptions {
  url?: string;
  intervalMs?: number;
  /** Injected fetcher (tests / non-browser). Defaults to fetch + JSON. */
  fetcher?: (url: string) => Promise<ProductHealth>;
  /** When false, the poll is not started (default true). */
  live?: boolean;
  /** When false, the hook does NO fetching at all (tests / disabled contexts). */
  enabled?: boolean;
}

export interface ProductHealthState {
  health: ProductHealth | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
}

async function defaultFetcher(url: string): Promise<ProductHealth> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`product-health fetch failed: ${res.status}`);
  return (await res.json()) as ProductHealth;
}

export function useProductHealth(options: UseProductHealthOptions = {}): ProductHealthState {
  const { url = DEFAULT_URL, intervalMs = DEFAULT_INTERVAL_MS, fetcher = defaultFetcher, live = true, enabled = true } = options;
  const [health, setHealth] = useState<ProductHealth | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [isLoading, setIsLoading] = useState(enabled);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await fetcher(url);
      if (!mounted.current) return;
      setHealth(next);
      setError(undefined);
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, [fetcher, url]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    void load();
    if (!live) return () => void (mounted.current = false);
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load, live, intervalMs, enabled]);

  return { health, error, isLoading, refresh: () => void load() };
}
