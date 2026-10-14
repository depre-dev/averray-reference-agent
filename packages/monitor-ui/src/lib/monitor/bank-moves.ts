// Attributed bank moves, as the admin route already printed them.
//
// The panel quotes `line`. It does not rebuild the sentence from work, wallet,
// arrival, or next, and it does not keep those fields. A missing or failed
// read is the sentinel `not reported`, never a count of zero.

export const BANK_MOVES_NOT_REPORTED = "not reported";
export const BANK_MOVES_VISIBLE_LIMIT = 8;

/** The backend report's example line. The snapshot test pins this exact text. */
export const BANK_MOVE_EXAMPLE_LINE =
  "+1.00 reserved · job pr-quanta-js-quanta-212 (git-patch-tests-v1) · 0x2e3c…91 regular (5 jobs, 3 settled, 1 rejected, 1 open, since Sep 28) · MCP, client \"claude-code\", stage claimed · claim expires 14:20Z, payout on merge";

export interface BankMoveLine {
  id: string;
  at: string;
  line: string;
}

export type BankMovesReading =
  | { state: "live"; moves: BankMoveLine[]; incomplete: boolean }
  | { state: "unavailable"; text: typeof BANK_MOVES_NOT_REPORTED };

export type BankMovesView =
  | { kind: "not-reported" }
  | { kind: "none" }
  | { kind: "lines"; lines: BankMoveLine[]; withheld: number; incomplete: boolean };

/** Same UTC stamp the digest prints. The backend line is not rewritten. */
export function bankMoveStamp(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "time not reported";
  const date = new Date(parsed);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}Z`;
}

/** Newest first, bounded. An incomplete empty read stays `not reported`. */
export function bankMovesView(reading: BankMovesReading | undefined): BankMovesView {
  if (!reading || reading.state !== "live") return { kind: "not-reported" };
  if (reading.moves.length === 0) {
    return reading.incomplete ? { kind: "not-reported" } : { kind: "none" };
  }
  const ordered = reading.moves.slice().sort(
    (a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const lines = ordered.slice(0, BANK_MOVES_VISIBLE_LIMIT);
  return {
    kind: "lines",
    lines,
    withheld: ordered.length - lines.length,
    incomplete: reading.incomplete,
  };
}
