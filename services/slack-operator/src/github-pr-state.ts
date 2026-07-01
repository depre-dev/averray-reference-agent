export interface MonitorPullRequestState {
  repo: string;
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  url?: string;
  title?: string;
  author?: string;
  mergeableState?: string;
  headSha?: string;
  baseBranch?: string;
  headBranch?: string;
  updatedAt?: string;
  checkedAt: string;
  source: "github_live";
}

export interface GithubPrStateDeps {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
}

type MonitorEntry = Record<string, unknown> & {
  repo?: string | null;
  pullRequestNumber?: number | null;
  summary?: Record<string, unknown> | null;
};

type MonitorPayload = Record<string, unknown> & {
  active?: unknown[];
  recent?: unknown[];
};

interface GithubApiUser {
  login?: string;
}

interface GithubApiPullRequest {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  user?: GithubApiUser | null;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  state?: string;
  base?: { ref?: string } | null;
  head?: { ref?: string; sha?: string } | null;
  mergeable_state?: string | null;
}

interface GithubApiPullRequestFile {
  filename?: string;
  additions?: number;
  deletions?: number;
}

interface GithubApiCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface GithubApiWorkflowRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface GithubApiCommit {
  commit?: {
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  } | null;
}

interface GithubPendingCheckState {
  pending: boolean;
  pendingCount: number;
  reason?: "workflow_run_active" | "head_commit_grace";
  workflowRuns: GithubApiWorkflowRun[];
  headCommitAt?: string;
  graceMs: number;
}

const CACHE_TTL_MS = 60_000;
const DEFAULT_PR_CHECKS_GRACE_MS = 10 * 60_000;
const cache = new Map<string, { expiresAt: number; value: MonitorPullRequestState }>();
const openPullRequestCache = new Map<string, { expiresAt: number; value: MonitorEntry[] }>();

// ── GitHub fetch resilience (rate-limit root-cause + fail-stale) ─────
//
// The board re-reads GitHub every snapshot. Per-PR files/check-runs/actions
// fan-out (× repos × frequency) can burn the token's hourly budget, and once
// GitHub answers 403 "rate limit exceeded" the old code silently `.catch`ed the
// error and served the last-seen (pre-merge) card as a fresh decision — the
// truth-boundary bug. This layer:
//   1. Sends conditional requests (If-None-Match) so an unchanged resource
//      returns 304 and costs 0 against the primary rate limit (ETag cache).
//   2. On a 403/429 rate-limit answer, reads X-RateLimit-Reset / Retry-After and
//      opens a short circuit breaker so we stop hammering until the window
//      resets — and raises a typed GithubRateLimitError so callers can mark the
//      affected card stale instead of freezing pre-merge state.
// Everything is best-effort: if the ETag/breaker bookkeeping ever misbehaves the
// request still falls through to a plain fetch, so the board never crashes.

const DEFAULT_RATELIMIT_COOLDOWN_MS = 60_000;
const MAX_RATELIMIT_COOLDOWN_MS = 15 * 60_000;
const ETAG_CACHE_MAX_ENTRIES = 500;

/** A GitHub fetch that failed because the token is rate-limited (403/429). */
export class GithubRateLimitError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, url: string, retryAfterMs?: number) {
    super(`GitHub API ${status} rate limit exceeded for ${url}`);
    this.name = "GithubRateLimitError";
    this.status = status;
    if (typeof retryAfterMs === "number") this.retryAfterMs = retryAfterMs;
  }
}

/** ETag + last-good body per URL, so a 304 can be served without re-fetching. */
const etagCache = new Map<string, { etag: string; body: unknown }>();

/**
 * Process-wide rate-limit circuit breaker. Keyed per token so a single
 * exhausted token doesn't suppress a different (healthy) token's requests —
 * important because averray-agent and depre-dev use different owner tokens.
 * `until` is the epoch-ms at which the breaker re-opens.
 */
const rateLimitCooldownUntil = new Map<string, number>();

/**
 * Stable, in-memory-only key for a token. Uses a cheap non-cryptographic hash of
 * the full token (not a short prefix — real GitHub tokens share prefixes like
 * `ghp_` / `github_pat_`, which would collide two distinct tokens onto one
 * breaker). The hash is a Map key only; the raw token is never stored or logged.
 */
function tokenBreakerKey(token: string): string {
  let hash = 5381;
  for (let i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
  }
  return `t${hash >>> 0}`;
}

/** True when the token is currently in a rate-limit cool-off window. */
function isRateLimited(token: string, now: number): boolean {
  const until = rateLimitCooldownUntil.get(tokenBreakerKey(token));
  return typeof until === "number" && until > now;
}

/** Open the breaker for `token` until the reset/Retry-After hint (clamped). */
function openRateLimitBreaker(token: string, retryAfterMs: number | undefined, now: number): void {
  const cooldown = Math.min(
    MAX_RATELIMIT_COOLDOWN_MS,
    Math.max(1_000, retryAfterMs ?? DEFAULT_RATELIMIT_COOLDOWN_MS),
  );
  rateLimitCooldownUntil.set(tokenBreakerKey(token), now + cooldown);
}

/** Parse Retry-After (seconds) or X-RateLimit-Reset (epoch seconds) → ms-from-now. */
function rateLimitRetryAfterMs(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - now);
  }
  return undefined;
}

/**
 * A 403/429 is only a *rate-limit* answer when GitHub says so — a 403 can also
 * be a permission/scope problem, which must NOT trip the breaker (retrying later
 * won't help and we shouldn't suppress the token). Detect the rate-limit case
 * via the documented signals: exhausted primary limit (remaining "0") or the
 * secondary-limit Retry-After header.
 */
function isRateLimitResponse(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.status === 429) return true;
  if (response.headers.get("retry-after")) return true;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function rememberEtag(url: string, etag: string, body: unknown): void {
  // Bounded LRU-ish: drop the oldest entry when full (Map keeps insertion order).
  if (etagCache.size >= ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) etagCache.delete(oldest);
  }
  etagCache.set(url, { etag, body });
}

/**
 * Build a refresh-failure marker for a PR card whose GitHub state could NOT be
 * re-read (rate limit / fetch error). Shape matches monitor-v2's
 * `sourceFailureFromSummary`, which reads `summary.githubLive.fetchError` and
 * demotes the card to `state: "failed-fetch"` (rendered as the existing
 * degraded / "SOURCE ISSUE" treatment). Truth-boundary: "could not refresh",
 * never merely "old".
 */
function prFetchFailure(error: unknown, now: Date): { code: string; message: string; checkedAt: string } {
  if (error instanceof GithubRateLimitError) {
    return {
      code: String(error.status),
      message: `GitHub API ${error.status} — rate limit exceeded; PR state could not be refreshed.`,
      checkedAt: now.toISOString(),
    };
  }
  const message = error instanceof Error ? error.message : "GitHub PR state could not be refreshed.";
  return { code: "ERROR", message, checkedAt: now.toISOString() };
}

export async function enrichMonitorWithGithubPrState<T extends MonitorPayload>(
  monitor: T,
  deps: GithubPrStateDeps = {}
): Promise<T> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const entries = [
    ...monitorEntries(monitor.active),
    ...monitorEntries(monitor.recent),
  ];
  const githubLiveEntries = await fetchOpenPullRequestMonitorEntries({ env, fetchFn, now }).catch(() => []);
  const keys = uniquePrKeys(entries);
  if (!keys.length && githubLiveEntries.length === 0) return monitor;

  const states = new Map<string, MonitorPullRequestState>();
  // Per-PR refresh failures. A card whose live state we could not read must be
  // demoted to a degraded/stale state rather than served as a fresh decision —
  // so we record the failure and attach it below instead of dropping it.
  const failures = new Map<string, { code: string; message: string; checkedAt: string }>();
  await Promise.all(keys.map(async ({ key, repo, pullRequestNumber }) => {
    const token = resolveGithubTokenForRepo(repo, env);
    if (!token) return;
    try {
      const state = await fetchPullRequestState({
        repo,
        pullRequestNumber,
        token,
        fetchFn,
        now,
      });
      if (state) states.set(key, state);
    } catch (error) {
      failures.set(key, prFetchFailure(error, now));
    }
  }));
  if (states.size === 0 && failures.size === 0 && githubLiveEntries.length === 0) return monitor;

  return {
    ...monitor,
    ...(Array.isArray(monitor.active) ? { active: enrichEntries(monitor.active, states, failures) } : {}),
    recent: mergeGithubLiveEntries(enrichEntries(Array.isArray(monitor.recent) ? monitor.recent : [], states, failures), githubLiveEntries),
  };
}

/**
 * Enrich post-merge DEPLOY cards with their commit's GitHub check-runs.
 *
 * enrichMonitorWithGithubPrState only fetches checks for OPEN PRs; post-deploy
 * verification handoffs (correlationId `github-deploy-<runId>-<sha>`) have no
 * open PR, so the deploy stepper had nothing to render ("awaiting deploy
 * telemetry"). Here we fetch the deployed SHA's check-runs and attach them as
 * `summary.checks`, which the existing mapCheckRuns → deploy-stepper flow lights
 * up. Truth-boundary: if a SHA can't be resolved, no token exists, or the fetch
 * returns nothing, the entry is left unchanged (the stepper stays honest).
 */
export async function enrichMonitorWithDeployCheckRuns<T extends MonitorPayload>(
  monitor: T,
  deps: GithubPrStateDeps = {},
): Promise<T> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const baseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
  const entries = [...monitorEntries(monitor.active), ...monitorEntries(monitor.recent)];
  const targets = new Map<string, { repo: string; sha: string }>();
  for (const entry of entries) {
    if (entryHasChecks(entry)) continue;
    const target = deployTargetFromEntry(entry);
    if (target) targets.set(`${target.repo}\0${target.sha}`, target);
  }
  if (targets.size === 0) return monitor;

  const checksByKey = new Map<string, DeployCheck[]>();
  await Promise.all([...targets.values()].map(async ({ repo, sha }) => {
    const token = resolveGithubTokenForRepo(repo, env);
    if (!token) return;
    const runs = await fetchDeployCheckRuns({ repo, sha, token, baseUrl, fetchFn, now }).catch(() => []);
    if (runs.length > 0) checksByKey.set(`${repo}\0${sha}`, runs);
  }));
  if (checksByKey.size === 0) return monitor;

  const attach = (value: unknown[]): unknown[] => value.map((raw) => {
    if (!isRecord(raw) || entryHasChecks(raw)) return raw;
    const target = deployTargetFromEntry(raw as MonitorEntry);
    if (!target) return raw;
    const runs = checksByKey.get(`${target.repo}\0${target.sha}`);
    if (!runs) return raw;
    const summary = isRecord(raw.summary) ? raw.summary : {};
    return { ...raw, summary: { ...summary, checks: runs } };
  });

  return {
    ...monitor,
    ...(Array.isArray(monitor.active) ? { active: attach(monitor.active) } : {}),
    ...(Array.isArray(monitor.recent) ? { recent: attach(monitor.recent) } : {}),
  };
}

interface DeployCheck {
  name: string;
  status: string;
  conclusion?: string;
}

async function fetchDeployCheckRuns(input: {
  repo: string;
  sha: string;
  token: string;
  baseUrl: string;
  fetchFn: typeof fetch;
  now: Date;
}): Promise<DeployCheck[]> {
  const repoPath = encodeRepoPath(input.repo);
  const result = await githubGet<{ check_runs?: GithubApiCheckRun[] }>(
    `${input.baseUrl}/repos/${repoPath}/commits/${encodeURIComponent(input.sha)}/check-runs?per_page=100`,
    input.token,
    input.fetchFn,
    input.now,
  );
  return (result.check_runs ?? []).map((check) => ({
    name: check.name ?? "check",
    status: check.status ?? "unknown",
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
  }));
}

/** Pull {repo, sha} off a post-deploy verification entry, else undefined. */
export function deployTargetFromEntry(entry: MonitorEntry): { repo: string; sha: string } | undefined {
  const correlationId = stringField(entry, "correlationId");
  if (!correlationId || !/^github-deploy-/.test(correlationId)) return undefined;
  const repo = typeof entry.repo === "string" && entry.repo.trim() ? entry.repo.trim() : stringField(entry, "repo");
  if (!repo) return undefined;
  const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
  const sha = deployShaFromCorrelationId(correlationId)
    ?? stringField(entry, "sha")
    ?? stringField(entry, "headSha")
    ?? (metadata ? stringField(metadata, "sha") : undefined);
  if (!sha) return undefined;
  return { repo, sha };
}

function deployShaFromCorrelationId(correlationId: string): string | undefined {
  const match = correlationId.match(/^github-deploy-\d+-([0-9a-fA-F]{7,40})\b/);
  return match ? match[1] : undefined;
}

function entryHasChecks(entry: Record<string, unknown>): boolean {
  const summary = isRecord(entry.summary) ? entry.summary : undefined;
  return Boolean(summary && Array.isArray(summary.checks) && summary.checks.length > 0);
}

function monitorEntries(value: unknown[] | undefined): MonitorEntry[] {
  return Array.isArray(value) ? value.filter(isRecord) as MonitorEntry[] : [];
}

function uniquePrKeys(entries: MonitorEntry[]): Array<{ key: string; repo: string; pullRequestNumber: number }> {
  const seen = new Set<string>();
  const result: Array<{ key: string; repo: string; pullRequestNumber: number }> = [];
  for (const entry of entries) {
    const repo = typeof entry.repo === "string" ? entry.repo : "";
    const pullRequestNumber = typeof entry.pullRequestNumber === "number" ? entry.pullRequestNumber : NaN;
    if (!repo || !Number.isFinite(pullRequestNumber) || pullRequestNumber <= 0) continue;
    const key = prKey(repo, pullRequestNumber);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ key, repo, pullRequestNumber });
  }
  return result;
}

function enrichEntries(
  entries: unknown[],
  states: Map<string, MonitorPullRequestState>,
  failures: Map<string, { code: string; message: string; checkedAt: string }> = new Map(),
): unknown[] {
  return entries.map((entry) => {
    if (!isRecord(entry)) return entry;
    const repo = typeof entry.repo === "string" ? entry.repo : "";
    const pullRequestNumber = typeof entry.pullRequestNumber === "number" ? entry.pullRequestNumber : NaN;
    const key = repo && Number.isFinite(pullRequestNumber) ? prKey(repo, pullRequestNumber) : undefined;
    const state = key ? states.get(key) : undefined;
    if (state) {
      const summary = isRecord(entry.summary) ? entry.summary : {};
      return {
        ...entry,
        summary: {
          ...summary,
          currentPullRequest: state,
        },
      };
    }
    // Fail-stale: the live state could not be refreshed for this card. Attach a
    // fetch-error marker so monitor-v2 demotes it to a degraded/stale state
    // instead of presenting frozen pre-merge state as a fresh decision.
    const failure = key ? failures.get(key) : undefined;
    if (failure) {
      const summary = isRecord(entry.summary) ? entry.summary : {};
      const githubLive = isRecord(summary.githubLive) ? summary.githubLive : {};
      return {
        ...entry,
        summary: {
          ...summary,
          githubLive: {
            ...githubLive,
            fetchError: failure,
          },
        },
      };
    }
    return entry;
  });
}

async function fetchPullRequestState(input: {
  repo: string;
  pullRequestNumber: number;
  token: string;
  fetchFn: typeof fetch;
  now: Date;
}): Promise<MonitorPullRequestState | undefined> {
  const key = prKey(input.repo, input.pullRequestNumber);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > input.now.getTime()) return cached.value;

  // Route through the resilient client (ETag conditional requests + shared
  // rate-limit breaker). A rate-limit answer throws GithubRateLimitError, which
  // the caller turns into a fail-stale marker; a genuine non-rate-limit failure
  // (e.g. 404 for a deleted PR — a definitive answer, not an unverifiable one)
  // returns undefined so the card is simply left un-enriched, not marked stale.
  let pull: unknown;
  try {
    pull = await githubGet<unknown>(
      `https://api.github.com/repos/${input.repo}/pulls/${input.pullRequestNumber}`,
      input.token,
      input.fetchFn,
      input.now,
    );
  } catch (error) {
    if (error instanceof GithubRateLimitError) throw error;
    return undefined;
  }
  if (!isRecord(pull)) return undefined;
  const value: MonitorPullRequestState = {
    repo: input.repo,
    number: input.pullRequestNumber,
    state: stringField(pull, "state") ?? "unknown",
    draft: pull.draft === true,
    merged: pull.merged === true || typeof pull.merged_at === "string",
    ...(stringField(pull, "html_url") ? { url: stringField(pull, "html_url") } : {}),
    ...(stringField(pull, "title") ? { title: stringField(pull, "title") } : {}),
    ...(isRecord(pull.user) && stringField(pull.user, "login") ? { author: stringField(pull.user, "login") } : {}),
    ...(stringField(pull, "mergeable_state") ? { mergeableState: stringField(pull, "mergeable_state") } : {}),
    ...(isRecord(pull.head) && stringField(pull.head, "sha") ? { headSha: stringField(pull.head, "sha") } : {}),
    ...(isRecord(pull.base) && stringField(pull.base, "ref") ? { baseBranch: stringField(pull.base, "ref") } : {}),
    ...(isRecord(pull.head) && stringField(pull.head, "ref") ? { headBranch: stringField(pull.head, "ref") } : {}),
    ...(stringField(pull, "updated_at") ? { updatedAt: stringField(pull, "updated_at") } : {}),
    checkedAt: input.now.toISOString(),
    source: "github_live",
  };
  cache.set(key, { expiresAt: input.now.getTime() + CACHE_TTL_MS, value });
  return value;
}

async function fetchOpenPullRequestMonitorEntries(input: {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  now: Date;
}): Promise<MonitorEntry[]> {
  const repos = parseGithubRepos(input.env);
  if (repos.length === 0) return [];
  const limit = clampLimit(input.env.GITHUB_MONITOR_PR_LIMIT ?? input.env.GITHUB_HELPER_LIMIT);
  const cacheKey = repos.join(",") + "|" + (input.env.GITHUB_API_BASE_URL ?? "https://api.github.com") + "|" + String(limit);
  const cached = openPullRequestCache.get(cacheKey);
  if (cached && cached.expiresAt > input.now.getTime()) return cached.value;

  const baseUrl = (input.env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
  const checksGraceMs = parseChecksGraceMs(input.env);
  const results = await Promise.all(repos.map(async (repo) => {
    const token = resolveGithubTokenForRepo(repo, input.env);
    if (!token) return [];
    return fetchRepoOpenPullRequestEntries({ repo, token, limit, baseUrl, fetchFn: input.fetchFn, now: input.now, checksGraceMs });
  }));
  const entries = results.flat();
  openPullRequestCache.set(cacheKey, { expiresAt: input.now.getTime() + CACHE_TTL_MS, value: entries });
  return entries;
}

async function fetchRepoOpenPullRequestEntries(input: {
  repo: string;
  token: string;
  limit: number;
  baseUrl: string;
  fetchFn: typeof fetch;
  now: Date;
  checksGraceMs: number;
}): Promise<MonitorEntry[]> {
  const repoPath = encodeRepoPath(input.repo);
  const pulls = await githubGet<GithubApiPullRequest[]>(
    `${input.baseUrl}/repos/${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=${input.limit}`,
    input.token,
    input.fetchFn,
    input.now,
  ).catch(() => []);

  const entries = await Promise.all(pulls
    .slice(0, input.limit)
    .map(async (pull) => openPullRequestEntryFromGithub({
      repo: input.repo,
      pull,
      token: input.token,
      baseUrl: input.baseUrl,
      fetchFn: input.fetchFn,
      now: input.now,
      checksGraceMs: input.checksGraceMs,
    })));
  return entries.filter((entry): entry is MonitorEntry => Boolean(entry));
}

async function openPullRequestEntryFromGithub(input: {
  repo: string;
  pull: GithubApiPullRequest;
  token: string;
  baseUrl: string;
  fetchFn: typeof fetch;
  now: Date;
  checksGraceMs: number;
}): Promise<MonitorEntry | undefined> {
  const number = numberField(input.pull.number);
  if (number <= 0) return undefined;
  const repoPath = encodeRepoPath(input.repo);
  const headSha = input.pull.head?.sha;
  // Track whether a per-PR sub-fetch was rate-limited. If so, the checks/files
  // we render are incomplete-because-unverifiable (not a real "no checks"
  // signal), so we mark this synthesized card stale rather than let an empty
  // checks list read as a fresh "needs review" operator decision.
  let rateLimited: GithubRateLimitError | undefined;
  const runSubFetch = async <R>(work: Promise<R>, fallback: R): Promise<R> => {
    try {
      return await work;
    } catch (error) {
      if (error instanceof GithubRateLimitError) rateLimited = error;
      return fallback;
    }
  };
  const [files, checks] = await Promise.all([
    runSubFetch(
      githubGet<GithubApiPullRequestFile[]>(
        `${input.baseUrl}/repos/${repoPath}/pulls/${number}/files?per_page=100`,
        input.token,
        input.fetchFn,
        input.now,
      ),
      [] as GithubApiPullRequestFile[],
    ),
    headSha
      ? runSubFetch(
        githubGet<{ check_runs?: GithubApiCheckRun[] }>(
          `${input.baseUrl}/repos/${repoPath}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
          input.token,
          input.fetchFn,
          input.now,
        ).then((result) => result.check_runs ?? []),
        [] as GithubApiCheckRun[],
      )
      : Promise.resolve([] as GithubApiCheckRun[]),
  ]);
  const pendingCheckState = headSha && checks.length === 0
    ? await readPendingCheckState({
      baseUrl: input.baseUrl,
      repoPath,
      headSha,
      token: input.token,
      fetchFn: input.fetchFn,
      pull: input.pull,
      now: input.now,
      graceMs: input.checksGraceMs,
    })
    : emptyPendingCheckState(input.checksGraceMs);
  const reviewSignals = buildLiveReviewSignals(input.pull, files, checks, pendingCheckState);
  const checksSummary = summarizeGithubChecks(checks, pendingCheckState.pendingCount);
  const reviewReasons = liveReviewReasons(input.pull, files, reviewSignals, checksSummary);
  const highSeverity = reviewReasons.some((reason) => reason.severity === "high");
  const mediumSeverity = reviewReasons.some((reason) => reason.severity === "medium");
  const checksPending = pendingCheckState.pending && checks.length === 0;
  const finalVerdict = highSeverity ? "hold" : mediumSeverity ? "needs_review" : checksPending ? "pending" : "ok_to_merge";
  const mergeRecommendation = highSeverity ? "hold" : mediumSeverity ? "needs_review" : checksPending ? "pending" : "ok_to_merge";
  const reason = reviewReasons.find((entry) => entry.severity === "high" || entry.severity === "medium")?.code
    ?? reviewReasons.find((entry) => entry.code !== "pr_review_green")?.code
    ?? (finalVerdict === "ok_to_merge" ? "github_ok_to_merge" : "github_needs_review");
  const state: MonitorPullRequestState = {
    repo: input.repo,
    number,
    state: input.pull.state ?? "open",
    draft: input.pull.draft === true,
    merged: Boolean(input.pull.merged_at),
    ...(input.pull.html_url ? { url: input.pull.html_url } : {}),
    ...(input.pull.title ? { title: input.pull.title } : {}),
    ...(input.pull.user?.login ? { author: input.pull.user.login } : {}),
    ...(input.pull.mergeable_state ? { mergeableState: input.pull.mergeable_state } : {}),
    ...(headSha ? { headSha } : {}),
    ...(input.pull.base?.ref ? { baseBranch: input.pull.base.ref } : {}),
    ...(input.pull.head?.ref ? { headBranch: input.pull.head.ref } : {}),
    ...(input.pull.updated_at ? { updatedAt: input.pull.updated_at } : {}),
    checkedAt: input.now.toISOString(),
    source: "github_live",
  };

  return {
    correlationId: `github-live-pr-${input.repo.replace(/[^A-Za-z0-9]+/g, "-")}-${number}`,
    requester: "github-live",
    intent: "github_open_pr",
    repo: input.repo,
    pullRequestNumber: number,
    pullRequestUrl: input.pull.html_url,
    status: finalVerdict === "hold" ? "blocked" : finalVerdict === "pending" ? "running" : "completed",
    phase: "github_live",
    active: false,
    activeState: "inactive",
    startedAt: input.pull.created_at ?? input.pull.updated_at ?? input.now.toISOString(),
    updatedAt: input.pull.updated_at ?? input.now.toISOString(),
    eventCount: 0,
    reason,
    summary: {
      kind: "github_live_pull_request",
      source: "github_live",
      status: finalVerdict === "hold" ? "blocked" : finalVerdict === "pending" ? "running" : finalVerdict === "needs_review" ? "needs_review" : "completed",
      finalReason: reason,
      finalVerdict,
      mergeRecommendation,
      pullRequest: state,
      currentPullRequest: state,
      reviewReasons,
      reviewSignals,
      checks: checks.map((check) => ({
        name: check.name ?? "check",
        status: check.status ?? "unknown",
        conclusion: check.conclusion ?? undefined,
      })),
      githubLive: {
        checkedAt: input.now.toISOString(),
        checkTotals: checksSummary,
        checksPending,
        ...(pendingCheckState.reason ? { pendingReason: pendingCheckState.reason } : {}),
        ...(pendingCheckState.headCommitAt ? { headCommitAt: pendingCheckState.headCommitAt } : {}),
        checksGraceMs: pendingCheckState.graceMs,
        workflowRuns: pendingCheckState.workflowRuns.map((run) => ({
          name: run.name ?? "workflow",
          status: run.status ?? "unknown",
          conclusion: run.conclusion ?? undefined,
          url: run.html_url ?? undefined,
        })),
        // Fail-stale: a sub-fetch (files/checks) was rate-limited, so this card's
        // review signals are unverifiable. monitor-v2 reads githubLive.fetchError
        // and demotes the card to a degraded/stale state (out of the live inbox).
        ...(rateLimited ? { fetchError: prFetchFailure(rateLimited, input.now) } : {}),
      },
    },
    safety: {
      source: "github_live",
      wouldMutate: false,
      wouldWriteLocalCheckpoint: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

function mergeGithubLiveEntries(recent: unknown[], githubLiveEntries: MonitorEntry[]): unknown[] {
  if (githubLiveEntries.length === 0) return recent;
  return [...githubLiveEntries, ...recent];
}

function buildLiveReviewSignals(
  pull: GithubApiPullRequest,
  files: GithubApiPullRequestFile[],
  checks: GithubApiCheckRun[],
  pendingCheckState: GithubPendingCheckState
): Record<string, unknown> {
  const touchedFiles = files.map((file) => ({
    path: file.filename ?? "",
    area: inferTouchedArea(file.filename ?? ""),
    // Captured from the same /pulls/:n/files response (no extra fetch) so
    // the board can show a real "+A -D" diff line per file.
    ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
    ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
  })).filter((file) => file.path);
  const touchedAreas = [...new Set(touchedFiles.map((file) => file.area))].filter(Boolean);
  const testSignals = [
    ...files.map((file) => file.filename ?? "").filter(isTestFile).map((filename) => `test file changed: ${filename}`),
    ...checks.map((check) => check.name ?? "").filter(Boolean).map((name) => `check: ${name}`),
    ...pendingCheckState.workflowRuns.map((run) => run.name ?? "").filter(Boolean).map((name) => `workflow pending: ${name}`),
  ];
  const missingTestSignals = pendingCheckState.pending
    ? []
    : touchedAreas.filter((area) => needsMatchingTestSignal(area) && !hasTestSignalForArea(area, testSignals));
  const rolloutNotesRequired = touchedAreas.some((area) => ["ops", "contracts", "indexer", "blockchain", "settlement"].includes(area));
  const body = pull.body ?? "";
  const rolloutNotesPresent = /rollout|rollback|deploy|migration|feature flag|feature-flag/i.test(body);
  return {
    touchedAreas,
    touchedFiles,
    testSignals,
    missingTestSignals,
    rolloutNotesRequired,
    rolloutNotesPresent,
    abiCompatChecked: checks.some((check) => /forge|solidity|contract/i.test(check.name ?? "")),
    abiCompatible: undefined,
    staticAnalysisHigh: 0,
    staticAnalysisInfo: 0,
  };
}

function liveReviewReasons(
  pull: GithubApiPullRequest,
  files: GithubApiPullRequestFile[],
  signals: Record<string, unknown>,
  checks: ReturnType<typeof summarizeGithubChecks>
): Array<{ severity: "low" | "medium" | "high"; code: string; message: string }> {
  const findings: Array<{ severity: "low" | "medium" | "high"; code: string; message: string }> = [];
  const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas.map(String) : [];
  const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals.map(String) : [];
  if (pull.draft === true) findings.push({ severity: "high", code: "pr_is_draft", message: "PR is still marked as draft." });
  if (checks.failed > 0) findings.push({ severity: "high", code: "pr_checks_failed", message: `${checks.failed} PR check(s) failed.` });
  if (checks.active > 0) findings.push({ severity: "high", code: "pr_checks_active", message: `${checks.active} PR check(s) are still running.` });
  if (checks.pending > 0) findings.push({ severity: "low", code: "pr_checks_pending", message: "PR checks have not reported yet; waiting for GitHub Actions to start or finish." });
  if (checks.total === 0) findings.push({ severity: "medium", code: "pr_checks_missing", message: "No PR check runs were found for the head commit." });
  const criticalFiles = files.filter((file) => highRiskForFile(file.filename ?? "") === "high");
  if (criticalFiles.length > 0) {
    findings.push({
      severity: "high",
      code: "pr_critical_files",
      message: `${criticalFiles.length} changed file(s) touch secrets, contracts, or database migrations.`,
    });
  }
  const reviewFiles = files.filter((file) => highRiskForFile(file.filename ?? "") === "medium");
  if (reviewFiles.length > 0) {
    const areas = [...new Set(reviewFiles.map((file) => inferTouchedArea(file.filename ?? "")))].join(", ");
    findings.push({
      severity: "medium",
      code: "pr_review_risk_files",
      message: `${reviewFiles.length} changed file(s) touch review-gated surfaces${areas ? ` (${areas})` : ""}.`,
    });
  }
  if (missingTests.length > 0) {
    findings.push({
      severity: "medium",
      code: "pr_test_signal_missing",
      message: `No changed test files or matching check names found for ${missingTests.join(", ")} changes.`,
    });
  }
  if (signals.rolloutNotesRequired === true && signals.rolloutNotesPresent !== true) {
    findings.push({
      severity: "medium",
      code: "pr_rollout_notes_missing",
      message: "Deploy, ops, contract, indexer, blockchain, or settlement changes should include rollout or rollback notes in the PR body.",
    });
  }
  if (findings.length === 0) {
    findings.push({ severity: "low", code: "pr_review_green", message: "Live GitHub PR metadata and checks look merge-ready." });
  }
  return findings;
}

function summarizeGithubChecks(checks: GithubApiCheckRun[], pending: number = 0): {
  total: number;
  passed: number;
  failed: number;
  active: number;
  neutral: number;
  pending: number;
} {
  const total = checks.length + pending;
  let passed = 0;
  let failed = 0;
  let active = 0;
  let neutral = 0;
  for (const check of checks) {
    const status = normalize(check.status);
    const conclusion = normalize(check.conclusion ?? undefined);
    if (status !== "completed") {
      active += 1;
    } else if (["success"].includes(conclusion)) {
      passed += 1;
    } else if (["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)) {
      failed += 1;
    } else {
      neutral += 1;
    }
  }
  return { total, passed, failed, active, neutral, pending };
}

async function readPendingCheckState(input: {
  baseUrl: string;
  repoPath: string;
  headSha: string;
  token: string;
  fetchFn: typeof fetch;
  pull: GithubApiPullRequest;
  now: Date;
  graceMs: number;
}): Promise<GithubPendingCheckState> {
  const [workflowRuns, headCommitAt] = await Promise.all([
    githubGet<{ workflow_runs?: GithubApiWorkflowRun[] }>(
      `${input.baseUrl}/repos/${input.repoPath}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=100`,
      input.token,
      input.fetchFn,
      input.now,
    ).then((result) => result.workflow_runs ?? []).catch(() => []),
    readHeadCommitAt(input).catch(() => undefined),
  ]);
  const activeWorkflowRuns = workflowRuns.filter((run) => isActiveWorkflowRun(run));
  if (activeWorkflowRuns.length > 0) {
    return {
      pending: true,
      pendingCount: activeWorkflowRuns.length,
      reason: "workflow_run_active",
      workflowRuns: activeWorkflowRuns,
      ...(headCommitAt ? { headCommitAt } : {}),
      graceMs: input.graceMs,
    };
  }
  const referenceAt = headCommitAt ?? input.pull.updated_at ?? input.pull.created_at;
  if (isWithinGraceWindow(referenceAt, input.now, input.graceMs)) {
    return {
      pending: true,
      pendingCount: 1,
      reason: "head_commit_grace",
      workflowRuns: [],
      ...(referenceAt ? { headCommitAt: referenceAt } : {}),
      graceMs: input.graceMs,
    };
  }
  return {
    pending: false,
    pendingCount: 0,
    workflowRuns: [],
    ...(headCommitAt ? { headCommitAt } : {}),
    graceMs: input.graceMs,
  };
}

async function readHeadCommitAt(input: {
  baseUrl: string;
  repoPath: string;
  headSha: string;
  token: string;
  fetchFn: typeof fetch;
  now: Date;
}): Promise<string | undefined> {
  const commit = await githubGet<GithubApiCommit>(
    `${input.baseUrl}/repos/${input.repoPath}/commits/${encodeURIComponent(input.headSha)}`,
    input.token,
    input.fetchFn,
    input.now,
  );
  return commit.commit?.committer?.date ?? commit.commit?.author?.date ?? undefined;
}

function emptyPendingCheckState(graceMs: number): GithubPendingCheckState {
  return { pending: false, pendingCount: 0, workflowRuns: [], graceMs };
}

function isActiveWorkflowRun(run: GithubApiWorkflowRun): boolean {
  const status = normalize(run.status);
  return status === "queued" || status === "in_progress";
}

function isWithinGraceWindow(timestamp: string | undefined, now: Date, graceMs: number): boolean {
  if (!timestamp || graceMs <= 0) return false;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const ageMs = now.getTime() - parsed;
  return ageMs >= 0 && ageMs < graceMs;
}

function parseChecksGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.GITHUB_MONITOR_PR_CHECKS_GRACE_MINUTES ?? env.GITHUB_PR_CHECKS_GRACE_MINUTES;
  if (!raw) return DEFAULT_PR_CHECKS_GRACE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_PR_CHECKS_GRACE_MS;
  return Math.round(minutes * 60_000);
}

async function githubGet<T>(
  url: string,
  token: string,
  fetchFn: typeof fetch,
  now: Date = new Date(),
): Promise<T> {
  const nowMs = now.getTime();
  // Fail fast while the token is in its rate-limit cool-off: no network call,
  // and a typed error so the caller can mark the affected card stale.
  if (isRateLimited(token, nowMs)) {
    throw new GithubRateLimitError(403, url);
  }

  const cachedEtag = etagCache.get(url);
  const response = await fetchFn(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "averray-reference-agent-monitor",
      "x-github-api-version": "2022-11-28",
      ...(cachedEtag ? { "if-none-match": cachedEtag.etag } : {}),
    },
  });

  // 304 Not Modified: resource unchanged since our last read — GitHub does not
  // charge this against the primary rate limit. Serve the cached body.
  if (response.status === 304 && cachedEtag) {
    return cachedEtag.body as T;
  }

  if (!response.ok) {
    if (isRateLimitResponse(response)) {
      const retryAfterMs = rateLimitRetryAfterMs(response, nowMs);
      openRateLimitBreaker(token, retryAfterMs, nowMs);
      throw new GithubRateLimitError(response.status, url, retryAfterMs);
    }
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} for ${url}${text ? `: ${text.slice(0, 180)}` : ""}`);
  }

  const body = await response.json() as T;
  const etag = response.headers.get("etag");
  if (etag) rememberEtag(url, etag, body);
  return body;
}

function parseGithubRepos(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GITHUB_HELPER_REPOS ?? env.GITHUB_DEFAULT_REPO ?? env.GITHUB_REPOSITORY ?? "";
  return [...new Set(raw.split(",").map(normalizeRepo).filter((repo): repo is string => Boolean(repo)))];
}

function normalizeRepo(value: string): string | undefined {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo) return undefined;
  return `${owner}/${repo}`;
}

function encodeRepoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "20", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(50, parsed));
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inferTouchedArea(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("secret") || p.endsWith(".env") || p.includes(".env.")) return "secrets";
  if (p.startsWith("contracts/") || p.endsWith(".sol")) return "contracts";
  if (p.startsWith("indexer/")) return "indexer";
  if (p.includes("xcm") || p.includes("settlement") || p.includes("escrow") || p.includes("claim") || p.includes("submit")) return "settlement";
  if (p.startsWith("mcp-server/") || p.startsWith("backend/") || p.startsWith("services/") || p.startsWith("packages/")) return "backend";
  if (p.startsWith("app/") || p.startsWith("frontend/") || p.endsWith(".tsx") || p.endsWith(".jsx")) return "frontend";
  if (p.startsWith("ops/") || p.startsWith(".github/") || p.startsWith("scripts/") || p.includes("docker") || p.includes("compose")) return "ops";
  if (p.startsWith("docs/") || p.endsWith(".md")) return "docs";
  if (isTestFile(path)) return "tests";
  if (/package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|bun\.lockb$/i.test(p)) return "dependencies";
  return "other";
}

function highRiskForFile(path: string): "high" | "medium" | "low" {
  const p = path.toLowerCase();
  if (p.includes("secret") || p.endsWith(".env") || p.includes(".env.") || p.includes("migration") || p.startsWith("contracts/") || p.endsWith(".sol")) return "high";
  const area = inferTouchedArea(path);
  if (["ops", "indexer", "settlement", "backend", "dependencies"].includes(area)) return "medium";
  return "low";
}

function isTestFile(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes("/test/") || p.includes("/tests/") || p.endsWith(".test.ts") || p.endsWith(".test.tsx") || p.endsWith(".spec.ts") || p.endsWith(".spec.tsx");
}

function needsMatchingTestSignal(area: string): boolean {
  return ["backend", "frontend", "indexer", "contracts", "settlement"].includes(area);
}

function hasTestSignalForArea(area: string, testSignals: string[]): boolean {
  const text = testSignals.join(" ").toLowerCase();
  if (!text) return false;
  if (area === "contracts") return /forge|solidity|contract/.test(text);
  if (area === "frontend") return /frontend|app|react|tsx|build/.test(text);
  if (area === "backend") return /backend|node|test|mcp|server/.test(text);
  if (area === "indexer") return /indexer|ponder|typecheck/.test(text);
  if (area === "settlement") return /settlement|xcm|claim|submit|backend|node|test/.test(text);
  return /test|check|typecheck|build/.test(text);
}

function normalize(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function resolveGithubTokenForRepo(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return env.GITHUB_TOKEN?.trim() || undefined;
  const repoToken = parseTokenMap(env.GITHUB_REPO_TOKENS).get(`${owner}/${name}`);
  const ownerToken = parseTokenMap(env.GITHUB_OWNER_TOKENS).get(owner);
  const envRepoToken = env[`GITHUB_TOKEN_${toEnvKey(owner)}_${toEnvKey(name)}`]?.trim();
  const envOwnerToken = env[`GITHUB_TOKEN_${toEnvKey(owner)}`]?.trim();
  return repoToken
    ?? ownerToken
    ?? envRepoToken
    ?? envOwnerToken
    ?? env.GITHUB_TOKEN?.trim()
    ?? undefined;
}

function parseTokenMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? "").split(/[\n,;]+/)) {
    const [rawKey, ...rest] = entry.split("=");
    const key = rawKey?.trim();
    const token = rest.join("=").trim();
    if (key && token) map.set(key, token);
  }
  return map;
}

function prKey(repo: string, pullRequestNumber: number): string {
  return `${repo}#${pullRequestNumber}`;
}

function toEnvKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
