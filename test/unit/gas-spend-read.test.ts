import { describe, expect, it } from "vitest";

import { readGasSpend } from "../../services/slack-operator/src/gas-spend-read.js";

const SIGNER = "0x5a6836c6d4d293f6e5377e6c28054f4171915813";
const OTHER = "0x089a0a57d001bacb8473161e007f0babc1768cee";
const ESCROW = "0x590ebe304e0c7672e2abf3161177d2b94a2ac3fc";

const cfg = {
  rpcUrl: "http://rpc",
  contracts: [ESCROW],
  signerAddress: SIGNER,
  lookbackBlocks: 40000,
};

/**
 * A scripted RPC. `txs` maps hash → {from, selector, gasUsed, price, status};
 * every hash appears once in the log sweep.
 */
function rpc(txs: Record<string, { from: string; sel?: string; gasUsed?: string; price?: string; status?: string }>, over: {
  logsError?: string;
  headError?: boolean;
} = {}): typeof fetch {
  return (async (_u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: any[] };
    const reply = (result: unknown) =>
      ({ ok: true, status: 200, json: async () => ({ result }) }) as unknown as Response;

    if (body.method === "eth_blockNumber") {
      if (over.headError) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      return reply("0x186a0"); // 100000
    }
    if (body.method === "eth_getLogs") {
      if (over.logsError) {
        return { ok: true, status: 200, json: async () => ({ error: { message: over.logsError } }) } as unknown as Response;
      }
      return reply(Object.keys(txs).map((h) => ({ transactionHash: h })));
    }
    if (body.method === "eth_getTransactionByHash") {
      const t = txs[body.params[0] as string];
      return reply(t ? { from: t.from, to: ESCROW, input: (t.sel ?? "0xaabbccdd") + "00".repeat(32), gasPrice: t.price ?? "0x1" } : null);
    }
    if (body.method === "eth_getTransactionReceipt") {
      const t = txs[body.params[0] as string];
      return reply(t ? { gasUsed: t.gasUsed ?? "0x5208", effectiveGasPrice: t.price ?? "0x1", status: t.status ?? "0x1" } : null);
    }
    return reply(null);
  }) as unknown as typeof fetch;
}

describe("readGasSpend", () => {
  it("prices the signer's transactions and keeps the selector", async () => {
    const r = await readGasSpend({
      ...cfg,
      fetchImpl: rpc({ "0x1": { from: SIGNER, sel: "0xb08c763e", gasUsed: "0x64", price: "0x2" } }),
    });
    expect(r.reason).toBeUndefined();
    expect(r.txs).toHaveLength(1);
    expect(r.txs[0]!.selector).toBe("0xb08c763e");
    expect(r.txs[0]!.gasWei).toBe(200n); // 100 gas x price 2
    expect(r.txs[0]!.success).toBe(true);
  });

  it("EXCLUDES other senders from the totals but reports them", async () => {
    // Their gas does not come from the pool the solvency panel meters, so it
    // must not be summed into it — but a second signing key appearing means
    // "signer gas" is no longer the whole cost of running this.
    const r = await readGasSpend({
      ...cfg,
      fetchImpl: rpc({
        "0x1": { from: SIGNER },
        "0x2": { from: OTHER },
        "0x3": { from: OTHER },
      }),
    });
    expect(r.txs).toHaveLength(1);
    expect(r.otherSenders).toEqual([{ address: OTHER, count: 2 }]);
  });

  it("records a revert rather than dropping it", async () => {
    // A reverted transaction still burned gas. Dropping it would understate
    // spend and hide a bug that has a price.
    const r = await readGasSpend({
      ...cfg,
      fetchImpl: rpc({ "0x1": { from: SIGNER, status: "0x0" } }),
    });
    expect(r.txs[0]!.success).toBe(false);
  });

  it("SAYS SO when the transaction cap bites", async () => {
    // A partial total rendered as a complete one understates spend — the wrong
    // direction to be wrong on a board that warns about running out.
    const many: Record<string, { from: string }> = {};
    for (let i = 0; i < 10; i += 1) many[`0x${i}`] = { from: SIGNER };
    const r = await readGasSpend({ ...cfg, maxTx: 4, fetchImpl: rpc(many) });
    expect(r.truncated).toBe(true);
    expect(r.txs).toHaveLength(4);
  });

  it("does not claim truncation when everything fitted", async () => {
    const r = await readGasSpend({ ...cfg, maxTx: 50, fetchImpl: rpc({ "0x1": { from: SIGNER } }) });
    expect(r.truncated).toBe(false);
  });
});

describe("failure is never zero", () => {
  it("returns a reason, not an empty list that would read as 0 DOT spent", async () => {
    // An empty result summarises to "0 DOT" — which reads as free rather than
    // unknown. Every failure path has to carry a reason instead.
    const r = await readGasSpend({ ...cfg, fetchImpl: rpc({}, { logsError: "range too large" }) });
    expect(r.txs).toEqual([]);
    expect(r.reason).toContain("range too large");
  });

  it("reports an unreachable RPC as unreadable", async () => {
    const r = await readGasSpend({ ...cfg, fetchImpl: rpc({}, { headError: true }) });
    expect(r.reason).toContain("unreadable");
  });

  for (const [label, missing] of [
    ["no RPC url", { rpcUrl: undefined }],
    ["no signer", { signerAddress: undefined }],
    ["no contracts", { contracts: [] }],
  ] as const) {
    it(`says it is not configured when there is ${label}`, async () => {
      const r = await readGasSpend({ ...cfg, ...missing, fetchImpl: rpc({}) });
      expect(r.reason).toContain("not configured");
      expect(r.txs).toEqual([]);
    });
  }
});

describe("pacing", () => {
  it("awaits the injected pause between transactions", async () => {
    // 87 transactions is ~174 RPC calls; this endpoint rate-limits and answers
    // 404 rather than 429 when pushed, so the burst has to be pace-able.
    let pauses = 0;
    await readGasSpend({
      ...cfg,
      pause: async () => { pauses += 1; },
      fetchImpl: rpc({ "0x1": { from: SIGNER }, "0x2": { from: SIGNER } }),
    });
    expect(pauses).toBe(2);
  });
});
