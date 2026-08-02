// The I/O half of gas attribution: find the signer's transactions and price
// them. `gas-spend.ts` stays pure; everything that talks to a chain is here.
//
// ── WHY IT IS NOT ON THE HEARTBEAT ─────────────────────────────────────────
//
// A day of traffic is ~87 transactions, and each needs BOTH a receipt (for
// gasUsed and the effective price) and the transaction itself (for the calldata
// selector). That is ~174 RPC calls. At the 5-minute heartbeat it would be the
// single heaviest thing the monitor does, for a figure that moves slowly and is
// read occasionally.
//
// So it runs on its own long cadence and caches. The staleness is disclosed
// rather than hidden — an hour-old gas breakdown is useful; an hour-old gas
// breakdown presented as current is the same lie as any other stale number.
//
// ── NO SILENT CAPS ─────────────────────────────────────────────────────────
//
// If there are more transactions than the cap allows, the extras are dropped
// AND `truncated` is set. A partial total rendered as a complete one understates
// spend, and understating spend on a board whose job is to warn about running
// out is the wrong direction to be wrong in.
//
// ── FAILURE IS NEVER ZERO ──────────────────────────────────────────────────
//
// Any failure returns a reason and no transactions, never an empty list that
// would summarise to "0 DOT spent" — which reads as free rather than unknown.

import type { GasTx } from "./gas-spend.js";

export interface GasReadResult {
  /** Transactions sent BY the signer. Empty with a reason on failure. */
  txs: GasTx[];
  /**
   * Other senders seen touching the same contracts, and how many times.
   *
   * Their gas does NOT come from the signer pool the board meters, so it is
   * excluded from the totals — but a second key appearing is worth knowing,
   * because it means "signer gas" is no longer the whole story of what it costs
   * to run this.
   */
  otherSenders: Array<{ address: string; count: number }>;
  /** True when the transaction cap bit and some spend is NOT counted. */
  truncated: boolean;
  blocksScanned: number;
  /** Set when nothing could be read. Never accompanied by a zero total. */
  reason?: string;
}

/** Enough for a busy day at the observed ~87/day, with headroom. */
export const DEFAULT_MAX_TX = 400;

function unreadable(reason: string): GasReadResult {
  return { txs: [], otherSenders: [], truncated: false, blocksScanned: 0, reason };
}

/**
 * Read and price the signer's transactions against our own contracts.
 *
 * Scoped to logs from OUR contracts rather than every transaction the signer
 * ever sent: there is no `eth_getTransactionsBySender`, and scanning blocks for
 * a sender would mean pulling every block in the window. Our contracts emitting
 * a log is the cheap index into "transactions that did our work" — with the
 * honest caveat that a signer transaction which emitted no log from these
 * addresses is invisible here. Anything that spends meaningfully touches them.
 */
export async function readGasSpend(input: {
  rpcUrl?: string;
  /** Addresses whose logs identify our transactions. */
  contracts: string[];
  /** The gas-paying account the solvency panel meters. */
  signerAddress?: string;
  lookbackBlocks: number;
  maxTx?: number;
  fetchImpl: typeof fetch;
  /** Injected so a slow RPC cannot be hammered; awaited between receipts. */
  pause?: () => Promise<void>;
}): Promise<GasReadResult> {
  if (!input.rpcUrl) return unreadable("gas attribution not configured — no RPC URL");
  if (!input.signerAddress) return unreadable("gas attribution not configured — no signer address");
  const contracts = input.contracts.filter((c) => typeof c === "string" && c.length > 0);
  if (contracts.length === 0) return unreadable("gas attribution not configured — no contract addresses");

  const rpc = async (method: string, params: unknown[]): Promise<any> => {
    const res = await input.fetchImpl(input.rpcUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method} → ${body.error.message ?? "rpc error"}`);
    return body.result;
  };

  const signer = input.signerAddress.toLowerCase();
  const maxTx = input.maxTx ?? DEFAULT_MAX_TX;

  try {
    const head = Number(BigInt(await rpc("eth_blockNumber", [])));
    const fromBlock = Math.max(0, head - input.lookbackBlocks);

    // One sweep per contract: `address` as an array is rejected by this RPC —
    // a lesson from the payout probe, where the array form returned
    // "Invalid params" and looked like a broken endpoint.
    const hashes = new Set<string>();
    for (const address of contracts) {
      const logs = await rpc("eth_getLogs", [
        { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: "latest", address },
      ]);
      if (!Array.isArray(logs)) continue;
      for (const log of logs) {
        const h = (log as { transactionHash?: unknown }).transactionHash;
        if (typeof h === "string") hashes.add(h);
      }
    }

    const all = [...hashes];
    const truncated = all.length > maxTx;
    const examined = truncated ? all.slice(0, maxTx) : all;

    const txs: GasTx[] = [];
    const others = new Map<string, number>();
    for (const hash of examined) {
      const [tx, receipt] = [await rpc("eth_getTransactionByHash", [hash]), await rpc("eth_getTransactionReceipt", [hash])];
      if (input.pause) await input.pause();
      if (!tx || !receipt) continue;
      const from = String((tx as { from?: unknown }).from ?? "").toLowerCase();
      if (from !== signer) {
        others.set(from, (others.get(from) ?? 0) + 1);
        continue;
      }
      const gasUsed = (receipt as { gasUsed?: unknown }).gasUsed;
      const price =
        (receipt as { effectiveGasPrice?: unknown }).effectiveGasPrice ?? (tx as { gasPrice?: unknown }).gasPrice;
      if (typeof gasUsed !== "string" || typeof price !== "string") continue;
      const input4 = String((tx as { input?: unknown }).input ?? "0x");
      txs.push({
        from,
        to: typeof (tx as { to?: unknown }).to === "string" ? ((tx as { to: string }).to).toLowerCase() : null,
        // "0x" for a plain value transfer — a real case, not a parse failure.
        selector: input4.length >= 10 ? input4.slice(0, 10) : "0x",
        gasWei: BigInt(gasUsed) * BigInt(price),
        success: (receipt as { status?: unknown }).status === "0x1",
      });
    }

    return {
      txs,
      otherSenders: [...others.entries()]
        .map(([address, count]) => ({ address, count }))
        .sort((a, b) => b.count - a.count),
      truncated,
      blocksScanned: head - fromBlock,
    };
  } catch (error) {
    // Rate limit, capped range, dead endpoint — all unknown, never "0 DOT".
    return unreadable(`gas attribution unreadable — ${error instanceof Error ? error.message : String(error)}`);
  }
}
