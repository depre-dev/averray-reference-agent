// Hermes Handoff Monitor — mission-failure text cleaning + summarization.
//
// A failed browser-mission's raw runner/Playwright output is multi-line and
// full of ANSI escapes, box-drawing characters, and pipe separators, e.g.:
//
//   "Executable doesn't exist at /home/appuser/.cache/ms-playwright/... |
//    Video rendering requires ffmpeg binary | ... npx playwright install
//    ffmpeg | | |"
//
// That is unreadable on a card or in rail narration. These pure helpers
// produce a clean one-liner for those surfaces while the RAW text stays
// reachable, structured, one click deep in the drawer (truth-boundary:
// we never hide the real failure, we just stop shouting it).

// ANSI / VT100 escape sequence: ESC [ ... final byte.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// C0 control chars (\x00-\x1f) + DEL (\x7f) -> space.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;
// Box-drawing (U+2500-U+257F) + block elements (U+2580-U+259F) -> space.
const BOX_DRAWING = /[\u2500-\u259f]/g;

/**
 * Strip ANSI escape sequences, control chars, box-drawing / block
 * characters, and pipe separators from runner output; collapse all
 * whitespace (including newlines) to single spaces; trim. Pure
 * formatting -- no meaning change.
 */
export function cleanFailureText(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(ANSI, "")
    .replace(CONTROL, " ")
    .replace(BOX_DRAWING, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MissionFailureSummary {
  /** Clean, human-readable reason. Never multi-line, never raw stderr. */
  reason: string;
  /** True when we matched a known failure to a friendly phrase. */
  friendly: boolean;
}

/**
 * Known failure signatures → friendly reasons. Matched against the
 * CLEANED text (case-insensitive). Ordered: first match wins, so the more
 * specific patterns come first.
 */
const KNOWN_FAILURES: { test: RegExp; reason: string }[] = [
  // Playwright browser binary missing.
  {
    test: /executable doesn'?t exist|playwright install(?!\s+ffmpeg)|browser(?:Type)?\.launch|chromium.*not.*found|install the browsers/i,
    reason: "browser binary not installed",
  },
  // ffmpeg missing (video rendering).
  {
    test: /ffmpeg|video rendering requires/i,
    reason: "ffmpeg not installed (video capture)",
  },
  // Auth gate.
  {
    test: /\b401\b|unauthor(?:ized|ised)|http basic auth|authentication (?:failed|required)/i,
    reason: "authentication failed (401)",
  },
  { test: /\b403\b|forbidden/i, reason: "access forbidden (403)" },
  // Timeouts.
  { test: /timed?\s*out|timeout (?:of )?\d|exceeded.*timeout|navigation timeout/i, reason: "timed out" },
  // Runner out-of-memory / crash.
  {
    test: /out of memory|\boom\b|heap out of memory|killed.*signal|sigkill|enomem/i,
    reason: "runner ran out of memory",
  },
  // Runner pool offline / never ran.
  { test: /runner pool offline|did not run|no runner|runner.*unavailable/i, reason: "runner offline — mission did not run" },
  // Network / DNS.
  { test: /econnrefused|enotfound|\bdns\b|net::err|connection refused/i, reason: "could not reach the target" },
];

/** Cap so a one-liner never grows into a paragraph on the card. */
const MAX_REASON_LENGTH = 120;

function capLength(text: string, max = MAX_REASON_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Take a card's raw failure text (summary / blocker / statusReason) and
 * return a clean, capped, human-readable reason — mapping known failures
 * to friendly phrases, otherwise falling back to the cleaned PRIMARY
 * segment of the raw text (first sentence / segment before a separator).
 */
export function summarizeMissionFailure(raw: string | undefined | null): MissionFailureSummary {
  const cleaned = cleanFailureText(raw);
  if (!cleaned) return { reason: "no failure detail reported", friendly: false };

  for (const { test, reason } of KNOWN_FAILURES) {
    if (test.test(cleaned)) return { reason, friendly: true };
  }

  // Fallback: strip a leading "stderr:"/"error:" label, take the first
  // sentence/clause (before a sentence end or a semicolon — pipe and
  // box-drawing separators are already spaces by now, so we don't rely on
  // them), and cap. We keep the cleaned remainder reachable in the drawer;
  // here we only need a readable lead-in, never the whole dump.
  const delabeled = cleaned.replace(/^\s*(?:stderr|stdout|error|err)\s*[:-]\s*/i, "");
  const primary = delabeled.split(/;\s+|(?<=[.!?])\s+/)[0]?.trim() || delabeled;
  return { reason: capLength(primary), friendly: false };
}

/**
 * The card / rail one-liner for a failed mission: verdict + cleaned
 * reason, e.g. "Mission failed — browser binary not installed".
 *
 * `verdictLabel` lets callers say "Mission failed" vs a softer
 * "Mission incomplete" for a PARTIAL; defaults to "Mission failed".
 */
export function missionFailureLine(
  raw: string | undefined | null,
  verdictLabel = "Mission failed",
): string {
  const { reason } = summarizeMissionFailure(raw);
  return `${verdictLabel} — ${reason}`;
}

/** Minimal shape we read off a mission card — kept structural so this
 *  module stays free of the heavier card-types import cycle. */
interface MissionFailureCardLike {
  type?: string;
  summary?: string;
  missionStatus?: string;
  mission?: {
    verdict?: string;
    verdictTone?: string;
    blockers?: { head?: string; body?: string }[];
  };
}

/**
 * The raw failure text the runner left on a mission card, in priority
 * order: the first blocker (head + body), else the card summary. This is
 * the multi-line/boxed text we must clean before showing it.
 */
export function rawMissionFailureText(card: MissionFailureCardLike): string {
  const blocker = card.mission?.blockers?.[0];
  if (blocker) {
    return [blocker.head, blocker.body].filter(Boolean).join(" — ");
  }
  return card.summary ?? "";
}

/**
 * Card/rail one-liner for a FAILED mission card, or `null` when the card
 * isn't a failed mission (caller falls back to the normal summary). Reads
 * the structured report's verdict to pick the label, then cleans the raw
 * failure text. The full raw detail stays in the drawer.
 */
export function missionFailureCardSummary(card: MissionFailureCardLike): string | null {
  if (card.type !== "mission") return null;
  const verdict = card.mission?.verdict;
  const failed =
    card.missionStatus === "failed" ||
    card.mission?.verdictTone === "fail" ||
    verdict === "FAILED";
  if (!failed && verdict !== "PARTIAL") return null;
  const label = verdict === "PARTIAL" ? "Mission incomplete" : "Mission failed";
  return missionFailureLine(rawMissionFailureText(card), label);
}
