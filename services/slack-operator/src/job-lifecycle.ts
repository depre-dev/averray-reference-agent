// How long a job takes, and whose job it was.
//
// The flow funnel counts jobs through claimed → submitted → settled. It has
// never measured TIME, and time is the thing the operator's own analysis says
// decides whether workers come back: a blind agent picked a 0.4 USDC job over a
// 1.0 USDC external bounty, and the reason was not the reward — it was how long
// the bounty would take to pay.
//
// ── WHY LATENCY AND DEMAND MIX ARE ONE MEASUREMENT ─────────────────────────
//
// Because a blended average of the two would be a number about nothing.
// Self-posted pipeline jobs auto-verify and settle in SECONDS. External bounties
// wait on a human and settle in HOURS. Measured on mainnet:
//
//   0x7534e3ed  self-posted     9 blocks   ~19 seconds
//   0xaa4b7b03  external     3,439 blocks  ~2 hours
//   0xa436d6a2  external    33,822 blocks  ~19.8 hours
//
// One median over that population moves with the MIX rather than with either
// population's actual speed — so a day with more dogfood would look like the
// system got faster. Splitting them makes both honest, and the split is itself
// the demand-mix answer: how much of this is real posters and how much is us.
//
// ── WHAT COUNTS AS EXTERNAL ────────────────────────────────────────────────
//
// Whether the settlement paid a protocol fee. Self-posted pipeline work is
// created through `createSinglePayoutJobFeeWaived` and pays nothing; bonded
// external bounties are escrowed at reward × 1.05 and pay 5%. That is a fact
// about the transaction rather than an inference about intent, which is why it
// is the discriminator rather than the job id, the poster address or the amount.
//
// Pure: no RPC, no clock. Block numbers in, seconds out.

export interface LifecycleJob {
  /** First block this job was seen on the escrow contract — its posting. */
  postedBlock: number;
  /** Block its settlement landed. */
  settledBlock: number;
  /** Did the settlement pay a protocol fee? Fee-bearing ⇒ external bounty. */
  feeBearing: boolean;
}

export interface LifecycleClass {
  count: number;
  /** Median seconds from posting to settlement; null when there are none. */
  medianSeconds: number | null;
  /** Slowest, because a median hides the case that made someone give up. */
  slowestSeconds: number | null;
}

export interface LifecycleSummary {
  /** Averray's own pipeline work — auto-verified, fee-waived. */
  selfPosted: LifecycleClass;
  /** Third-party bounties — bonded, human-reviewed, fee-bearing. */
  external: LifecycleClass;
  /** External share of settled jobs, 0–100. null when nothing settled. */
  externalPct: number | null;
  /**
   * Jobs settled in the window whose POSTING fell outside it, so their duration
   * is unknown. Counted and excluded rather than measured from a truncated
   * start — a job that looks 10 minutes old because the window began 10 minutes
   * ago is the kind of wrong number that makes a latency figure worthless.
   */
  unmeasurable: number;
}

function classOf(jobs: readonly LifecycleJob[], blockSeconds: number): LifecycleClass {
  if (jobs.length === 0) return { count: 0, medianSeconds: null, slowestSeconds: null };
  const spans = jobs
    .map((j) => (j.settledBlock - j.postedBlock) * blockSeconds)
    .sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const median = spans.length % 2 === 1 ? spans[mid]! : (spans[mid - 1]! + spans[mid]!) / 2;
  return {
    count: jobs.length,
    medianSeconds: Math.round(median),
    // The slowest is shown alongside the median deliberately: a median of 20
    // seconds with a slowest of 20 hours is a different system from one where
    // both are 20 seconds, and only one of them loses workers.
    slowestSeconds: Math.round(spans[spans.length - 1]!),
  };
}

export function summarizeLifecycle(input: {
  jobs: readonly LifecycleJob[];
  /** Measured seconds per block. Null ⇒ nothing can be timed. */
  blockSeconds: number | null;
  /** Settled jobs whose posting was outside the window. */
  unmeasurable?: number;
}): LifecycleSummary | null {
  // Without a measured block time every duration would be a guess, and this
  // codebase has already shipped one number derived from an assumed 6s/block.
  if (input.blockSeconds == null || !Number.isFinite(input.blockSeconds) || input.blockSeconds <= 0) {
    return null;
  }
  const self = input.jobs.filter((j) => !j.feeBearing);
  const ext = input.jobs.filter((j) => j.feeBearing);
  const total = self.length + ext.length;
  return {
    selfPosted: classOf(self, input.blockSeconds),
    external: classOf(ext, input.blockSeconds),
    externalPct: total === 0 ? null : Math.round((ext.length / total) * 100),
    unmeasurable: input.unmeasurable ?? 0,
  };
}

/** "19s" · "2h 14m" · "19.8h" — durations a human reads without converting. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return `${Math.round(hours / 24)}d`;
}
