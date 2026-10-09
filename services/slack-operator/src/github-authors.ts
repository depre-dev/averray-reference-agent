// GitHub author visibility, rendered as served.
//
// `github_author_concentration` is a warning the backend already computed.
// `githubAuthors` is the admin status block the backend already computed.
// This module copies those fields onto the board. It does not count authors,
// open claims, or payouts, and it does not decide the concentration rule.

export interface GithubAuthorWarning {
  code: "github_author_concentration";
  severity: string | null;
  message: string | null;
  openClaims: number | null;
  totalOpenClaims: number | null;
  distinctWallets: number | null;
}

export interface GithubAuthorRow {
  author: string;
  openClaims: number | null;
  submitted: number | null;
  awaitingHumanReview: number | null;
  settled7d: number | null;
  settled30d: number | null;
  distinctWallets: number | null;
  usdcPaid: string | null;
  /** Why paid is absent. A missing amount is not zero. */
  missingPayoutEvidence: string | null;
}

export interface GithubAuthorsBlock {
  distinctAuthors: number | null;
  distinctWallets: number | null;
  unattributedClaims: number | null;
  unattributedSessions: number | null;
  authors: GithubAuthorRow[];
}

export type GithubAuthorsUnavailable = "unauthorised" | "timeout" | "missing" | "unreachable";

export interface GithubAuthorsSurface {
  /** The served warning, or null when this payload did not include it. */
  warning: GithubAuthorWarning | null;
  /** The admin block, or null when this payload did not include it. */
  block: GithubAuthorsBlock | null;
  /** Why there is no fresh block. A timeout may still carry the previous block. */
  unavailable?: GithubAuthorsUnavailable | null;
  /** Epoch ms of the block in this view. */
  at?: number | null;
  /** Age of that block. Set when the view is retained after a timeout. */
  ageMs?: number | null;
  /** True when `block` is an earlier read kept because this poll did not finish. */
  stale?: boolean;
}

/** /admin/status is the heaviest admin route. Do not poll it faster than this. */
export const GITHUB_AUTHORS_POLL_MS = 5 * 60 * 1000;
export const GITHUB_AUTHORS_TIMEOUT_MS = 8_000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function concentrationWarning(
  warnings: readonly unknown[] | null | undefined,
): GithubAuthorWarning | null {
  for (const item of warnings ?? []) {
    const warning = record(item);
    if (!warning || warning.code !== "github_author_concentration") continue;
    return {
      code: "github_author_concentration",
      severity: typeof warning.severity === "string" ? warning.severity : null,
      message: typeof warning.message === "string" ? warning.message : null,
      openClaims: num(warning.openClaims),
      totalOpenClaims: num(warning.totalOpenClaims),
      distinctWallets: num(warning.distinctWallets),
    };
  }
  return null;
}

export function githubAuthorsBlock(value: unknown): GithubAuthorsBlock | null {
  const root = record(value);
  if (!root) return null;
  const authors = Array.isArray(root.authors) ? root.authors : [];
  return {
    distinctAuthors: num(root.distinctAuthors),
    distinctWallets: num(root.distinctWallets),
    unattributedClaims: num(root.unattributedClaims),
    unattributedSessions: num(root.unattributedSessions),
    authors: authors.flatMap((item) => {
      const row = record(item);
      if (!row || typeof row.author !== "string" || !row.author) return [];
      const paid = record(row.usdcPaid);
      const amount = typeof paid?.amount === "string" || typeof paid?.amount === "number" ? String(paid.amount) : null;
      return [{
        author: row.author,
        openClaims: num(row.openClaims),
        submitted: num(row.submitted),
        awaitingHumanReview: num(row.awaitingHumanReview),
        settled7d: num(row.settled7d),
        settled30d: num(row.settled30d),
        distinctWallets: num(row.distinctWallets),
        usdcPaid: amount,
        missingPayoutEvidence:
          typeof row.missingPayoutEvidence === "string" && row.missingPayoutEvidence.trim()
            ? row.missingPayoutEvidence.trim()
            : null,
      }];
    }),
  };
}

/** Copy the warning and the admin block. Neither count is derived here.
 *  The admin status body is not the block: only `githubAuthors` is. */
export function githubAuthorSurface(input: {
  warnings?: readonly unknown[] | null;
  adminStatus?: unknown;
}): GithubAuthorsSurface {
  const fromHealth = concentrationWarning(input.warnings);
  const admin = record(input.adminStatus);
  if (!admin) return { warning: fromHealth, block: null };
  if (!("githubAuthors" in admin) || admin.githubAuthors == null) {
    return { warning: fromHealth, block: null, unavailable: "missing" };
  }
  const block = githubAuthorsBlock(admin.githubAuthors);
  if (!block) return { warning: fromHealth, block: null, unavailable: "missing" };
  const fromAdmin = concentrationWarning(record(admin.githubAuthors)?.warnings as unknown[] | undefined);
  return { warning: fromHealth ?? fromAdmin, block };
}

interface AuthorCache {
  surface: GithubAuthorsSurface;
  /** When the retained block was read. */
  at: number;
  /** When /admin/status was last attempted, including a hung or failed read. */
  attemptedAt: number;
}

let authorCache: AuthorCache | null = null;

export function __resetGithubAuthorsForTests(): void {
  authorCache = null;
}

function aged(
  surface: GithubAuthorsSurface,
  at: number,
  nowMs: number,
  extra: Partial<GithubAuthorsSurface> = {},
): GithubAuthorsSurface {
  return { ...surface, ...extra, at, ageMs: Math.max(0, nowMs - at) };
}

function abortAsTimeout(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error("timed out");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

function remember(surface: GithubAuthorsSurface, nowMs: number): GithubAuthorsSurface {
  const next = aged(surface, nowMs, nowMs);
  authorCache = { surface: next, at: nowMs, attemptedAt: nowMs };
  return next;
}

/** A failed attempt still starts the five-minute gap, and keeps any block we have. */
function noteAttempt(nowMs: number, unavailable: GithubAuthorsUnavailable): GithubAuthorsSurface {
  if (authorCache?.surface.block) {
    const surface = { ...authorCache.surface, unavailable, stale: true };
    authorCache = { surface, at: authorCache.at, attemptedAt: nowMs };
    return aged(surface, authorCache.at, nowMs);
  }
  const surface: GithubAuthorsSurface = { warning: null, block: null, unavailable, at: nowMs, ageMs: 0 };
  authorCache = { surface, at: nowMs, attemptedAt: nowMs };
  return surface;
}

export async function readAdminGithubAuthors(input: {
  baseUrl?: string;
  getSession: () => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
  /** Tests inject a shorter gap. Production polls no faster than five minutes. */
  minIntervalMs?: number;
}): Promise<GithubAuthorsSurface> {
  const nowMs = input.nowMs ?? Date.now();
  const interval = input.minIntervalMs ?? GITHUB_AUTHORS_POLL_MS;
  if (authorCache && nowMs - authorCache.attemptedAt < interval) {
    return aged(authorCache.surface, authorCache.at, nowMs);
  }

  const timeoutMs = input.timeoutMs ?? GITHUB_AUTHORS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stage: "session" | "fetch" = "session";
  try {
    const session = await Promise.race([input.getSession(), abortAsTimeout(controller.signal)]);
    stage = "fetch";
    const base = (input.baseUrl ?? "https://api.averray.com").replace(/\/+$/, "");
    const response = await input.fetchImpl(`${base}/admin/status`, {
      headers: { accept: "application/json", authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return remember({ warning: null, block: null, unavailable: "unauthorised" }, nowMs);
    }
    if (!response.ok) {
      return remember({ warning: null, block: null, unavailable: "missing" }, nowMs);
    }
    const surface = githubAuthorSurface({ adminStatus: await response.json() });
    if (!surface.block) return remember({ ...surface, unavailable: "missing" }, nowMs);
    return remember(surface, nowMs);
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    const unavailable: GithubAuthorsUnavailable = aborted
      ? "timeout"
      : stage === "session"
        ? "unauthorised"
        : "unreachable";
    return noteAttempt(nowMs, unavailable);
  } finally {
    clearTimeout(timer);
  }
}
