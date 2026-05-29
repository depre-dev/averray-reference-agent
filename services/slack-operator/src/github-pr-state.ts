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

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: MonitorPullRequestState }>();
const openPullRequestCache = new Map<string, { expiresAt: number; value: MonitorEntry[] }>();

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
  await Promise.all(keys.map(async ({ key, repo, pullRequestNumber }) => {
    const token = resolveGithubTokenForRepo(repo, env);
    if (!token) return;
    const state = await fetchPullRequestState({
      repo,
      pullRequestNumber,
      token,
      fetchFn,
      now,
    }).catch(() => undefined);
    if (state) states.set(key, state);
  }));
  if (states.size === 0 && githubLiveEntries.length === 0) return monitor;

  return {
    ...monitor,
    ...(Array.isArray(monitor.active) ? { active: enrichEntries(monitor.active, states) } : {}),
    recent: mergeGithubLiveEntries(enrichEntries(Array.isArray(monitor.recent) ? monitor.recent : [], states), githubLiveEntries),
  };
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

function enrichEntries(entries: unknown[], states: Map<string, MonitorPullRequestState>): unknown[] {
  return entries.map((entry) => {
    if (!isRecord(entry)) return entry;
    const repo = typeof entry.repo === "string" ? entry.repo : "";
    const pullRequestNumber = typeof entry.pullRequestNumber === "number" ? entry.pullRequestNumber : NaN;
    const state = repo && Number.isFinite(pullRequestNumber) ? states.get(prKey(repo, pullRequestNumber)) : undefined;
    if (!state) return entry;
    const summary = isRecord(entry.summary) ? entry.summary : {};
    return {
      ...entry,
      summary: {
        ...summary,
        currentPullRequest: state,
      },
    };
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

  const response = await input.fetchFn(`https://api.github.com/repos/${input.repo}/pulls/${input.pullRequestNumber}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "user-agent": "averray-reference-agent-monitor",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return undefined;
  const pull: unknown = await response.json();
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
  const results = await Promise.all(repos.map(async (repo) => {
    const token = resolveGithubTokenForRepo(repo, input.env);
    if (!token) return [];
    return fetchRepoOpenPullRequestEntries({ repo, token, limit, baseUrl, fetchFn: input.fetchFn, now: input.now });
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
}): Promise<MonitorEntry[]> {
  const repoPath = encodeRepoPath(input.repo);
  const pulls = await githubGet<GithubApiPullRequest[]>(
    `${input.baseUrl}/repos/${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=${input.limit}`,
    input.token,
    input.fetchFn
  ).catch(() => []);

  const entries = await Promise.all(pulls
    .slice(0, input.limit)
    .map(async (pull) => openPullRequestEntryFromGithub({ repo: input.repo, pull, token: input.token, baseUrl: input.baseUrl, fetchFn: input.fetchFn, now: input.now })));
  return entries.filter((entry): entry is MonitorEntry => Boolean(entry));
}

async function openPullRequestEntryFromGithub(input: {
  repo: string;
  pull: GithubApiPullRequest;
  token: string;
  baseUrl: string;
  fetchFn: typeof fetch;
  now: Date;
}): Promise<MonitorEntry | undefined> {
  const number = numberField(input.pull.number);
  if (number <= 0) return undefined;
  const repoPath = encodeRepoPath(input.repo);
  const headSha = input.pull.head?.sha;
  const [files, checks] = await Promise.all([
    githubGet<GithubApiPullRequestFile[]>(
      `${input.baseUrl}/repos/${repoPath}/pulls/${number}/files?per_page=100`,
      input.token,
      input.fetchFn
    ).catch(() => []),
    headSha
      ? githubGet<{ check_runs?: GithubApiCheckRun[] }>(
        `${input.baseUrl}/repos/${repoPath}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
        input.token,
        input.fetchFn
      ).then((result) => result.check_runs ?? []).catch(() => [])
      : Promise.resolve([]),
  ]);
  const reviewSignals = buildLiveReviewSignals(input.pull, files, checks);
  const checksSummary = summarizeGithubChecks(checks);
  const reviewReasons = liveReviewReasons(input.pull, files, reviewSignals, checksSummary);
  const highSeverity = reviewReasons.some((reason) => reason.severity === "high");
  const mediumSeverity = reviewReasons.some((reason) => reason.severity === "medium");
  const finalVerdict = highSeverity ? "hold" : mediumSeverity ? "needs_review" : "ok_to_merge";
  const mergeRecommendation = highSeverity ? "hold" : mediumSeverity ? "needs_review" : "ok_to_merge";
  const reason = reviewReasons.find((entry) => entry.code !== "pr_review_green")?.code
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
    status: finalVerdict === "hold" ? "blocked" : "completed",
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
      status: finalVerdict === "hold" ? "blocked" : finalVerdict === "needs_review" ? "needs_review" : "completed",
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
  checks: GithubApiCheckRun[]
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
  ];
  const missingTestSignals = touchedAreas.filter((area) => needsMatchingTestSignal(area) && !hasTestSignalForArea(area, testSignals));
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

function summarizeGithubChecks(checks: GithubApiCheckRun[]): {
  total: number;
  passed: number;
  failed: number;
  active: number;
  neutral: number;
} {
  const total = checks.length;
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
  return { total, passed, failed, active, neutral };
}

async function githubGet<T>(url: string, token: string, fetchFn: typeof fetch): Promise<T> {
  const response = await fetchFn(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "averray-reference-agent-monitor",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} for ${url}${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  return await response.json() as T;
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
