// external_funnel — the 8th probe. Watches the external poster door's lifecycle
// so no TIME-FUSED obligation depends on a human refreshing a page.
//
// The dangerous state is a rejected job whose dispute window is running. If it
// lapses unopened, `finalizeRejectedJob` slashes the worker's bond. Nothing else
// on the board counts down toward somebody losing money by default.
//
// ── WHAT THIS PROBE CAN AND CANNOT SEE (read before trusting a green) ───────
//
// Buckets come from the public catalog projection, which is verified live.
// The dispute-window LENGTH comes from /poster/onboarding.workerFacts, never a
// hardcoded 604800 — the window is a live on-chain read and a constant here
// would silently diverge the day it changes.
//
// The rejected DEADLINE needs `rejectedAt` from EscrowCore, and this probe does
// not have it. Investigated against mainnet rather than assumed:
//
//   · `jobs(bytes32)` is selector 0x38ed7cfc and DOES answer on EscrowCore
//     0x590EbE30…C3fC — it returns 25 words, and word[23]=500 (protocolFeeBps,
//     the live 5% fee) confirms the struct is the right one.
//   · In a completed job, words[17] and [18] hold timestamps 808s and 3040s
//     after the catalog's claimedAt. Both are plausible submit/resolve stamps.
//     Every other timestamp slot is zero.
//   · No external job has EVER been rejected, so there is nothing to calibrate
//     which word is `rejectedAt` against.
//
// Guessing the word would produce a confident countdown to the wrong instant on
// the one number where being wrong costs a worker their bond. So the deadline
// read is CONFIGURABLE and unset by default, and this probe reports rejected
// rows it cannot time as DEGRADED with an explicit reason — never as green, and
// never with an invented deadline. See PRODUCT_HEALTH_ESCROW_REJECTED_AT_WORD.
//
// To close it: one rejected job to calibrate against, or the EscrowCore ABI.

import type { ProbeResult, ProbeStatus } from "./product-health.js";

/** A row of the public catalog projection (`GET /jobs?source=external`). */
export interface ExternalJobRow {
  id?: unknown;
  state?: unknown;
  claimState?: unknown;
  effectiveState?: unknown;
  claimedAt?: unknown;
  claimExpiresAt?: unknown;
  poster?: unknown;
  claimBond?: unknown;
}

export type FunnelBucket =
  | "open_claimable"
  | "claimed_active"
  | "submitted_awaiting_review"
  | "rejected_window_running"
  | "other";

export interface BucketSummary {
  count: number;
  /** Soonest deadline in the bucket (epoch ms), when the bucket has one. */
  oldestDeadlineMs?: number;
  /** Job id driving `oldestDeadlineMs` — named in the verdict so it is actionable. */
  leadJobId?: string;
}

export interface ExternalFunnelResult {
  probe: ProbeResult;
  buckets: Record<FunnelBucket, BucketSummary>;
  /** The dispute window actually in force, as read. Null when unreadable. */
  disputeWindowSeconds: number | null;
}

// ── Thresholds. Every constant carries its source. ─────────────────────────

/** A claim expiring inside 2h is about to return the job to the pool and burn
 *  one of the worker's limited claim attempts. Two hours is the shortest span in
 *  which a human can realistically notice and act. */
export const CLAIM_EXPIRY_WARN_MS = 2 * 60 * 60 * 1000;

/** A submission nobody has reviewed for 48h is a stalled promise: the worker has
 *  done the work and is waiting on a human. Matches the poster-facing
 *  expectation in the onboarding guide's review section. */
export const REVIEW_STALE_WARN_MS = 48 * 60 * 60 * 1000;

/** Dispute deadline inside 48h → degraded. A worker who has not opened a dispute
 *  by then needs a nudge while there is still working time left. */
export const DISPUTE_WARN_MS = 48 * 60 * 60 * 1000;

/** Dispute deadline inside 12h → the probe's halt-severity condition. Past this
 *  the bond is lost to inaction, which is the whole reason this probe exists.
 *  Severity follows chainHaltStatus: red on mainnet, degraded on a testnet. */
export const DISPUTE_HALT_MS = 12 * 60 * 60 * 1000;

const EMPTY: BucketSummary = { count: 0 };

function emptyBuckets(): Record<FunnelBucket, BucketSummary> {
  return {
    open_claimable: { ...EMPTY },
    claimed_active: { ...EMPTY },
    submitted_awaiting_review: { ...EMPTY },
    rejected_window_running: { ...EMPTY },
    other: { ...EMPTY },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  const s = str(value);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Short, recognisable job id for a verdict line: `0xaa4b…`. */
export function shortJobId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…` : id;
}

/**
 * Which bucket a row belongs to.
 *
 * `state` is the authority; `effectiveState`/`claimState` refine it. Anything
 * unrecognised lands in `other` rather than being forced into a known bucket —
 * the live catalog already returns `exhausted`, which is none of the four the
 * spec names, and quietly folding unknown states into a counted bucket would
 * misreport the funnel the first time a new state ships.
 */
export function bucketFor(row: ExternalJobRow): FunnelBucket {
  const state = (str(row.state) ?? "").toLowerCase();
  const effective = (str(row.effectiveState) ?? "").toLowerCase();
  if (state === "rejected") return "rejected_window_running";
  if (state === "submitted") return "submitted_awaiting_review";
  if (state === "claimed" || effective === "claimed") return "claimed_active";
  if (state === "open" || effective === "claimable") return "open_claimable";
  return "other";
}

function humanise(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.round(abs / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(abs / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface DecideExternalFunnelInput {
  /** Catalog rows. `null` means the fetch FAILED — never an empty funnel. */
  rows: readonly ExternalJobRow[] | null;
  /** From /poster/onboarding.workerFacts.disputeWindow.seconds. Null if unread. */
  disputeWindowSeconds: number | null;
  /** rejectedAt per job id (epoch ms), for rows we could time. Absent = unreadable. */
  rejectedAtMs?: ReadonlyMap<string, number>;
  nowMs: number;
  /** chainHaltStatus(chainId, override) — red on mainnet, degraded on testnet. */
  haltStatus: ProbeStatus;
  /** Why the catalog read failed, when it did. */
  fetchError?: string;
}

/**
 * Pure verdict. The caller does the I/O; this decides.
 */
export function decideExternalFunnel(input: DecideExternalFunnelInput): ExternalFunnelResult {
  const name = "external_funnel";

  // FETCH FAILURE IS NOT AN EMPTY FUNNEL. #477 taught this the expensive way:
  // silent rate-limit 403s made the monitor draw confident conclusions from
  // absent data. Unknown must never render as ok.
  if (input.rows === null) {
    return {
      probe: {
        name,
        status: "degraded",
        detail: `catalog unreadable — ${input.fetchError ?? "fetch failed"} · funnel state unknown, not empty`,
      },
      buckets: emptyBuckets(),
      disputeWindowSeconds: input.disputeWindowSeconds,
    };
  }

  const buckets = emptyBuckets();
  for (const row of input.rows) {
    const bucket = bucketFor(row);
    const summary = buckets[bucket];
    summary.count += 1;
    const id = str(row.id);

    if (bucket === "claimed_active") {
      const expires = epochMs(row.claimExpiresAt);
      if (expires !== undefined && (summary.oldestDeadlineMs === undefined || expires < summary.oldestDeadlineMs)) {
        summary.oldestDeadlineMs = expires;
        if (id) summary.leadJobId = id;
      }
    }
    if (bucket === "submitted_awaiting_review") {
      // "Oldest" here is the earliest claim time — how long the worker has been
      // waiting — so the deadline field carries an age anchor, not a deadline.
      const since = epochMs(row.claimedAt);
      if (since !== undefined && (summary.oldestDeadlineMs === undefined || since < summary.oldestDeadlineMs)) {
        summary.oldestDeadlineMs = since;
        if (id) summary.leadJobId = id;
      }
    }
    if (bucket === "rejected_window_running") {
      const rejectedAt = id ? input.rejectedAtMs?.get(id) : undefined;
      if (rejectedAt !== undefined && input.disputeWindowSeconds !== null) {
        const deadline = rejectedAt + input.disputeWindowSeconds * 1000;
        if (summary.oldestDeadlineMs === undefined || deadline < summary.oldestDeadlineMs) {
          summary.oldestDeadlineMs = deadline;
          if (id) summary.leadJobId = id;
        }
      }
    }
  }

  const detailParts = [
    `${buckets.open_claimable.count} claimable`,
    `${buckets.claimed_active.count} claimed`,
    `${buckets.submitted_awaiting_review.count} awaiting review`,
    `${buckets.rejected_window_running.count} in dispute window`,
  ];
  if (buckets.other.count > 0) detailParts.push(`${buckets.other.count} other`);

  // ── Severity, most dangerous first. ──────────────────────────────────────

  const rejected = buckets.rejected_window_running;
  if (rejected.count > 0) {
    if (rejected.oldestDeadlineMs === undefined) {
      // Rejected rows exist but we cannot time them. NOT green: a bond may be
      // counting down and we would be reporting silence as safety.
      return {
        probe: {
          name,
          status: "degraded",
          detail:
            `${rejected.count} rejected in the dispute window, deadline UNREADABLE`
            + ` — set PRODUCT_HEALTH_ESCROW_REJECTED_AT_WORD once the field is calibrated · ${detailParts.join(" · ")}`,
        },
        buckets,
        disputeWindowSeconds: input.disputeWindowSeconds,
      };
    }
    const remaining = rejected.oldestDeadlineMs - input.nowMs;
    const who = rejected.leadJobId ? `${shortJobId(rejected.leadJobId)} ` : "";
    if (remaining <= DISPUTE_HALT_MS) {
      return {
        probe: {
          name,
          status: input.haltStatus,
          detail:
            remaining <= 0
              ? `rejected ${who}dispute window LAPSED ${humanise(remaining)} ago — bond slashable now · ${detailParts.join(" · ")}`
              : `rejected ${who}slashes in ${humanise(remaining)} · ${detailParts.join(" · ")}`,
        },
        buckets,
        disputeWindowSeconds: input.disputeWindowSeconds,
      };
    }
    if (remaining <= DISPUTE_WARN_MS) {
      return {
        probe: {
          name,
          status: "degraded",
          detail: `rejected ${who}slashes in ${humanise(remaining)} · ${detailParts.join(" · ")}`,
        },
        buckets,
        disputeWindowSeconds: input.disputeWindowSeconds,
      };
    }
  }

  const review = buckets.submitted_awaiting_review;
  if (review.count > 0 && review.oldestDeadlineMs !== undefined) {
    const age = input.nowMs - review.oldestDeadlineMs;
    if (age >= REVIEW_STALE_WARN_MS) {
      const who = review.leadJobId ? `${shortJobId(review.leadJobId)} ` : "";
      return {
        probe: {
          name,
          status: "degraded",
          detail: `submission ${who}unreviewed for ${humanise(age)} · ${detailParts.join(" · ")}`,
        },
        buckets,
        disputeWindowSeconds: input.disputeWindowSeconds,
      };
    }
  }

  const claimed = buckets.claimed_active;
  if (claimed.count > 0 && claimed.oldestDeadlineMs !== undefined) {
    const remaining = claimed.oldestDeadlineMs - input.nowMs;
    if (remaining <= CLAIM_EXPIRY_WARN_MS) {
      const who = claimed.leadJobId ? `${shortJobId(claimed.leadJobId)} ` : "";
      return {
        probe: {
          name,
          status: "degraded",
          detail:
            remaining <= 0
              ? `claim ${who}EXPIRED ${humanise(remaining)} ago · ${detailParts.join(" · ")}`
              : `claim ${who}expires in ${humanise(remaining)} · ${detailParts.join(" · ")}`,
        },
        buckets,
        disputeWindowSeconds: input.disputeWindowSeconds,
      };
    }
  }

  // An empty funnel is an honest green. Zero claimable jobs is a real state of
  // the world, not a missing reading — the difference the fetch-failure branch
  // above exists to preserve.
  return {
    probe: { name, status: "ok", detail: detailParts.join(" · ") },
    buckets,
    disputeWindowSeconds: input.disputeWindowSeconds,
  };
}

/**
 * Read `workerFacts.disputeWindow.seconds` from a /poster/onboarding body.
 *
 * Returns null when absent or when the endpoint says the live read failed
 * (`available: false`) — a stale constant would be worse than no number, since
 * the deadline computed from it would look authoritative.
 */
export function disputeWindowFrom(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const facts = (body as { workerFacts?: { disputeWindow?: unknown } }).workerFacts;
  const win = facts?.disputeWindow;
  if (typeof win !== "object" || win === null) return null;
  const w = win as { seconds?: unknown; available?: unknown };
  if (w.available === false) return null;
  return typeof w.seconds === "number" && Number.isFinite(w.seconds) && w.seconds > 0 ? w.seconds : null;
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** `jobs(bytes32)` on EscrowCore. keccak256 of the signature, first 4 bytes —
 *  verified live against mainnet 0x590EbE30…C3fC, which answered with a 25-word
 *  struct whose word[23] is the live protocolFeeBps (500). */
export const ESCROW_JOBS_SELECTOR = "0x38ed7cfc";

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ body: unknown; error?: string }> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { body: null, error: `HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (error) {
    return { body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read `rejectedAt` for one job.
 *
 * `word` is the 0-based index into the returned struct. It is deliberately
 * REQUIRED and has no default: the field could not be identified from live data
 * (no external job has ever been rejected), and a guessed index would produce a
 * confident countdown to the wrong instant. See the header.
 */
export async function readRejectedAt(input: {
  rpcUrl: string;
  escrowCore: string;
  jobId: string;
  word: number;
  fetchImpl: typeof fetch;
}): Promise<number | undefined> {
  const id = input.jobId.replace(/^0x/, "").padStart(64, "0");
  const res = await input.fetchImpl(input.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: input.escrowCore, data: `${ESCROW_JOBS_SELECTOR}${id}` }, "latest"],
    }),
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { result?: unknown };
  if (typeof json.result !== "string") return undefined;
  const hex = json.result.slice(2);
  const raw = hex.slice(input.word * 64, (input.word + 1) * 64);
  if (raw.length !== 64) return undefined;
  const seconds = Number(BigInt(`0x${raw}`));
  // Zero means "never rejected"; a nonsensical value means we read the wrong
  // word and must not be treated as a deadline.
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

/**
 * Collect the probe. Degraded-safe throughout: any read that fails leaves the
 * affected part UNKNOWN rather than optimistic.
 */
export async function probeExternalFunnel(input: {
  apiBaseUrl?: string;
  rpcUrl?: string;
  escrowCore?: string;
  /** PRODUCT_HEALTH_ESCROW_REJECTED_AT_WORD. Unset = deadlines unreadable. */
  rejectedAtWord?: number;
  catalogLimit?: number;
  nowMs: number;
  haltStatus: ProbeStatus;
  fetchImpl: typeof fetch;
}): Promise<ExternalFunnelResult> {
  if (!input.apiBaseUrl) {
    return decideExternalFunnel({
      rows: null,
      disputeWindowSeconds: null,
      nowMs: input.nowMs,
      haltStatus: input.haltStatus,
      fetchError: "AVERRAY_API_BASE_URL is not set",
    });
  }
  const limit = input.catalogLimit ?? 100;
  const [catalog, onboarding] = await Promise.all([
    getJson(`${input.apiBaseUrl}/jobs?source=external&limit=${limit}`, input.fetchImpl),
    getJson(`${input.apiBaseUrl}/poster/onboarding`, input.fetchImpl),
  ]);

  const jobs = (catalog.body as { jobs?: unknown } | null)?.jobs;
  const rows = Array.isArray(jobs) ? (jobs as ExternalJobRow[]) : null;
  const disputeWindowSeconds = disputeWindowFrom(onboarding.body);

  // Chain reads only for rejected rows, and only when the field is calibrated.
  const rejectedAtMs = new Map<string, number>();
  if (rows && input.rpcUrl && input.escrowCore && input.rejectedAtWord !== undefined) {
    for (const row of rows) {
      if (bucketFor(row) !== "rejected_window_running") continue;
      const jobId = typeof row.id === "string" ? row.id : undefined;
      if (!jobId) continue;
      try {
        const at = await readRejectedAt({
          rpcUrl: input.rpcUrl,
          escrowCore: input.escrowCore,
          jobId,
          word: input.rejectedAtWord,
          fetchImpl: input.fetchImpl,
        });
        if (at !== undefined) rejectedAtMs.set(jobId, at);
      } catch {
        // Leave it unread — decideExternalFunnel reports that honestly rather
        // than letting one RPC hiccup hide a running slash countdown.
      }
    }
  }

  return decideExternalFunnel({
    rows,
    disputeWindowSeconds,
    rejectedAtMs,
    nowMs: input.nowMs,
    haltStatus: input.haltStatus,
    ...(catalog.error ? { fetchError: catalog.error } : {}),
  });
}
