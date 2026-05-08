export type GithubOperatorView = "status" | "prs" | "ci" | "issues" | "digest";
export type GithubBriefSection = "changed" | "merged" | "deployed" | "failed" | "attention";

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

export interface GithubBriefItem {
  kind: "pull_request" | "issue" | "workflow_run" | "warning" | "repo";
  section: GithubBriefSection;
  repo?: string;
  title: string;
  detail?: string;
  url?: string;
  occurredAt?: string;
  severity?: "info" | "attention" | "blocked";
}

export interface GithubOperatorBrief {
  schemaVersion: 1;
  generatedAt: string;
  mutatesGithub: false;
  persistsLocalSnapshot: boolean;
  configured: boolean;
  authConfigured: boolean;
  health: "ok" | "attention" | "degraded";
  repoCount: number;
  since?: string;
  isFirstBrief: boolean;
  summary: {
    changed: number;
    merged: number;
    deployed: number;
    failed: number;
    attention: number;
  };
  sections: Record<GithubBriefSection, GithubBriefItem[]>;
  warnings: GithubWarning[];
  recommendations: string[];
}

export interface GithubOperatorStatusOptions {
  view?: GithubOperatorView;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface GithubOperatorBriefOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
  query?: GithubBriefQueryFn;
}

type GithubBriefQueryFn = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[]
) => Promise<T[]>;

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
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  state?: string;
}

interface GithubApiIssue {
  number?: number;
  title?: string;
  html_url?: string;
  user?: GithubApiUser | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
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
  created_at?: string;
  updated_at?: string;
}

interface GithubBriefSnapshot {
  generatedAt?: string;
  repos?: string[];
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

export async function getGithubOperatorBrief(
  options: GithubOperatorBriefOptions = {}
): Promise<GithubOperatorBrief> {
  const env = options.env ?? process.env;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const repos = parseGithubRepos(env);
  const tokenConfig = buildGithubTokenConfig(env);
  const warnings: GithubWarning[] = [];
  const snapshotScope = githubBriefSnapshotScope(repos);

  if (!tokenConfig.hasAnyToken || repos.length === 0) {
    if (!tokenConfig.hasAnyToken) {
      warnings.push({
        severity: "high",
        code: "github_token_missing",
        message: "No GitHub token is configured, so the GitHub brief is unavailable.",
      });
    }
    if (repos.length === 0) {
      warnings.push({
        severity: "high",
        code: "github_repos_missing",
        message: "Set GITHUB_HELPER_REPOS or GITHUB_DEFAULT_REPO to enable the GitHub brief.",
      });
    }
    return emptyBrief({
      generatedAt,
      authConfigured: tokenConfig.hasAnyToken,
      configured: false,
      warnings,
      persistsLocalSnapshot: false,
    });
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

  const previousSnapshot = await readGithubBriefSnapshot(options.query, snapshotScope, warnings);
  const since = previousSnapshot?.generatedAt;
  const repoResults = await Promise.all(
    repoInputs.map(({ repo, token }) => collectRepoBrief({ repo, baseUrl, token, limit, fetchFn }))
  );

  const allOpenPrs: GithubPullRequestItem[] = [];
  const allMergedPrs: GithubPullRequestItem[] = [];
  const allOpenIssues: GithubIssueItem[] = [];
  const allClosedIssues: GithubIssueItem[] = [];
  const allRuns: GithubWorkflowRunItem[] = [];
  const repositories: GithubRepositoryStatus[] = [];

  for (const result of repoResults) {
    warnings.push(...result.warnings);
    if (result.status) repositories.push(result.status);
    allOpenPrs.push(...result.openPullRequests);
    allMergedPrs.push(...result.mergedPullRequests);
    allOpenIssues.push(...result.openIssues);
    allClosedIssues.push(...result.closedIssues);
    allRuns.push(...result.workflowRuns);
  }

  const sections = buildGithubBriefSections({
    since,
    warnings,
    openPullRequests: allOpenPrs,
    mergedPullRequests: allMergedPrs,
    openIssues: allOpenIssues,
    closedIssues: allClosedIssues,
    workflowRuns: allRuns,
  });
  const summary = {
    changed: sections.changed.length,
    merged: sections.merged.length,
    deployed: sections.deployed.length,
    failed: sections.failed.length,
    attention: sections.attention.length,
  };
  const health = warnings.some((warning) => warning.severity === "high")
    ? "degraded"
    : summary.failed > 0 || summary.attention > 0
      ? "attention"
      : "ok";

  const snapshotSaved = await writeGithubBriefSnapshot(options.query, snapshotScope, {
    generatedAt,
    repos,
  }, warnings);

  return {
    schemaVersion: 1,
    generatedAt,
    mutatesGithub: false,
    persistsLocalSnapshot: snapshotSaved,
    configured: repoInputs.length > 0,
    authConfigured: true,
    health,
    repoCount: repositories.length,
    ...(since ? { since } : {}),
    isFirstBrief: !since,
    summary,
    sections,
    warnings,
    recommendations: buildGithubBriefRecommendations({ health, summary, isFirstBrief: !since }),
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

function emptyBrief(input: {
  generatedAt: string;
  authConfigured: boolean;
  configured: boolean;
  warnings: GithubWarning[];
  persistsLocalSnapshot: boolean;
}): GithubOperatorBrief {
  const attention = input.warnings.map((warning): GithubBriefItem => ({
    kind: "warning",
    section: "attention",
    severity: warning.severity === "high" ? "blocked" : "attention",
    repo: warning.repo,
    title: warning.message,
    detail: warning.code,
  }));
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mutatesGithub: false,
    persistsLocalSnapshot: input.persistsLocalSnapshot,
    configured: input.configured,
    authConfigured: input.authConfigured,
    health: "degraded",
    repoCount: 0,
    isFirstBrief: true,
    summary: {
      changed: 0,
      merged: 0,
      deployed: 0,
      failed: 0,
      attention: attention.length,
    },
    sections: {
      changed: [],
      merged: [],
      deployed: [],
      failed: [],
      attention,
    },
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

async function collectRepoBrief(input: {
  repo: string;
  baseUrl: string;
  token: string;
  limit: number;
  fetchFn: typeof fetch;
}): Promise<{
  status?: GithubRepositoryStatus;
  openPullRequests: GithubPullRequestItem[];
  mergedPullRequests: GithubPullRequestItem[];
  openIssues: GithubIssueItem[];
  closedIssues: GithubIssueItem[];
  workflowRuns: GithubWorkflowRunItem[];
  warnings: GithubWarning[];
}> {
  const warnings: GithubWarning[] = [];
  const repoPath = encodeRepoPath(input.repo);
  try {
    const [repo, openPulls, closedPulls, openIssues, closedIssues, runs] = await Promise.all([
      githubGet<GithubApiRepo>(`${input.baseUrl}/repos/${repoPath}`, input.token, input.fetchFn),
      githubGet<GithubApiPullRequest[]>(
        `${input.baseUrl}/repos/${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=${input.limit}`,
        input.token,
        input.fetchFn
      ),
      githubGet<GithubApiPullRequest[]>(
        `${input.baseUrl}/repos/${repoPath}/pulls?state=closed&sort=updated&direction=desc&per_page=${input.limit}`,
        input.token,
        input.fetchFn
      ),
      githubGet<GithubApiIssue[]>(
        `${input.baseUrl}/repos/${repoPath}/issues?state=open&sort=updated&direction=desc&per_page=${input.limit * 2}`,
        input.token,
        input.fetchFn
      ),
      githubGet<GithubApiIssue[]>(
        `${input.baseUrl}/repos/${repoPath}/issues?state=closed&sort=updated&direction=desc&per_page=${input.limit * 2}`,
        input.token,
        input.fetchFn
      ),
      githubGet<{ workflow_runs?: GithubApiWorkflowRun[] }>(
        `${input.baseUrl}/repos/${repoPath}/actions/runs?per_page=${input.limit}`,
        input.token,
        input.fetchFn
      ),
    ]);
    const openPullRequestItems = mapPullRequests(openPulls, input.repo, input.limit);
    const mergedPullRequestItems = mapPullRequests(
      closedPulls.filter((pull) => Boolean(pull.merged_at)),
      input.repo,
      input.limit
    );
    const openIssueItems = mapIssues(openIssues, input.repo, input.limit);
    const closedIssueItems = mapIssues(closedIssues, input.repo, input.limit);
    const workflowRuns = mapWorkflowRuns(runs.workflow_runs ?? [], input.repo, input.limit);

    return {
      status: {
        repo: input.repo,
        defaultBranch: repo.default_branch,
        private: repo.private,
        openPullRequests: openPullRequestItems.length,
        openIssues: openIssueItems.length,
        failingWorkflowRuns: workflowRuns.filter((run) => isFailedRun(run)).length,
        activeWorkflowRuns: workflowRuns.filter((run) => run.status !== "completed").length,
        url: repo.html_url,
      },
      openPullRequests: openPullRequestItems,
      mergedPullRequests: mergedPullRequestItems,
      openIssues: openIssueItems,
      closedIssues: closedIssueItems,
      workflowRuns,
      warnings,
    };
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_repo_fetch_failed",
      repo: input.repo,
      message: error instanceof Error ? error.message : `Failed to fetch ${input.repo}`,
    });
    return {
      openPullRequests: [],
      mergedPullRequests: [],
      openIssues: [],
      closedIssues: [],
      workflowRuns: [],
      warnings,
    };
  }
}

function mapPullRequests(pulls: GithubApiPullRequest[], repo: string, limit: number): GithubPullRequestItem[] {
  return pulls.slice(0, limit).map((pull) => ({
    kind: "pull_request" as const,
    repo,
    number: numberField(pull.number),
    title: pull.title ?? "Untitled pull request",
    url: pull.html_url,
    author: pull.user?.login,
    draft: pull.draft === true,
    updatedAt: pull.merged_at ?? pull.updated_at ?? pull.created_at,
    state: pull.state ?? "open",
  })).filter((pull) => pull.number > 0);
}

function mapIssues(issues: GithubApiIssue[], repo: string, limit: number): GithubIssueItem[] {
  return issues
    .filter((issue) => issue.pull_request === undefined)
    .slice(0, limit)
    .map((issue) => ({
      kind: "issue" as const,
      repo,
      number: numberField(issue.number),
      title: issue.title ?? "Untitled issue",
      url: issue.html_url,
      author: issue.user?.login,
      updatedAt: issue.closed_at ?? issue.updated_at ?? issue.created_at,
      state: issue.state ?? "open",
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((label) => label.name).filter((label): label is string => Boolean(label))
        : [],
    }))
    .filter((issue) => issue.number > 0);
}

function mapWorkflowRuns(runs: GithubApiWorkflowRun[], repo: string, limit: number): GithubWorkflowRunItem[] {
  return runs.slice(0, limit).map((run) => ({
    kind: "workflow_run" as const,
    repo,
    id: numberField(run.id),
    name: run.name ?? "Unnamed workflow",
    status: run.status ?? "unknown",
    ...(run.conclusion ? { conclusion: run.conclusion } : {}),
    ...(run.head_branch ? { branch: run.head_branch } : {}),
    ...(run.event ? { event: run.event } : {}),
    ...(run.html_url ? { url: run.html_url } : {}),
    ...(run.updated_at ?? run.created_at ? { updatedAt: run.updated_at ?? run.created_at } : {}),
  })).filter((run) => run.id > 0);
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

function buildGithubBriefSections(input: {
  since?: string;
  warnings: GithubWarning[];
  openPullRequests: GithubPullRequestItem[];
  mergedPullRequests: GithubPullRequestItem[];
  openIssues: GithubIssueItem[];
  closedIssues: GithubIssueItem[];
  workflowRuns: GithubWorkflowRunItem[];
}): Record<GithubBriefSection, GithubBriefItem[]> {
  const afterSince = (value: string | undefined) => !input.since || isAfter(value, input.since);
  const changed: GithubBriefItem[] = [
    ...input.openPullRequests
      .filter((pr) => afterSince(pr.updatedAt))
      .map((pr) => briefItemFromPullRequest(pr, "changed", input.since ? "Opened or updated PR" : "Open PR")),
    ...input.openIssues
      .filter((issue) => afterSince(issue.updatedAt))
      .map((issue) => briefItemFromIssue(issue, "changed", input.since ? "Opened or updated issue" : "Open issue")),
    ...input.closedIssues
      .filter((issue) => afterSince(issue.updatedAt))
      .map((issue) => briefItemFromIssue(issue, "changed", "Closed issue")),
  ];
  const merged = input.mergedPullRequests
    .filter((pr) => afterSince(pr.updatedAt))
    .map((pr) => briefItemFromPullRequest(pr, "merged", "Merged PR"));
  const deployed = input.workflowRuns
    .filter((run) => run.status === "completed" && run.conclusion === "success" && isDeploymentRun(run) && afterSince(run.updatedAt))
    .map((run) => briefItemFromWorkflowRun(run, "deployed", "Successful deploy/publish workflow"));
  const failed = input.workflowRuns
    .filter((run) => isFailedRun(run) && afterSince(run.updatedAt))
    .map((run) => briefItemFromWorkflowRun(run, "failed", `Workflow ${run.conclusion ?? run.status}`));
  const attention: GithubBriefItem[] = [
    ...input.warnings.map((warning): GithubBriefItem => ({
      kind: "warning",
      section: "attention",
      severity: warning.severity === "high" ? "blocked" : "attention",
      repo: warning.repo,
      title: warning.message,
      detail: warning.code,
    })),
    ...input.openPullRequests
      .filter((pr) => !pr.draft)
      .map((pr) => briefItemFromPullRequest(pr, "attention", "Open PR needs review/merge decision")),
    ...input.workflowRuns
      .filter((run) => isFailedRun(run))
      .map((run) => briefItemFromWorkflowRun(run, "attention", `Failed workflow needs attention (${run.conclusion ?? run.status})`)),
    ...input.workflowRuns
      .filter((run) => run.status !== "completed")
      .map((run) => briefItemFromWorkflowRun(run, "attention", `Workflow still ${run.status}`)),
    ...input.openIssues
      .map((issue) => briefItemFromIssue(issue, "attention", "Open issue")),
  ];

  return {
    changed: sortBriefItems(changed).slice(0, 10),
    merged: sortBriefItems(merged).slice(0, 10),
    deployed: sortBriefItems(deployed).slice(0, 10),
    failed: sortBriefItems(failed).slice(0, 10),
    attention: sortBriefItems(attention).slice(0, 10),
  };
}

function briefItemFromPullRequest(
  pr: GithubPullRequestItem,
  section: GithubBriefSection,
  detail: string
): GithubBriefItem {
  return {
    kind: "pull_request",
    section,
    severity: section === "failed" ? "blocked" : section === "attention" ? "attention" : "info",
    repo: pr.repo,
    title: `PR #${pr.number}: ${pr.title}`,
    detail: pr.draft ? `${detail} (draft)` : detail,
    url: pr.url,
    occurredAt: pr.updatedAt,
  };
}

function briefItemFromIssue(
  issue: GithubIssueItem,
  section: GithubBriefSection,
  detail: string
): GithubBriefItem {
  return {
    kind: "issue",
    section,
    severity: section === "attention" ? "attention" : "info",
    repo: issue.repo,
    title: `Issue #${issue.number}: ${issue.title}`,
    detail: issue.labels.length > 0 ? `${detail}; labels: ${issue.labels.join(", ")}` : detail,
    url: issue.url,
    occurredAt: issue.updatedAt,
  };
}

function briefItemFromWorkflowRun(
  run: GithubWorkflowRunItem,
  section: GithubBriefSection,
  detail: string
): GithubBriefItem {
  return {
    kind: "workflow_run",
    section,
    severity: section === "failed" ? "blocked" : section === "attention" ? "attention" : "info",
    repo: run.repo,
    title: run.name,
    detail: [detail, run.branch ? `branch ${run.branch}` : undefined, run.event ? `event ${run.event}` : undefined]
      .filter(Boolean)
      .join("; "),
    url: run.url,
    occurredAt: run.updatedAt,
  };
}

function sortBriefItems(items: GithubBriefItem[]): GithubBriefItem[] {
  return [...items].sort((a, b) => timestampMs(b.occurredAt) - timestampMs(a.occurredAt));
}

function buildGithubBriefRecommendations(input: {
  health: GithubOperatorBrief["health"];
  summary: GithubOperatorBrief["summary"];
  isFirstBrief: boolean;
}): string[] {
  const recommendations: string[] = [];
  if (input.isFirstBrief) recommendations.push("Baseline saved. The next `github brief` will report changes since this checkpoint.");
  if (input.summary.failed > 0) recommendations.push("Start with failed workflow runs before merging or deploying more work.");
  if (input.summary.attention > 0) recommendations.push("Review the attention section for open PRs, active CI, issues, or setup warnings.");
  if (input.summary.deployed > 0) recommendations.push("Check deploy outputs if any production-facing workflow changed.");
  if (recommendations.length === 0 && input.health === "ok") recommendations.push("No GitHub changes need attention since the last brief.");
  return recommendations;
}

function isFailedRun(run: GithubWorkflowRunItem): boolean {
  return run.conclusion === "failure"
    || run.conclusion === "cancelled"
    || run.conclusion === "timed_out"
    || run.conclusion === "action_required";
}

function isDeploymentRun(run: GithubWorkflowRunItem): boolean {
  const text = `${run.name} ${run.event ?? ""} ${run.branch ?? ""}`.toLowerCase();
  return /\b(deploy|publish|release|production|discovery manifest)\b/.test(text);
}

function isAfter(value: string | undefined, since: string): boolean {
  const valueMs = timestampMs(value);
  const sinceMs = timestampMs(since);
  return valueMs > 0 && sinceMs > 0 && valueMs > sinceMs;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function githubBriefSnapshotScope(repos: string[]): string {
  return `github_brief:${repos.length > 0 ? [...repos].sort().join(",") : "unconfigured"}`;
}

async function readGithubBriefSnapshot(
  query: GithubBriefQueryFn | undefined,
  scope: string,
  warnings: GithubWarning[]
): Promise<GithubBriefSnapshot | undefined> {
  if (!query) return undefined;
  try {
    const rows = await query<{ value?: unknown }>(
      "select value from operator_state_snapshots where scope = $1 limit 1",
      [scope]
    );
    const value = rows[0]?.value;
    return toGithubBriefSnapshot(value);
  } catch (error) {
    warnings.push({
      severity: "medium",
      code: "github_brief_snapshot_read_failed",
      message: error instanceof Error ? error.message : "Failed to read the previous GitHub brief snapshot.",
    });
    return undefined;
  }
}

async function writeGithubBriefSnapshot(
  query: GithubBriefQueryFn | undefined,
  scope: string,
  snapshot: GithubBriefSnapshot,
  warnings: GithubWarning[]
): Promise<boolean> {
  if (!query) return false;
  try {
    await query(
      `insert into operator_state_snapshots(scope, value, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (scope)
       do update set value = excluded.value, updated_at = now()`,
      [scope, JSON.stringify(snapshot)]
    );
    return true;
  } catch (error) {
    warnings.push({
      severity: "medium",
      code: "github_brief_snapshot_write_failed",
      message: error instanceof Error ? error.message : "Failed to save the GitHub brief snapshot.",
    });
    return false;
  }
}

function toGithubBriefSnapshot(value: unknown): GithubBriefSnapshot | undefined {
  const record = typeof value === "string" ? safeJsonRecord(value) : isRecord(value) ? value : undefined;
  if (!record) return undefined;
  const generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : undefined;
  const repos = Array.isArray(record.repos) ? record.repos.map(String) : undefined;
  return { ...(generatedAt ? { generatedAt } : {}), ...(repos ? { repos } : {}) };
}

function safeJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
