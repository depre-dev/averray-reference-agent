export type GithubOperatorView = "status" | "prs" | "ci" | "issues" | "digest";

export interface GithubOperatorStatus {
  schemaVersion: 1;
  generatedAt: string;
  mutates: false;
  configured: boolean;
  authConfigured: boolean;
  view: GithubOperatorView;
  health: "ok" | "attention" | "degraded";
  repoCount: number;
  totals: {
    openPullRequests: number;
    openIssues: number;
    failingWorkflowRuns: number;
    activeWorkflowRuns: number;
  };
  repositories: GithubRepositoryStatus[];
  views: {
    status: GithubStatusItem[];
    prs: GithubPullRequestItem[];
    ci: GithubWorkflowRunItem[];
    issues: GithubIssueItem[];
    digest: GithubDigestItem[];
  };
  selectedView: {
    name: GithubOperatorView;
    items: Array<GithubStatusItem | GithubPullRequestItem | GithubWorkflowRunItem | GithubIssueItem | GithubDigestItem>;
  };
  warnings: GithubWarning[];
  recommendations: string[];
}

export interface GithubRepositoryStatus {
  repo: string;
  defaultBranch?: string;
  private?: boolean;
  openPullRequests: number;
  openIssues: number;
  failingWorkflowRuns: number;
  activeWorkflowRuns: number;
  url?: string;
}

export interface GithubStatusItem extends GithubRepositoryStatus {
  kind: "repo_status";
}

export interface GithubPullRequestItem {
  kind: "pull_request";
  repo: string;
  number: number;
  title: string;
  url?: string;
  author?: string;
  draft: boolean;
  updatedAt?: string;
  state: string;
}

export interface GithubIssueItem {
  kind: "issue";
  repo: string;
  number: number;
  title: string;
  url?: string;
  author?: string;
  updatedAt?: string;
  labels: string[];
  state: string;
}

export interface GithubWorkflowRunItem {
  kind: "workflow_run";
  repo: string;
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  branch?: string;
  event?: string;
  url?: string;
  updatedAt?: string;
}

export interface GithubDigestItem {
  kind: "digest_item";
  severity: "info" | "attention" | "blocked";
  repo?: string;
  title: string;
  detail?: string;
  url?: string;
}

export interface GithubWarning {
  severity: "low" | "medium" | "high";
  code: string;
  message: string;
  repo?: string;
}

export interface GithubOperatorStatusOptions {
  view?: GithubOperatorView;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
}

interface GithubApiRepo {
  full_name?: string;
  default_branch?: string;
  private?: boolean;
  html_url?: string;
  open_issues_count?: number;
}

interface GithubApiUser {
  login?: string;
}

interface GithubApiPullRequest {
  number?: number;
  title?: string;
  html_url?: string;
  user?: GithubApiUser | null;
  draft?: boolean;
  updated_at?: string;
  state?: string;
}

interface GithubApiIssue {
  number?: number;
  title?: string;
  html_url?: string;
  user?: GithubApiUser | null;
  updated_at?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  pull_request?: unknown;
}

interface GithubApiWorkflowRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string | null;
  event?: string;
  html_url?: string;
  updated_at?: string;
}

export async function getGithubOperatorStatus(
  options: GithubOperatorStatusOptions = {}
): Promise<GithubOperatorStatus> {
  const env = options.env ?? process.env;
  const view = options.view ?? "status";
  const generatedAt = (options.now ?? new Date()).toISOString();
  const repos = parseGithubRepos(env);
  const tokenConfig = buildGithubTokenConfig(env);
  const warnings: GithubWarning[] = [];

  if (!tokenConfig.hasAnyToken || repos.length === 0) {
    if (!tokenConfig.hasAnyToken) {
      warnings.push({
        severity: "high",
        code: "github_token_missing",
        message: "No GitHub token is configured, so GitHub status is unavailable.",
      });
    }
    if (repos.length === 0) {
      warnings.push({
        severity: "high",
        code: "github_repos_missing",
        message: "Set GITHUB_HELPER_REPOS or GITHUB_DEFAULT_REPO to enable GitHub status.",
      });
    }
    return emptyStatus({ generatedAt, view, authConfigured: tokenConfig.hasAnyToken, warnings });
  }

  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
  const limit = clampLimit(env.GITHUB_HELPER_LIMIT);
  const repoInputs = repos.flatMap((repo) => {
    const token = resolveGithubTokenForRepo(repo, tokenConfig);
    if (!token) {
      warnings.push({
        severity: "high",
        code: "github_repo_token_missing",
        repo,
        message: `No GitHub token is configured for ${repo}.`,
      });
      return [];
    }
    return [{ repo, token }];
  });
  const repoResults = await Promise.all(
    repoInputs.map(({ repo, token }) => collectRepoStatus({ repo, baseUrl, token, limit, fetchFn }))
  );

  const repositoryStatuses: GithubRepositoryStatus[] = [];
  const prs: GithubPullRequestItem[] = [];
  const issues: GithubIssueItem[] = [];
  const ci: GithubWorkflowRunItem[] = [];

  for (const result of repoResults) {
    warnings.push(...result.warnings);
    if (result.status) repositoryStatuses.push(result.status);
    prs.push(...result.prs);
    issues.push(...result.issues);
    ci.push(...result.ci);
  }

  const failingWorkflowRuns = ci.filter((run) => run.conclusion === "failure" || run.conclusion === "cancelled").length;
  const activeWorkflowRuns = ci.filter((run) => run.status !== "completed").length;
  const statusItems = repositoryStatuses.map((status): GithubStatusItem => ({ ...status, kind: "repo_status" }));
  const digest = buildDigest({ repositories: repositoryStatuses, prs, issues, ci, warnings });
  const totals = {
    openPullRequests: prs.length,
    openIssues: issues.length,
    failingWorkflowRuns,
    activeWorkflowRuns,
  };
  const health = warnings.some((warning) => warning.severity === "high")
    ? "degraded"
    : failingWorkflowRuns > 0 || activeWorkflowRuns > 0 || prs.length > 0 || issues.length > 0
      ? "attention"
      : "ok";

  return {
    schemaVersion: 1,
    generatedAt,
    mutates: false,
    configured: repoInputs.length > 0,
    authConfigured: true,
    view,
    health,
    repoCount: repositoryStatuses.length,
    totals,
    repositories: repositoryStatuses,
    views: {
      status: statusItems,
      prs,
      ci,
      issues,
      digest,
    },
    selectedView: {
      name: view,
      items: selectView({ view, status: statusItems, prs, ci, issues, digest }),
    },
    warnings,
    recommendations: buildRecommendations({ health, totals, repoCount: repositoryStatuses.length }),
  };
}

function emptyStatus(input: {
  generatedAt: string;
  view: GithubOperatorView;
  authConfigured: boolean;
  warnings: GithubWarning[];
}): GithubOperatorStatus {
  const digest = input.warnings.map((warning): GithubDigestItem => ({
    kind: "digest_item",
    severity: warning.severity === "high" ? "blocked" : "attention",
    title: warning.message,
    detail: warning.code,
  }));
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mutates: false,
    configured: false,
    authConfigured: input.authConfigured,
    view: input.view,
    health: "degraded",
    repoCount: 0,
    totals: {
      openPullRequests: 0,
      openIssues: 0,
      failingWorkflowRuns: 0,
      activeWorkflowRuns: 0,
    },
    repositories: [],
    views: {
      status: [],
      prs: [],
      ci: [],
      issues: [],
      digest,
    },
    selectedView: { name: input.view, items: input.view === "digest" ? digest : [] },
    warnings: input.warnings,
    recommendations: [
      "Set GITHUB_TOKEN with read-only access to all target repositories, or use owner/repo token maps.",
      "Set GITHUB_DEFAULT_REPO=owner/repo or GITHUB_HELPER_REPOS=owner/repo,owner/repo.",
    ],
  };
}

interface GithubTokenConfig {
  globalToken?: string;
  ownerTokens: Map<string, string>;
  repoTokens: Map<string, string>;
  envTokens: NodeJS.ProcessEnv;
  hasAnyToken: boolean;
}

function buildGithubTokenConfig(env: NodeJS.ProcessEnv): GithubTokenConfig {
  const globalToken = env.GITHUB_TOKEN?.trim();
  const ownerTokens = parseGithubTokenMap(env.GITHUB_OWNER_TOKENS, "owner");
  const repoTokens = parseGithubTokenMap(env.GITHUB_REPO_TOKENS, "repo");
  const hasAnyToken = Boolean(globalToken) || ownerTokens.size > 0 || repoTokens.size > 0 || hasGithubTokenEnv(env);
  return {
    ...(globalToken ? { globalToken } : {}),
    ownerTokens,
    repoTokens,
    envTokens: env,
    hasAnyToken,
  };
}

function resolveGithubTokenForRepo(repo: string, config: GithubTokenConfig): string | undefined {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return config.globalToken;

  const repoKey = `${owner}/${name}`;
  const envRepoToken = config.envTokens[`GITHUB_TOKEN_${toEnvKey(owner)}_${toEnvKey(name)}`]?.trim();
  const envOwnerToken = config.envTokens[`GITHUB_TOKEN_${toEnvKey(owner)}`]?.trim();

  return config.repoTokens.get(repoKey)
    ?? config.ownerTokens.get(owner)
    ?? envRepoToken
    ?? envOwnerToken
    ?? config.globalToken;
}

function parseGithubTokenMap(value: string | undefined, mode: "owner" | "repo"): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? "").split(/[\n,;]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes("=") ? "=" : ":";
    const separatorIndex = trimmed.indexOf(separator);
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const token = trimmed.slice(separatorIndex + 1).trim();
    if (!token) continue;
    const normalizedKey = mode === "repo" ? normalizeRepo(key) : normalizeOwner(key);
    if (normalizedKey) map.set(normalizedKey, token);
  }
  return map;
}

function hasGithubTokenEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => key.startsWith("GITHUB_TOKEN_") && Boolean(value?.trim()));
}

async function collectRepoStatus(input: {
  repo: string;
  baseUrl: string;
  token: string;
  limit: number;
  fetchFn: typeof fetch;
}): Promise<{
  status?: GithubRepositoryStatus;
  prs: GithubPullRequestItem[];
  issues: GithubIssueItem[];
  ci: GithubWorkflowRunItem[];
  warnings: GithubWarning[];
}> {
  const warnings: GithubWarning[] = [];
  const repoPath = encodeRepoPath(input.repo);
  try {
    const [repo, pulls, issues, runs] = await Promise.all([
      githubGet<GithubApiRepo>(`${input.baseUrl}/repos/${repoPath}`, input.token, input.fetchFn),
      githubGet<GithubApiPullRequest[]>(
        `${input.baseUrl}/repos/${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=${input.limit}`,
        input.token,
        input.fetchFn
      ),
      githubGet<GithubApiIssue[]>(
        `${input.baseUrl}/repos/${repoPath}/issues?state=open&sort=updated&direction=desc&per_page=${input.limit * 2}`,
        input.token,
        input.fetchFn
      ),
      githubGet<{ workflow_runs?: GithubApiWorkflowRun[] }>(
        `${input.baseUrl}/repos/${repoPath}/actions/runs?per_page=${input.limit}`,
        input.token,
        input.fetchFn
      ),
    ]);

    const pullItems = pulls.slice(0, input.limit).map((pull) => ({
      kind: "pull_request" as const,
      repo: input.repo,
      number: numberField(pull.number),
      title: pull.title ?? "Untitled pull request",
      url: pull.html_url,
      author: pull.user?.login,
      draft: pull.draft === true,
      updatedAt: pull.updated_at,
      state: pull.state ?? "open",
    })).filter((pull) => pull.number > 0);

    const issueItems = issues
      .filter((issue) => issue.pull_request === undefined)
      .slice(0, input.limit)
      .map((issue) => ({
        kind: "issue" as const,
        repo: input.repo,
        number: numberField(issue.number),
        title: issue.title ?? "Untitled issue",
        url: issue.html_url,
        author: issue.user?.login,
        updatedAt: issue.updated_at,
        state: issue.state ?? "open",
        labels: Array.isArray(issue.labels)
          ? issue.labels.map((label) => label.name).filter((label): label is string => Boolean(label))
          : [],
      }))
      .filter((issue) => issue.number > 0);

    const ciItems = (runs.workflow_runs ?? []).slice(0, input.limit).map((run) => ({
      kind: "workflow_run" as const,
      repo: input.repo,
      id: numberField(run.id),
      name: run.name ?? "Unnamed workflow",
      status: run.status ?? "unknown",
      ...(run.conclusion ? { conclusion: run.conclusion } : {}),
      ...(run.head_branch ? { branch: run.head_branch } : {}),
      ...(run.event ? { event: run.event } : {}),
      ...(run.html_url ? { url: run.html_url } : {}),
      ...(run.updated_at ? { updatedAt: run.updated_at } : {}),
    })).filter((run) => run.id > 0);

    return {
      status: {
        repo: input.repo,
        defaultBranch: repo.default_branch,
        private: repo.private,
        openPullRequests: pullItems.length,
        openIssues: issueItems.length,
        failingWorkflowRuns: ciItems.filter((run) => run.conclusion === "failure" || run.conclusion === "cancelled").length,
        activeWorkflowRuns: ciItems.filter((run) => run.status !== "completed").length,
        url: repo.html_url,
      },
      prs: pullItems,
      issues: issueItems,
      ci: ciItems,
      warnings,
    };
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_repo_fetch_failed",
      repo: input.repo,
      message: error instanceof Error ? error.message : `Failed to fetch ${input.repo}`,
    });
    return { prs: [], issues: [], ci: [], warnings };
  }
}

async function githubGet<T>(url: string, token: string, fetchFn: typeof fetch): Promise<T> {
  const response = await fetchFn(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "averray-reference-agent-github-helper",
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
  const repos = raw.split(",")
    .map((entry) => normalizeRepo(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(repos)];
}

function normalizeRepo(value: string): string | undefined {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo) return undefined;
  return `${owner}/${repo}`;
}

function normalizeOwner(value: string): string | undefined {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/^\/+|\/+$/g, "");
  const [owner] = trimmed.split("/");
  return owner || undefined;
}

function toEnvKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function encodeRepoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "5", 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(20, parsed));
}

function buildDigest(input: {
  repositories: GithubRepositoryStatus[];
  prs: GithubPullRequestItem[];
  issues: GithubIssueItem[];
  ci: GithubWorkflowRunItem[];
  warnings: GithubWarning[];
}): GithubDigestItem[] {
  const items: GithubDigestItem[] = [];
  for (const warning of input.warnings) {
    items.push({
      kind: "digest_item",
      severity: warning.severity === "high" ? "blocked" : "attention",
      repo: warning.repo,
      title: warning.message,
      detail: warning.code,
    });
  }
  for (const run of input.ci.filter((entry) => entry.conclusion === "failure" || entry.conclusion === "cancelled")) {
    items.push({
      kind: "digest_item",
      severity: "blocked",
      repo: run.repo,
      title: `CI ${run.conclusion}: ${run.name}`,
      detail: run.branch ? `branch ${run.branch}` : undefined,
      url: run.url,
    });
  }
  for (const run of input.ci.filter((entry) => entry.status !== "completed")) {
    items.push({
      kind: "digest_item",
      severity: "attention",
      repo: run.repo,
      title: `CI still ${run.status}: ${run.name}`,
      detail: run.branch ? `branch ${run.branch}` : undefined,
      url: run.url,
    });
  }
  for (const pr of input.prs.slice(0, 5)) {
    items.push({
      kind: "digest_item",
      severity: pr.draft ? "info" : "attention",
      repo: pr.repo,
      title: `PR #${pr.number}: ${pr.title}`,
      detail: pr.draft ? "draft" : "open",
      url: pr.url,
    });
  }
  for (const issue of input.issues.slice(0, 5)) {
    items.push({
      kind: "digest_item",
      severity: "info",
      repo: issue.repo,
      title: `Issue #${issue.number}: ${issue.title}`,
      detail: issue.labels.length > 0 ? issue.labels.join(", ") : undefined,
      url: issue.url,
    });
  }
  if (items.length === 0 && input.repositories.length > 0) {
    items.push({
      kind: "digest_item",
      severity: "info",
      title: "No open GitHub work or failing CI was found for the configured repositories.",
    });
  }
  return items;
}

function buildRecommendations(input: {
  health: GithubOperatorStatus["health"];
  totals: GithubOperatorStatus["totals"];
  repoCount: number;
}): string[] {
  if (input.repoCount === 0) return ["Configure at least one repository before using GitHub status."];
  const recommendations: string[] = [];
  if (input.totals.failingWorkflowRuns > 0) recommendations.push("Start with `github ci failures` and inspect the failing run logs.");
  if (input.totals.openPullRequests > 0) recommendations.push("Use `github open prs` to decide what needs review or merge attention.");
  if (input.totals.openIssues > 0) recommendations.push("Use `github issue digest` to triage open issues.");
  if (recommendations.length === 0 && input.health === "ok") recommendations.push("No GitHub blockers found for the configured repositories.");
  return recommendations;
}

function selectView(input: {
  view: GithubOperatorView;
  status: GithubStatusItem[];
  prs: GithubPullRequestItem[];
  ci: GithubWorkflowRunItem[];
  issues: GithubIssueItem[];
  digest: GithubDigestItem[];
}): GithubOperatorStatus["selectedView"]["items"] {
  if (input.view === "prs") return input.prs;
  if (input.view === "ci") return input.ci;
  if (input.view === "issues") return input.issues;
  if (input.view === "digest") return input.digest;
  return input.status;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
