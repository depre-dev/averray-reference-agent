// Reading job durations off the chain.
//
// Cheap on purpose: two log sweeps, no receipts. Gas attribution needs a receipt
// per transaction (~174 calls) and therefore its own slow cadence; this needs
// only the escrow's logs and the settlement events, so it runs on the heartbeat
// like every other probe.
//
// ── THE JOIN IS THE TRANSACTION, NOT THE ID ────────────────────────────────
//
// `ReservationSettled.topic1` looks like a job id and is not — it is a
// RESERVATION id, and one settlement emits a payout leg and a fee leg with
// different values. Joining jobs to settlements on it silently matches nothing,
// which cost a full investigation round before it was noticed.
//
// So the bridge is the transaction hash: the escrow's own logs carry the job id
// and appear in the settlement transaction, and the settlement events carry the
// recipient. Both sides are then talking about the same transaction.

import type { LifecycleJob } from "./job-lifecycle.js";

export interface LifecycleReadResult {
  jobs: LifecycleJob[];
  /** Settled in the window but posted before it — counted, never timed. */
  unmeasurable: number;
  reason?: string;
}

const RESERVATION_SETTLED_TOPIC =
  "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee";

function unreadable(reason: string): LifecycleReadResult {
  return { jobs: [], unmeasurable: 0, reason };
}

export async function readJobLifecycle(input: {
  rpcUrl?: string;
  escrowCore?: string;
  agentAccountCore?: string;
  /** The protocol-fee treasury — a settlement to it marks the job external. */
  feeRecipient?: string;
  lookbackBlocks: number;
  fetchImpl: typeof fetch;
}): Promise<LifecycleReadResult> {
  if (!input.rpcUrl || !input.escrowCore || !input.agentAccountCore) {
    return unreadable("job lifecycle not configured — missing RPC or contract addresses");
  }
  // Without the fee recipient every job would be classed self-posted, which
  // would report an external share of 0% — a confident wrong answer about the
  // question this exists to answer. Better to report nothing.
  if (!input.feeRecipient) {
    return unreadable("job lifecycle unavailable — fee recipient unreadable, cannot tell external from self-posted");
  }

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

  try {
    const head = Number(BigInt(await rpc("eth_blockNumber", [])));
    const from = Math.max(0, head - input.lookbackBlocks);
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: "latest" };

    // `address` one at a time: the array form is rejected by this RPC with
    // "Invalid params" and reads as a dead endpoint.
    const escrowLogs = await rpc("eth_getLogs", [{ ...range, address: input.escrowCore }]);
    const settleLogs = await rpc("eth_getLogs", [
      { ...range, address: input.agentAccountCore, topics: [RESERVATION_SETTLED_TOPIC] },
    ]);
    if (!Array.isArray(escrowLogs) || !Array.isArray(settleLogs)) {
      return unreadable("job lifecycle unverified — eth_getLogs returned no array");
    }

    // jobId → first block seen, and the transactions it appears in.
    const firstSeen = new Map<string, number>();
    const txOfJob = new Map<string, Set<string>>();
    for (const log of escrowLogs as Array<Record<string, any>>) {
      const jobId = log.topics?.[1];
      if (typeof jobId !== "string") continue;
      const block = Number(BigInt(log.blockNumber));
      const prev = firstSeen.get(jobId);
      if (prev === undefined || block < prev) firstSeen.set(jobId, block);
      if (!txOfJob.has(jobId)) txOfJob.set(jobId, new Set());
      txOfJob.get(jobId)!.add(String(log.transactionHash));
    }

    // Settlement transactions: which block, and did any leg pay the treasury.
    const feeTopic = `0x${input.feeRecipient.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const settlements = new Map<string, { block: number; feeBearing: boolean }>();
    for (const log of settleLogs as Array<Record<string, any>>) {
      const tx = String(log.transactionHash);
      const entry = settlements.get(tx) ?? { block: Number(BigInt(log.blockNumber)), feeBearing: false };
      if (String(log.topics?.[3] ?? "").toLowerCase() === feeTopic) entry.feeBearing = true;
      settlements.set(tx, entry);
    }

    const jobs: LifecycleJob[] = [];
    let unmeasurable = 0;
    const claimed = new Set<string>();
    for (const [jobId, txs] of txOfJob) {
      const settlement = [...txs].map((t) => settlements.get(t)).find((s) => s !== undefined);
      if (!settlement) continue; // still in flight — not a duration yet
      claimed.add([...txs].find((t) => settlements.has(t))!);
      const posted = firstSeen.get(jobId)!;
      // Posted at the very edge of the window is indistinguishable from posted
      // before it, and a truncated start produces a flatteringly short duration.
      if (posted <= from) { unmeasurable += 1; continue; }
      jobs.push({ postedBlock: posted, settledBlock: settlement.block, feeBearing: settlement.feeBearing });
    }
    // Settlements whose job never appeared in the escrow sweep at all.
    for (const tx of settlements.keys()) if (!claimed.has(tx)) unmeasurable += 1;

    return { jobs, unmeasurable };
  } catch (error) {
    return unreadable(`job lifecycle unreadable — ${error instanceof Error ? error.message : String(error)}`);
  }
}
