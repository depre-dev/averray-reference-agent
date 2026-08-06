// The Bank lane's view model — what the tiles say, decided once.
//
// Four facts, and each degrades on its own terms:
//
//   REQUESTS  in-flight wrapper requests; an OVERDUE one is the stuck-pending
//             alarm made visible, named by id so the alert is actionable
//   POSITION  the aToken balance, under the zero-is-not-a-reading rule
//   FLOAT     residual asset-22 operating capital — shown or it reads as gone
//   POSTAGE   committed DOT with no withdraw path, against its own floor
//
// The lane is a DoD item of an ACTIVE activation: the wrapper is armed on
// mainnet and requests exist this week. It is not a panel built ahead of its
// data — but until the read-only feed endpoint exists it says so in one line
// rather than rendering four empty tiles.

import {
  PLANCK_PER_DOT,
  POSTAGE_FLOOR_DOT,
  bankSubjectIsCurrent,
  isEvaluatedBankSubject,
  isKnownPhase,
  type BankFeed,
  type BankRequest,
  type BankRequests,
  type SourcedRead,
  awaitsOperator,
} from "./bank-feed.js";
import { decidePositionDisplay, type PositionView } from "./position-display.js";

export type BankTone = "ok" | "degraded" | "red" | "awaiting" | "paused" | "neutral";

export interface BankLine {
  text: string;
  tone: BankTone;
  /** Machine-readable producer state when this is the subject line. */
  status?: string;
  /** Machine-readable producer reason when this is the subject line. */
  reason?: string | null;
}

export interface BankLaneView {
  /** Null when the feed is not configured — the lane renders one line instead. */
  position: PositionView | null;
  float: BankLine;
  postage: BankLine;
  requests: BankLine;
  /** Names the request driving a degraded verdict, or null. */
  overdueRequestId: string | null;
  /**
   * WHAT these readings are about, rendered above them.
   *
   * Hoisted to the top of the lane rather than tucked beside a tile, because it
   * qualifies every number below it. A reader who takes in the float and stops
   * has still read the wrong thing.
   */
  subject: BankLine;
  /** The lane's contribution to the ops verdict. */
  tone: BankTone;
}

/**
 * Said once, quietly, when the feed is reachable and switched off at the source.
 *
 * There is deliberately no matching constant for an ABSENT feed: nothing wired
 * renders nothing at all, not a line about its own absence. (One existed, was
 * never rendered, and its own doc comment claimed otherwise — removed with this
 * change rather than left to mislead the next reader.)
 *
 * Switched-off is different, and gets a sentence, because someone configured
 * PRODUCT_HEALTH_BANK_FEED_URL and is entitled to know why no lane appeared.
 * It names the variable and the side it lives on, because "disabled" alone
 * sends an operator to the wrong repo.
 */
export const BANK_FEED_DISABLED =
  "bank lane switched off at the source — the backend's feed is reachable but " +
  "BANK_LANE_FEED_ENABLED is not set";

/**
 * A raw token amount as a human figure, or the honest reason there isn't one.
 *
 * Never rounds a null into a zero: an unreadable balance and an empty one are
 * different facts about money.
 */
function amount(read: SourcedRead, decimals: number, unit: string, nowMs: number, staleAfterMs: number): BankLine {
  if (read.lastError) return { text: `${unit} unreadable — ${read.lastError}`, tone: "awaiting" };
  if (read.raw === null || read.readAtMs === null) return { text: `${unit} not read yet`, tone: "awaiting" };
  if (nowMs - read.readAtMs > staleAfterMs) {
    const mins = Math.round((nowMs - read.readAtMs) / 60_000);
    // The cached number is withheld, not dimmed. A stale balance shown as
    // current is the same lie as any other stale money figure here.
    return { text: `${unit} read is ${mins}m old — not current`, tone: "degraded" };
  }
  let value: bigint;
  try {
    value = BigInt(read.raw);
  } catch {
    return { text: `${unit} read was not a number`, tone: "awaiting" };
  }
  // Raw beside the decimal. Every fee constant this float is reconciled
  // against was MEASURED in raw units — 602 funding, 20,201 sell, 1,402 home —
  // so raw is the unit the arithmetic actually happens in and the decimal is
  // the courtesy for humans. Showing only the decimal makes the tile readable
  // and useless for the one job it has.
  return { text: `${formatUnits(value, decimals)} ${unit} · ${groupDigits(value)} raw`, tone: "ok" };
}

/**
 * A read source, short enough to sit inside a sentence.
 *
 * The producer emits an exact, machine-shaped identifier —
 * `erc20:0x2ec4884088d84e5c2970a034732e5209b0acfa93.balanceOf(0x98f0033e…)` —
 * which is precisely right for the job it must be exact for: deciding whether
 * a calibration proof still applies after a retarget. It is ~100 characters,
 * and interpolated into "zero from X, and this read path has never observed
 * funds" it buries the sentence.
 *
 * So the FULL string is compared and the SHORT string is displayed. Never the
 * other way round: shortening before comparison would let two different
 * addresses share a proof, which is the retarget hole this rule exists to
 * close.
 */
export function shortSource(source: string): string {
  // Keep the ledger tag and elide the middle of every long hex run, so both
  // ends of every address stay legible and greppable.
  return source.replace(/0x[a-fA-F0-9]{16,}/g, (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`);
}

/** 28463 → "28,463". String grouping, so a large bigint cannot lose precision. */
export function groupDigits(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${digits}` : digits;
}

/**
 * Enough precision that a non-zero amount NEVER renders as zero.
 *
 * A fixed 2 dp turned the live 28,463-raw float into "0.03 USDC", and would
 * have turned a 4,000-raw float into "0.00 USDC" — a real balance displayed as
 * an empty one, on the exact tile that exists because an undisplayed float
 * reads as money that vanished.
 *
 * These balances are small BY NATURE: the float is residual fee headroom and
 * the postage account is deliberately a fraction of a DOT. So precision grows
 * until at least one significant digit survives, bounded by the asset's own
 * decimals. Only a true zero is allowed to print as zero.
 */
export function formatUnits(value: bigint, decimals: number): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  // String arithmetic, not floating point: these are token amounts, and the
  // float's whole job is to reconcile against fee constants measured in single
  // raw units — 28,463 raw rendered as "0.03" cannot be reconciled against a
  // 20,201-raw sell leg. Rounding here loses the reason the tile exists.
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Fifteen minutes: past that a balance describes a different moment. */
export const BANK_STALE_AFTER_MS = 15 * 60 * 1000;

export function bankLaneView(input: {
  feed: BankFeed | undefined;
  nowMs: number;
  staleAfterMs?: number;
  postageFloorDot?: number;
}): BankLaneView | null {
  if (!input.feed) return null;
  const { feed, nowMs } = input;
  const stale = input.staleAfterMs ?? BANK_STALE_AFTER_MS;

  const position = decidePositionDisplay({
    raw: feed.position.raw,
    ...(feed.position.lastError ? { readError: feed.position.lastError } : {}),
    source: feed.position.source,
    shorten: shortSource,
    calibration: feed.calibration ?? null,
    readAtMs: feed.position.readAtMs,
    nowMs,
    staleAfterMs: stale,
  });

  const subject = subjectLine(feed);
  const staleSubject = subject.tone === "red";

  // On a stale subject every value below is a real reading of the wrong
  // address, so none of them may render `ok`. Their numbers are kept — the
  // retired account's dust is a real balance somebody has to reconcile — but a
  // green tile would say "the bank is fine" about an account the bank left.
  const demote = (line: BankLine): BankLine =>
    staleSubject && line.tone === "ok" ? { ...line, tone: "degraded" } : line;

  const float = demote(amount(feed.float, 6, "USDC", nowMs, stale));
  const postage = demote(postageLine(feed.postage, nowMs, stale, input.postageFloorDot ?? POSTAGE_FLOOR_DOT));
  const requests = demote(requestLine(feed.requests, nowMs, stale));
  const overdue = feed.requests.items.find((r) => r.overdue) ?? null;

  // The lane's verdict. An overdue request or an unusable position read are the
  // two states worth a degraded pillar — the rest is display.
  //
  // A stale subject is RED, above both. An overdue request costs money while
  // you watch it; a stale subject means you are not watching at all, and the
  // empty request table proves the point — it read "no requests in flight" as
  // an all-clear while a real one sat staged on the live wrapper.
  // An UNDECLARED subject deliberately does NOT move this. It is stated on the
  // lane and left there: until the producer ships the field it is true of every
  // healthy lane, so degrading on it would light the strip permanently amber
  // for "the other service has not been upgraded yet" — the panel nobody reads,
  // which is the failure this board keeps deleting. Position-unverified earns
  // its degrade because it is temporary and resolves on the next dust cycle;
  // a missing producer capability does not.
  const tone: BankTone =
    staleSubject || overdue || postage.tone === "red"
      ? "red"
      : position.status === "unverified" ||
          float.tone === "degraded" ||
          postage.tone === "degraded" ||
          requests.tone === "degraded"
        ? "degraded"
        : subject.tone === "paused" || subject.tone === "neutral"
          ? subject.tone
          : "ok";

  return { position, float, postage, requests, subject, overdueRequestId: overdue?.id ?? null, tone };
}

/**
 * What generation these readings describe.
 *
 * Silence is NOT agreement. A producer that does not declare its subject gets
 * an explicit "cannot confirm" rather than a blank, because the morning this
 * check exists for looked exactly like a lane with nothing to say — every tile
 * fresh, sourced and green, about a wrapper that had been retired hours
 * earlier. Same rule as the payout cross-check's `not-configured`: an
 * instrument that cannot see says so.
 */
function subjectLine(feed: BankFeed): BankLine {
  const subject = feed.subject ?? null;
  if (!subject) {
    return {
      text: "subject not declared by the feed — cannot confirm which wrapper generation these read",
      tone: "awaiting",
    };
  }
  if (isEvaluatedBankSubject(subject)) {
    return evaluatedSubjectLine(subject);
  }
  if (!bankSubjectIsCurrent(subject)) {
    // Both addresses in full. Shortened, two generations of the same deploy
    // script can share a prefix and a suffix, and the one line whose entire job
    // is telling them apart would be the line that hid the difference.
    return {
      text:
        `STALE SUBJECT — these read ${subject.derivedFrom}, ` +
        `the manifest declares ${subject.declared}${subject.label ? ` (${subject.label})` : ""}. ` +
        "Every value below is a real reading of the retired generation.",
      tone: "red",
    };
  }
  return {
    text: `subject ${subject.label ?? shortSource(subject.declared)} — matches the deployment manifest`,
    tone: "ok",
  };
}

function evaluatedSubjectLine(subject: Extract<BankFeed["subject"], { status: string }>): BankLine {
  const generation = configuredGeneration(subject);
  const context = `configured generation ${generation}`;
  if (subject.status === "paused") {
    return {
      text: `lane administratively paused (${context}) — reason: ${subject.reason ?? "not supplied"}`,
      tone: "paused",
      status: subject.status,
      reason: subject.reason,
    };
  }
  if (subject.status === "error") {
    return {
      text: `lane error (${context}) — ${subjectDetail(subject)}`,
      tone: "red",
      status: subject.status,
      reason: subject.reason,
    };
  }
  if (subject.status === "ok" && subject.matches === true) {
    return {
      text: `lane active (${context}) — unique armed wrapper ${subject.uniqueArmedWrapper ?? "not reported"}`,
      tone: "ok",
      status: subject.status,
      reason: subject.reason,
    };
  }

  // Status vocabulary belongs to the producer and can grow independently.
  // Show a stranger exactly as received. Neutral is neither an endorsement nor
  // a failure, and most importantly it is never made invisible.
  return {
    text: `lane status ${subject.status} (${context}) — ${subjectDetail(subject)}`,
    tone: "neutral",
    status: subject.status,
    reason: subject.reason,
  };
}

function configuredGeneration(subject: Extract<BankFeed["subject"], { status: string }>): string {
  const candidate = subject.candidates.find(
    (entry) => entry.wrapper.trim().toLowerCase() === subject.configuredWrapper.trim().toLowerCase(),
  );
  if (!candidate) return shortSource(subject.configuredWrapper);
  return candidate.version.startsWith("v") ? candidate.version : `v${candidate.version}`;
}

function subjectDetail(subject: Extract<BankFeed["subject"], { status: string }>): string {
  const details = [
    subject.reason ? `reason: ${subject.reason}` : null,
    subject.lastError && subject.lastError !== subject.reason ? `last error: ${subject.lastError}` : null,
  ].filter(Boolean);
  return details.length > 0 ? details.join(" · ") : "reason: not supplied";
}

/**
 * Postage against its floor.
 *
 * This DOT can only ever be spent as XCM delivery fees and has no withdraw
 * path, so it is not treasury and must not be read as spendable. Below the
 * floor it cannot pay for an epoch at all, which stops the lane rather than
 * degrading it.
 */
function postageLine(read: SourcedRead, nowMs: number, staleAfterMs: number, floorDot: number): BankLine {
  const base = amount(read, 10, "DOT", nowMs, staleAfterMs);
  if (base.tone !== "ok" || read.raw === null) return base;
  const dot = Number(BigInt(read.raw)) / PLANCK_PER_DOT;
  if (dot < floorDot) {
    return { text: `${base.text} — BELOW POSTAGE FLOOR ${floorDot} · the wrapper cannot pay delivery`, tone: "red" };
  }
  return { text: `${base.text} · committed postage, no withdraw path`, tone: "ok" };
}

/**
 * Requests in flight, and the one that is late.
 *
 * `overdue` is the observer's own judgement against its own deadline. Hermes
 * does not recompute it: a board that re-derives a deadline will eventually
 * disagree with the service that owns it, and then there are two answers to a
 * question that must have one.
 */
function requestLine(requests: BankRequests, nowMs: number, staleAfterMs: number): BankLine {
  // An unreadable table must NEVER render as "no requests in flight". This is
  // the tile whose entire job is the stuck-pending alarm, so "all clear" from
  // an absent read is the worst version of absence-is-not-zero on this lane.
  if (requests.lastError) {
    return { text: `request table unreadable — ${requests.lastError}`, tone: "degraded" };
  }
  if (requests.readAtMs === null) {
    return { text: "request table not read yet — in-flight state unknown", tone: "awaiting" };
  }
  if (nowMs - requests.readAtMs > staleAfterMs) {
    const mins = Math.round((nowMs - requests.readAtMs) / 60_000);
    return { text: `request table is ${mins}m old — in-flight state not current`, tone: "degraded" };
  }

  // An unrecognized phase is NOT dropped and NOT treated as terminal. The
  // observer owns this vocabulary and may extend it; a request in a phase this
  // board has never heard of is the most unusual one in the table, which makes
  // hiding it exactly backwards.
  const unknown = requests.items.filter((r) => !isKnownPhase(r.phase));
  const live = requests.items.filter((r) => r.phase !== "terminal");
  if (live.length === 0) {
    const terminal = requests.items.find((request) => request.phase === "terminal" && request.reconciliation);
    if (terminal?.reconciliation) {
      const r = terminal.reconciliation;
      const final = r.actualTreasuryReturnRaw !== undefined &&
        r.recoveryReturnFeeRaw !== undefined &&
        r.finalRawRecoverySlotResidueRaw !== undefined;
      return {
        text: final
          ? `TERMINAL ${String(terminal.status ?? "recorded").toUpperCase()} · ${terminal.id} · ` +
            `${r.stagedRaw} staged = ${r.actualTreasuryReturnRaw} treasury + ` +
            `${r.leg1TransferFeeRaw} leg-1 fee + ${r.trappedWriteOff3Raw} trapped write-off #3 + ` +
            `${r.recoveryReturnFeeRaw} recovery fee · ${r.unexplainedRaw} unexplained · ` +
            `${r.finalRawRecoverySlotResidueRaw} residue — ${r.artifactLabel}`
          : `TERMINAL ${String(terminal.status ?? "recorded").toUpperCase()} · ${terminal.id} · ` +
            `${r.stagedRaw} staged − ${r.leg1TransferFeeRaw} leg-1 fee − ` +
            `${r.trappedWriteOff3Raw} trapped write-off #3 = ${r.remoteRecoverableRaw} recoverable · ` +
            `${r.unexplainedRaw} unexplained · ${r.artifactLabel}`,
        tone: "degraded",
      };
    }
    return { text: "no requests in flight", tone: "ok" };
  }
  const overdue = live.filter((r) => r.overdue);
  if (overdue.length > 0) {
    const lead = overdue.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
    return {
      text: `${overdue.length} OVERDUE · ${lead.id} ${lead.phase} ${describeAge(lead)}${describeDeadline(lead, nowMs)}`,
      tone: "red",
    };
  }
  const lead = live.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
  const base =
    `${live.length} in flight · oldest ${lead.id} ${lead.phase} ${describeAge(lead)}` +
    `${describeDeadline(lead, nowMs)}${awaitsOperator(lead.phase) ? " · awaiting operator dispatch" : ""}`;
  if (unknown.length > 0) {
    // Verbatim, so the value is searchable against the observer's own source.
    const u = unknown[0]!;
    return { text: `${base} · UNRECOGNISED PHASE "${u.phase}" on ${u.id}`, tone: "degraded" };
  }
  return { text: base, tone: "ok" };
}

/**
 * How long it has been in flight — or that we cannot say.
 *
 * The producer sends `ageSeconds: 0` when a request's `startedAt` is
 * unparseable, because the field is a number and zero is the only available
 * placeholder. Rendered literally that becomes "OVERDUE · req-x for 0s", which
 * states an age nobody measured — absence-as-zero, in miniature, on an alarm.
 *
 * It always arrives paired with `phase: "timing-unknown"`, so the honest
 * rendering is available: say the age is unknown rather than say it is none.
 */
function describeAge(request: BankRequest): string {
  return request.phase === "timing-unknown" ? "· age unknown" : `for ${formatAge(request.ageSeconds)}`;
}

/**
 * The request's own clock, when the feed sends it — and NOTHING when it does
 * not.
 *
 * Age is the wrong clock, proven live: on 2026-08-05 a staged request read
 * "in flight 11.2h", calm, while 19 minutes remained to its on-chain dispatch
 * deadline. It lapsed. The deadline was always the operative number, computed
 * by the feed and never emitted; this renders it the moment the producer
 * ships the field. No monitor-side threshold, no tone change — `overdue` stays
 * the producer's own judgement (the rule at the top of requestLine), and this
 * only SHOWS the clock that judgement runs on.
 */
function describeDeadline(request: BankRequest, nowMs: number): string {
  const at = request.deadlineAtMs;
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const remaining = at - nowMs;
  if (remaining >= 0) return ` · deadline in ${formatAge(Math.round(remaining / 1000))}`;
  return ` · deadline lapsed ${formatAge(Math.round(-remaining / 1000))} ago`;
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}
