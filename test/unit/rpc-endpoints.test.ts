import { describe, expect, it, vi } from "vitest";

import { fetchWithTimeout, orderedRpcEndpoints, readChainWithFailover } from "../../services/slack-operator/src/rpc-endpoints.js";

const dns = (host: string): Error => {
  const inner = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return Object.assign(new TypeError("fetch failed"), { cause: inner });
};

describe("ordered RPC endpoints", () => {
  it("puts the primary first and keeps backups in order, without duplicates", () => {
    expect(orderedRpcEndpoints("https://eth-rpc.polkadot.io/", [
      "https://eth-rpc.polkadot.io/",
      " https://backup.example/rpc ",
    ])).toEqual([
      "https://eth-rpc.polkadot.io/",
      "https://backup.example/rpc",
    ]);
  });

  it("a failing primary yields a value from the next listed host, and that host is named", async () => {
    const result = await readChainWithFailover({
      endpoints: ["https://services.polkadothub-rpc.com/mainnet/", "https://eth-rpc.polkadot.io/"],
      read: async (url) => {
        if (url.includes("polkadothub")) throw dns("services.polkadothub-rpc.com");
        return { balance: "0x1" };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.host).toBe("eth-rpc.polkadot.io");
    expect(result.attempt.value).toEqual({ balance: "0x1" });
  });

  it("names every host that failed when none answer", async () => {
    const result = await readChainWithFailover({
      endpoints: ["https://dead.example/rpc"],
      read: async () => { throw dns("dead.example"); },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toBe("dead.example: ENOTFOUND dead.example");
    expect(result.detail).not.toContain("fetch failed");
  });

  it("aborts a fetch that never answers", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        });
      }) as typeof fetch;
      const pending = fetchWithTimeout(fetchImpl, 8_000)("https://hung.example/rpc").then(
        () => false,
        () => aborted,
      );
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
