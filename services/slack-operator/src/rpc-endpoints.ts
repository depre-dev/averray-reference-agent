// One ordered RPC list for every monitor chain read.
//
// PRODUCT_HEALTH_RPC_URL is first. PRODUCT_HEALTH_RPC_BACKUPS follows, in the
// order written. A dead primary must not be the only attempt: the next listed
// host is asked, and the host that answered is the one the panel names.
//
// Blockscout's eth-rpc is not on this list and must not be added. The monitor
// shares the VPS IP with the backend, and Blockscout's 500 requests per 15
// minutes per IP are reserved for the backend.

import { describeFeedError, hostFromUrl } from "./probe-transport.js";

/** How long one host may sit silent before the next listed host is tried. */
export const RPC_ATTEMPT_TIMEOUT_MS = 8_000;

export function orderedRpcEndpoints(
  primary: string | undefined,
  backups: readonly string[] | string | undefined,
): string[] {
  const extra = typeof backups === "string" || backups == null
    ? (backups ?? "").split(",")
    : backups;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [primary ?? "", ...extra]) {
    const url = item.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function fetchWithTimeout(fetchImpl: typeof fetch, timeoutMs = RPC_ATTEMPT_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: init?.signal ?? controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RpcAttempt<T> {
  url: string;
  host: string;
  value: T;
}

/**
 * Try each endpoint in order. The first value `reject` does not refuse wins,
 * and its host is part of the result so the panel can name it.
 */
export async function readChainWithFailover<T>(input: {
  endpoints: readonly string[];
  read: (url: string) => Promise<T>;
  /** A reason means this host did not answer usefully; the next one is tried. */
  reject?: (value: T) => string | null;
}): Promise<{ ok: true; attempt: RpcAttempt<T> } | { ok: false; detail: string }> {
  if (input.endpoints.length === 0) return { ok: false, detail: "no RPC endpoint configured" };
  const failures: string[] = [];
  for (const url of input.endpoints) {
    const host = hostFromUrl(url) ?? url;
    try {
      const value = await input.read(url);
      const rejected = input.reject?.(value) ?? null;
      if (rejected) {
        failures.push(`${host}: ${rejected}`);
        continue;
      }
      return { ok: true, attempt: { url, host, value } };
    } catch (error) {
      failures.push(`${host}: ${describeFeedError(error, url)}`);
    }
  }
  return { ok: false, detail: failures.join("; ") };
}
