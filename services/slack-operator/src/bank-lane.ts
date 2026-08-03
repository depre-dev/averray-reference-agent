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
  type BankFeed,
  type BankRequest,
  type SourcedRead,
} from "./bank-feed.js";
import { decidePositionDisplay, type PositionView } from "./position-display.js";

export type BankTone = "ok" | "degraded" | "red" | "awaiting";

export interface BankLine {
  text: string;
  tone: BankTone;
}

export interface BankLaneView {
  /** Null when the feed is not configured — the lane renders one line instead. */
  position: PositionView | null;
  float: BankLine;
  postage: BankLine;
  requests: BankLine;
  /** Names the request driving a degraded verdict, or null. */
  overdueRequestId: string | null;
  /** The lane's contribution to the ops verdict. */
  tone: BankTone;
}

/** Said once, quietly, when nothing is wired. Never four "awaiting" tiles. */
export const BANK_FEED_ABSENT =
  "bank lane not configured — no read-only observer feed for the wrapper";

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
  return { text: `${formatUnits(value, decimals)} ${unit}`, tone: "ok" };
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
    calibration: feed.calibration ?? null,
    readAtMs: feed.position.readAtMs,
    nowMs,
    staleAfterMs: stale,
  });

  const float = amount(feed.float, 6, "USDC", nowMs, stale);
  const postage = postageLine(feed.postage, nowMs, stale, input.postageFloorDot ?? POSTAGE_FLOOR_DOT);
  const requests = requestLine(feed.requests);
  const overdue = feed.requests.find((r) => r.overdue) ?? null;

  // The lane's verdict. An overdue request or an unusable position read are the
  // two states worth a degraded pillar — the rest is display.
  const tone: BankTone =
    overdue || postage.tone === "red"
      ? "red"
      : position.status === "unverified" || float.tone === "degraded" || postage.tone === "degraded"
        ? "degraded"
        : "ok";

  return { position, float, postage, requests, overdueRequestId: overdue?.id ?? null, tone };
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
function requestLine(requests: readonly BankRequest[]): BankLine {
  const live = requests.filter((r) => r.phase !== "terminal");
  if (live.length === 0) return { text: "no requests in flight", tone: "ok" };
  const overdue = live.filter((r) => r.overdue);
  if (overdue.length > 0) {
    const lead = overdue.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
    return {
      text: `${overdue.length} OVERDUE · ${lead.id} ${lead.phase} for ${formatAge(lead.ageSeconds)}`,
      tone: "red",
    };
  }
  const lead = live.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
  return { text: `${live.length} in flight · oldest ${lead.id} ${lead.phase} ${formatAge(lead.ageSeconds)}`, tone: "ok" };
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}
