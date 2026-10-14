// Attributed reward-bank moves, read from the platform admin route.
//
// GET /admin/ops/bank-moves is an ops:view sibling of the overnight ledger.
// This module polls it with the same bearer session, walking `nextCursor`.
// The board and the digest quote each move's `line` verbatim. They do not
// reassemble work, wallet, arrival, or next from the structured fields, and
// they do not keep those fields at all — the line is the sentence.
//
// A missing route, a 403, a timeout, a schema miss, or a payload that claims
// network identifiers is `not reported`. That is never rendered as zero moves.

import { defangUntrustedUrl, slackMrkdwnEscape } from "./arrival-alerts.js";
import { raceDeadline } from "./inflight-attempt.js";

export const BANK_MOVES_SCHEMA = "averray.admin.bank-moves.v1";
export const BANK_MOVES_NOT_REPORTED = "not reported";
export const BANK_MOVES_PAGE_LIMIT = 50;
export const BANK_MOVES_MAX_PAGES = 4;
export const BANK_MOVES_RETAIN = 40;
export const BANK_MOVES_QUOTE_LIMIT = 8;
/** First poll looks back a day. Later polls continue from the cursor. */
export const BANK_MOVES_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How a move is quoted on the board, in Slack, and on `/monitor/product-health`.
 *
 * `full` (the default) is the backend `line` unchanged.
 * `redacted` keeps amount, job, and wallet tag, and drops the wallet history,
 * arrival, and next clauses. Set `BANK_MOVES_LINE=redacted` to switch. Any
 * other value, including unset, stays `full`.
 */
export type BankMovesLineMode = "full" | "redacted";

const WALLET_TAGS = ["first arrival", "returning", "regular", "ambiguous", "self"] as const;

const FORBIDDEN_NETWORK_KEY = /^(ip|asn|geo|latitude|longitude|city|country|region)$/i;

export interface BankMoveLine {
  id: string;
  at: string;
  /** Backend sentence. Quoted as-is. */
  line: string;
}

export interface BankMovesCursorState {
  /** Exclusive move id. Null until a page names one. */
  cursor: string | null;
  /** Inclusive ISO bound used when there is no cursor yet. */
  openedAt: string;
}

export type BankMovesReading =
  | { state: "live"; moves: BankMoveLine[]; incomplete: boolean }
  | { state: "unavailable"; text: typeof BANK_MOVES_NOT_REPORTED };

export interface BankMovesPollResult {
  reading: BankMovesReading;
  cursor: BankMovesCursorState;
  accumulated: BankMoveLine[];
}

/**
 * A cursor is a move id. Blank and null are not ids. #1492 returns null on a
 * quiet tick. An older build returned the sentinel "not reported"; sending
 * either back as `since` replays old moves, so both stay off the next request.
 */
export function usableBankMovesCursor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === BANK_MOVES_NOT_REPORTED) return null;
  return trimmed;
}

export function bankMovesLineMode(env: NodeJS.ProcessEnv = process.env): BankMovesLineMode {
  return (env.BANK_MOVES_LINE ?? "").trim().toLowerCase() === "redacted" ? "redacted" : "full";
}

/** Amount, job clause, and tag. Anything we cannot parse stays the sentinel. */
export function redactBankMoveLine(line: string): string {
  const parts = line.split(" · ");
  const amount = parts[0]?.trim() ?? "";
  const job = parts[1]?.trim() ?? "";
  const tag = parts.length >= 3 ? tagFromWallet(parts[2] ?? "") : null;
  if (!amount || !job || !tag) return BANK_MOVES_NOT_REPORTED;
  return `${amount} · ${job} · ${tag}`;
}

export function projectBankMoveLine(line: string, mode: BankMovesLineMode): string {
  return mode === "redacted" ? redactBankMoveLine(line) : line;
}

export function projectBankMovesReading(reading: BankMovesReading, mode: BankMovesLineMode): BankMovesReading {
  if (mode === "full" || reading.state !== "live") return reading;
  return {
    ...reading,
    moves: reading.moves.map((move) => ({ ...move, line: projectBankMoveLine(move.line, mode) })),
  };
}

export function openBankMovesCursor(
  nowMs: number,
  previous?: BankMovesCursorState | null,
): BankMovesCursorState {
  const cursor = usableBankMovesCursor(previous?.cursor);
  if (previous?.openedAt) return { cursor, openedAt: previous.openedAt };
  return {
    cursor,
    openedAt: new Date(nowMs - BANK_MOVES_LOOKBACK_MS).toISOString(),
  };
}

export function unavailableBankMoves(
  cursor: BankMovesCursorState,
  accumulated: readonly BankMoveLine[] = [],
): BankMovesPollResult {
  return {
    reading: { state: "unavailable", text: BANK_MOVES_NOT_REPORTED },
    cursor,
    accumulated: accumulated.slice(),
  };
}

/** UTC stamp for a move. The backend line stays intact beside it. */
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

export function stampedBankMoveLine(move: BankMoveLine): string {
  return `${bankMoveStamp(move.at)} · ${move.line}`;
}

/**
 * Sentences for the morning digest.
 *
 * Null when this monitor has no reading yet. A failed read, and an empty
 * incomplete read, are the sentinel. A complete empty window says so without
 * a count. Each quoted row is the move's UTC time and then the backend line.
 * These rows are not Slack-escaped: the Buzz digest and the LLM composer
 * receive them as written.
 */
export function bankChangeText(reading: BankMovesReading | undefined): string[] | null {
  if (!reading) return null;
  if (reading.state !== "live" || (reading.moves.length === 0 && reading.incomplete)) {
    return ["Recent bank moves: not reported"];
  }
  if (reading.moves.length === 0) return ["Recent bank moves: none in window"];
  const quoted = reading.moves.slice(0, BANK_MOVES_QUOTE_LIMIT).map(stampedBankMoveLine);
  const lines = ["Recent bank moves:", ...quoted];
  if (reading.incomplete || reading.moves.length > BANK_MOVES_QUOTE_LIMIT) {
    lines.push("remainder not reported");
  }
  return lines;
}

const BANK_ALERT_PROBES = new Set(["money_path", "signer_liquidity", "treasury_liquidity"]);

/**
 * Move lines for a product-health page.
 *
 * Only money and bank pages carry them. A latency or chain page does not.
 * Only moves strictly newer than the previous page are included, so a cooldown
 * repeat does not paste the same eight lines again. No newer line means no
 * section at all — not a zero and not the sentinel.
 */
export function bankMovesAlertLines(input: {
  reading: BankMovesReading | undefined;
  redProbeNames: readonly string[];
  moneyKey: string;
  poolCritical: boolean;
  previousAlertAtMs: number;
}): string[] | null {
  const moneyOrBank = input.moneyKey !== ""
    || input.poolCritical
    || input.redProbeNames.some((name) => BANK_ALERT_PROBES.has(name));
  if (!moneyOrBank || !input.reading || input.reading.state !== "live") return null;
  const newer = input.reading.moves.filter((move) => {
    const at = Date.parse(move.at);
    return Number.isFinite(at) && at > input.previousAlertAtMs;
  });
  if (newer.length === 0) return null;
  // Slack posts this text raw. Escape every quoted line. The digest path does not.
  const quoted = newer.slice(0, BANK_MOVES_QUOTE_LIMIT).map((move) =>
    slackMrkdwnEscape(defangUntrustedUrl(stampedBankMoveLine(move))),
  );
  const lines = ["Recent bank moves:", ...quoted];
  if (newer.length > BANK_MOVES_QUOTE_LIMIT) lines.push("remainder not reported");
  return lines;
}

export async function readBankMoves(input: {
  baseUrl: string | undefined;
  getSession: () => Promise<{ token: string }>;
  fetchImpl?: typeof fetch;
  cursor: BankMovesCursorState;
  accumulated?: readonly BankMoveLine[];
  /** Drops accumulated lines older than the lookback. Defaults to the clock. */
  nowMs?: number;
  timeoutMs?: number;
  limit?: number;
  maxPages?: number;
  retain?: number;
}): Promise<BankMovesPollResult> {
  const nowMs = input.nowMs ?? Date.now();
  const accumulated = withinLookback(input.accumulated ?? [], nowMs);
  const fail = () => unavailableBankMoves(input.cursor, accumulated);
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) return fail();

  const timeoutMs = input.timeoutMs ?? 8_000;
  let token: string;
  try {
    const session = await raceDeadline(input.getSession(), timeoutMs);
    token = session.token;
  } catch {
    return fail();
  }
  if (!token) return fail();

  const limit = input.limit ?? BANK_MOVES_PAGE_LIMIT;
  const maxPages = input.maxPages ?? BANK_MOVES_MAX_PAGES;
  const retain = input.retain ?? BANK_MOVES_RETAIN;
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/u, "");

  const heldCursor = usableBankMovesCursor(input.cursor.cursor);
  let since = heldCursor ?? input.cursor.openedAt;
  const incoming: BankMoveLine[] = [];
  let incomplete = false;
  let cursor = heldCursor;
  let pages = 0;

  while (pages < maxPages) {
    const url =
      `${base}/admin/ops/bank-moves?since=${encodeURIComponent(since)}` +
      `&limit=${encodeURIComponent(String(limit))}`;
    const page = await fetchPage(url, token, fetchImpl, timeoutMs);
    if (page === "fail") return fail();
    incoming.push(...page.moves);
    incomplete = incomplete || page.incomplete;
    pages += 1;
    if (!page.hasMore) {
      cursor = page.nextCursor ?? cursor;
      break;
    }
    if (!page.nextCursor || page.nextCursor === since) {
      incomplete = true;
      break;
    }
    cursor = page.nextCursor;
    since = page.nextCursor;
    if (pages >= maxPages) incomplete = true;
  }

  const merged = withinLookback(mergeMoves(accumulated, incoming, retain), nowMs);
  const nextCursor = { cursor, openedAt: input.cursor.openedAt };
  if (merged.length === 0 && incomplete) {
    return {
      reading: { state: "unavailable", text: BANK_MOVES_NOT_REPORTED },
      cursor: nextCursor,
      accumulated: merged,
    };
  }
  return {
    reading: { state: "live", moves: merged, incomplete },
    cursor: nextCursor,
    accumulated: merged,
  };
}

interface ParsedPage {
  moves: BankMoveLine[];
  hasMore: boolean;
  nextCursor: string | null;
  incomplete: boolean;
}

async function fetchPage(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ParsedPage | "fail"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await raceDeadline(fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    }), timeoutMs);
    if (response.status === 401 || response.status === 403 || response.status === 404 || !response.ok) {
      return "fail";
    }
    const body: unknown = await raceDeadline(response.json(), timeoutMs);
    return parsePage(body);
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

function parsePage(body: unknown): ParsedPage | "fail" {
  if (!isRecord(body) || body.schemaVersion !== BANK_MOVES_SCHEMA) return "fail";
  if (hasForbiddenNetworkKey(body)) return "fail";
  const privacy = body.privacy;
  if (!isRecord(privacy) || privacy.containsNetworkIdentifiers !== false) return "fail";
  if (privacy.preAuthJoinedToWallet === true) return "fail";
  if (typeof body.unavailable === "string" && body.unavailable !== BANK_MOVES_NOT_REPORTED) return "fail";
  if (!Array.isArray(body.moves)) return "fail";

  const moves: BankMoveLine[] = [];
  for (const entry of body.moves) {
    const move = parseMove(entry);
    if (!move) return "fail";
    moves.push(move);
  }

  const history = isRecord(body.history) ? body.history : null;
  const historyIncomplete = !history || history.complete !== true || history.eventLogBounded === true;
  const gap = body.gap === true;
  const hasMore = body.hasMore === true;
  const nextCursor = usableBankMovesCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
  return {
    moves,
    hasMore,
    nextCursor,
    // hasMore is the cursor, not a hole. A hole is a backend gap or a history
    // window the producer says is not complete.
    incomplete: gap || historyIncomplete,
  };
}

function parseMove(value: unknown): BankMoveLine | null {
  if (!isRecord(value)) return null;
  const { id, at, line } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  if (typeof line !== "string" || line.length === 0) return null;
  return { id, at, line };
}

function withinLookback(moves: readonly BankMoveLine[], nowMs: number): BankMoveLine[] {
  const cutoff = nowMs - BANK_MOVES_LOOKBACK_MS;
  return moves.filter((move) => {
    const at = Date.parse(move.at);
    return Number.isFinite(at) && at >= cutoff;
  });
}

function mergeMoves(
  previous: readonly BankMoveLine[],
  incoming: readonly BankMoveLine[],
  retain: number,
): BankMoveLine[] {
  const byId = new Map<string, BankMoveLine>();
  for (const move of previous) byId.set(move.id, move);
  for (const move of incoming) byId.set(move.id, move);
  return [...byId.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, retain);
}

function hasForbiddenNetworkKey(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenNetworkKey(entry, depth + 1));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_NETWORK_KEY.test(key) && child != null && child !== BANK_MOVES_NOT_REPORTED) return true;
    if (hasForbiddenNetworkKey(child, depth + 1)) return true;
  }
  return false;
}

function tagFromWallet(segment: string): string | null {
  const addressed = segment.match(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{2}\s+(.+)$/u);
  const rest = addressed?.[1]?.trim() ?? "";
  for (const tag of WALLET_TAGS) {
    if (rest === tag || rest.startsWith(`${tag} `) || rest.startsWith(`${tag}(`) || rest.startsWith(`${tag},`)) {
      return tag;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
