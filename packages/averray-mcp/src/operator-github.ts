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

export type GithubPullRequestMergeRecommendation = "ok_to_merge" | "needs_review" | "hold";
export type GithubMergeStewardVerdict = "pass" | "human_review" | "block";

export interface GithubPullRequestReview {
  schemaVersion: 1;
  generatedAt: string;
  mutatesGithub: false;
  configured: boolean;
  authConfigured: boolean;
  repo?: string;
  pullRequestNumber?: number;
  health: "ok" | "attention" | "degraded";
  pullRequest?: {
    repo: string;
    number: number;
    title: string;
    url?: string;
    author?: string;
    state: string;
    draft: boolean;
    baseBranch?: string;
    headBranch?: string;
    headSha?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    mergeableState?: string;
    updatedAt?: string;
  };
  files: {
    total: number;
    highRisk: GithubPullRequestFileRisk[];
    sample: GithubPullRequestFileSummary[];
  };
  checks: {
    total: number;
    passed: number;
    failed: number;
    active: number;
    neutral: number;
    skipped: number;
    sample: GithubPullRequestCheckSummary[];
  };
  review: GithubPullRequestReviewSignals;
  riskFindings: GithubPullRequestRiskFinding[];
  mergeRecommendation: GithubPullRequestMergeRecommendation;
  recommendations: string[];
  warnings: GithubWarning[];
}

export interface GithubMergeStewardItem {
  repo: string;
  pullRequestNumber: number;
  title: string;
  url?: string;
  author?: string;
  finalVerdict: GithubMergeStewardVerdict;
  mergeRecommendation: GithubPullRequestMergeRecommendation;
  reason: string;
  canAutoMergeIfEnabled: boolean;
  checks: {
    total: number;
    passed: number;
    failed: number;
    active: number;
  };
  touchedAreas: GithubPullRequestTouchedArea[];
  testSignals: string[];
  reviewReasons: GithubPullRequestRiskFinding[];
}

export interface GithubMergeSteward {
  schemaVersion: 1;
  generatedAt: string;
  mutatesGithub: false;
  mergeExecutionEnabled: false;
  configured: boolean;
  authConfigured: boolean;
  health: "ok" | "attention" | "degraded";
  repoCount: number;
  counts: {
    openPullRequests: number;
    pass: number;
    humanReview: number;
    block: number;
    autoMergeCandidates: number;
  };
  items: GithubMergeStewardItem[];
  groups: {
    autoMergeCandidates: GithubMergeStewardItem[];
    humanReview: GithubMergeStewardItem[];
    blocked: GithubMergeStewardItem[];
  };
  warnings: GithubWarning[];
  recommendations: string[];
}

export interface GithubMergeStewardApprovalInput {
  repo?: string;
  pullRequestNumber?: number;
  approvalText?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface GithubMergeStewardApproval {
  schemaVersion: 1;
  generatedAt: string;
  mutatesGithub: boolean;
  executionEnabled: boolean;
  configured: boolean;
  authConfigured: boolean;
  status: "merged" | "blocked" | "failed";
  repo?: string;
  pullRequestNumber?: number;
  finalVerdict?: GithubMergeStewardVerdict;
  mergeRecommendation?: GithubPullRequestMergeRecommendation;
  reason: string;
  reviewReasons: GithubPullRequestRiskFinding[];
  merge?: {
    merged?: boolean;
    sha?: string;
    message?: string;
  };
  safety: {
    requiresExplicitCommand: true;
    requiresEnvFlag: true;
    onlyLowRiskDependabot: true;
    githubMutated: boolean;
    wikipediaEdited: false;
  };
  warnings: GithubWarning[];
  recommendations: string[];
}

export interface GithubPullRequestCommentInput {
  repo?: string;
  pullRequestNumber?: number;
  body: string;
  marker?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface GithubPullRequestCommentResult {
  schemaVersion: 1;
  generatedAt: string;
  mutatesGithub: boolean;
  enabled: boolean;
  configured: boolean;
  authConfigured: boolean;
  status: "posted" | "updated" | "skipped" | "failed";
  repo?: string;
  pullRequestNumber?: number;
  commentUrl?: string;
  reason?: string;
  warnings: GithubWarning[];
}

export type GithubPullRequestTouchedArea =
  | "frontend"
  | "backend"
  | "indexer"
  | "contracts"
  | "ops"
  | "deploy"
  | "workflow"
  | "docs"
  | "tests"
  | "dependencies"
  | "config";

export interface GithubPullRequestReviewSignals {
  touchedAreas: GithubPullRequestTouchedArea[];
  testFilesChanged: boolean;
  testSignals: string[];
  missingTestSignals: GithubPullRequestTouchedArea[];
  rolloutNotesRequired: boolean;
  rolloutNotesPresent: boolean;
}

export interface GithubPullRequestFileSummary {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

export interface GithubPullRequestFileRisk extends GithubPullRequestFileSummary {
  risk: "high" | "medium";
  category: "secrets" | "contracts" | "database" | "ops" | "deploy" | "workflow" | "lockfile" | "large_file";
  reason: string;
}

export interface GithubPullRequestCheckSummary {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
}

export interface GithubPullRequestRiskFinding {
  severity: "low" | "medium" | "high";
  code: string;
  message: string;
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

export interface GithubPullRequestReviewOptions {
  repo?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface GithubMergeStewardOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: Date;
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
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable_state?: string | null;
}

interface GithubApiPullRequestFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

interface GithubApiCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
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

interface GithubApiIssueComment {
  id?: number;
  body?: string;
  html_url?: string;
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

export async function getGithubPullRequestReview(
  options: GithubPullRequestReviewOptions = {}
): Promise<GithubPullRequestReview> {
  const env = options.env ?? process.env;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const tokenConfig = buildGithubTokenConfig(env);
  const configuredRepos = parseGithubRepos(env);
  const warnings: GithubWarning[] = [];
  const urlTarget = parsePullRequestUrl(options.pullRequestUrl);
  const repo = normalizeRepo(options.repo ?? urlTarget?.repo ?? (configuredRepos.length === 1 ? configuredRepos[0] : ""));
  const pullRequestNumber = options.pullRequestNumber ?? urlTarget?.pullRequestNumber;

  if (!tokenConfig.hasAnyToken || !repo || !pullRequestNumber) {
    if (!tokenConfig.hasAnyToken) {
      warnings.push({
        severity: "high",
        code: "github_token_missing",
        message: "No GitHub token is configured, so PR handoff review is unavailable.",
      });
    }
    if (!repo) {
      warnings.push({
        severity: "high",
        code: "github_pr_repo_missing",
        message: "Set repo=owner/repo, pass a GitHub pull request URL, or configure exactly one GitHub helper repo.",
      });
    }
    if (!pullRequestNumber) {
      warnings.push({
        severity: "high",
        code: "github_pr_number_missing",
        message: "Set pullRequestNumber or pass a GitHub pull request URL.",
      });
    }
    return emptyPullRequestReview({
      generatedAt,
      authConfigured: tokenConfig.hasAnyToken,
      repo,
      pullRequestNumber,
      warnings,
    });
  }

  const token = resolveGithubTokenForRepo(repo, tokenConfig);
  if (!token) {
    warnings.push({
      severity: "high",
      code: "github_repo_token_missing",
      repo,
      message: `No GitHub token is configured for ${repo}.`,
    });
    return emptyPullRequestReview({
      generatedAt,
      authConfigured: true,
      repo,
      pullRequestNumber,
      warnings,
    });
  }

  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
  const repoPath = encodeRepoPath(repo);

  try {
    const [pullRequest, files] = await Promise.all([
      githubGet<GithubApiPullRequest>(`${baseUrl}/repos/${repoPath}/pulls/${pullRequestNumber}`, token, fetchFn),
      githubGet<GithubApiPullRequestFile[]>(
        `${baseUrl}/repos/${repoPath}/pulls/${pullRequestNumber}/files?per_page=100`,
        token,
        fetchFn
      ),
    ]);
    const headSha = pullRequest.head?.sha;
    const checks = headSha
      ? await readPullRequestChecks({ baseUrl, repoPath, headSha, token, fetchFn, warnings, repo })
      : [];
    const fileSummaries = files.map(fileSummary).filter((file): file is GithubPullRequestFileSummary => Boolean(file));
    const highRiskFiles = fileSummaries
      .map(fileRisk)
      .filter((file): file is GithubPullRequestFileRisk => Boolean(file));
    const checkSummaries = checks.map(checkSummary);
    const checkTotals = summarizeChecks(checkSummaries);
    const pullRequestSummary = summarizePullRequest(repo, pullRequest);
    const reviewSignals = buildPullRequestReviewSignals({
      body: pullRequest.body,
      files: fileSummaries,
      checks: checkSummaries,
    });
    const initialRiskFindings = buildPullRequestRiskFindings({
      pullRequest: pullRequestSummary,
      files: fileSummaries,
      highRiskFiles,
      checks: checkTotals,
      review: reviewSignals,
      warnings,
    });
    const riskFindings = applyDependabotLowRiskPolicy({
      pullRequest: pullRequestSummary,
      files: fileSummaries,
      highRiskFiles,
      checks: checkTotals,
      riskFindings: initialRiskFindings,
    });
    const mergeRecommendation = chooseMergeRecommendation(riskFindings);
    const health = warnings.some((warning) => warning.severity === "high")
      ? "degraded"
      : mergeRecommendation === "ok_to_merge"
        ? "ok"
        : "attention";

    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      configured: true,
      authConfigured: true,
      repo,
      pullRequestNumber,
      health,
      pullRequest: pullRequestSummary,
      files: {
        total: fileSummaries.length,
        highRisk: highRiskFiles.slice(0, 20),
        sample: fileSummaries.slice(0, 20),
      },
      checks: {
        ...checkTotals,
        sample: checkSummaries.slice(0, 20),
      },
      review: reviewSignals,
      riskFindings,
      mergeRecommendation,
      recommendations: buildPullRequestReviewRecommendations({ mergeRecommendation, riskFindings }),
      warnings,
    };
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_pr_fetch_failed",
      repo,
      message: error instanceof Error ? error.message : `Failed to fetch PR #${pullRequestNumber} for ${repo}.`,
    });
    return emptyPullRequestReview({
      generatedAt,
      authConfigured: true,
      repo,
      pullRequestNumber,
      warnings,
    });
  }
}

export async function getGithubMergeSteward(
  options: GithubMergeStewardOptions = {}
): Promise<GithubMergeSteward> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const status = await getGithubOperatorStatus({
    view: "prs",
    env,
    fetchFn: options.fetchFn,
    now,
  });
  const openPullRequests = status.views.prs;

  if (!status.configured || openPullRequests.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      mergeExecutionEnabled: false,
      configured: status.configured,
      authConfigured: status.authConfigured,
      health: status.configured ? "ok" : "degraded",
      repoCount: status.repoCount,
      counts: {
        openPullRequests: openPullRequests.length,
        pass: 0,
        humanReview: 0,
        block: 0,
        autoMergeCandidates: 0,
      },
      items: [],
      groups: {
        autoMergeCandidates: [],
        humanReview: [],
        blocked: [],
      },
      warnings: status.warnings,
      recommendations: status.configured
        ? ["No open PRs need steward review."]
        : status.recommendations,
    };
  }

  const reviews = await Promise.all(
    openPullRequests.map((pullRequest) => getGithubPullRequestReview({
      repo: pullRequest.repo,
      pullRequestNumber: pullRequest.number,
      env,
      fetchFn: options.fetchFn,
      now,
    }))
  );
  const items = reviews.map(stewardItemFromReview);
  const autoMergeCandidates = items.filter((item) => item.canAutoMergeIfEnabled);
  const humanReview = items.filter((item) => item.finalVerdict === "human_review");
  const blocked = items.filter((item) => item.finalVerdict === "block");
  const pass = items.filter((item) => item.finalVerdict === "pass");
  const warnings = [...status.warnings, ...reviews.flatMap((review) => review.warnings)];
  const health = warnings.some((warning) => warning.severity === "high") || blocked.length > 0
    ? "degraded"
    : humanReview.length > 0 || pass.length > 0
      ? "attention"
      : "ok";

  return {
    schemaVersion: 1,
    generatedAt,
    mutatesGithub: false,
    mergeExecutionEnabled: false,
    configured: true,
    authConfigured: status.authConfigured,
    health,
    repoCount: status.repoCount,
    counts: {
      openPullRequests: items.length,
      pass: pass.length,
      humanReview: humanReview.length,
      block: blocked.length,
      autoMergeCandidates: autoMergeCandidates.length,
    },
    items,
    groups: {
      autoMergeCandidates,
      humanReview,
      blocked,
    },
    warnings,
    recommendations: buildMergeStewardRecommendations({ autoMergeCandidates, humanReview, blocked }),
  };
}

export async function approveGithubMergeStewardCandidate(
  options: GithubMergeStewardApprovalInput = {}
): Promise<GithubMergeStewardApproval> {
  const env = options.env ?? process.env;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const repo = normalizeRepo(options.repo ?? "");
  const pullRequestNumber = options.pullRequestNumber;
  const executionEnabled = isTruthy(env.GITHUB_MERGE_STEWARD_EXECUTION_ENABLED);
  const warnings: GithubWarning[] = [];

  if (!repo || !pullRequestNumber) {
    warnings.push({
      severity: "high",
      code: "github_merge_target_missing",
      message: "Set an explicit target like merge steward approve owner/repo#123.",
    });
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      reason: "target_missing",
      warnings,
      recommendations: ["Use `merge steward approve owner/repo#123` with the exact PR target."],
    });
  }

  const review = await getGithubPullRequestReview({
    repo,
    pullRequestNumber,
    env,
    fetchFn: options.fetchFn,
    now: options.now,
  });
  const stewardItem = stewardItemFromReview(review);
  warnings.push(...review.warnings);

  if (!executionEnabled) {
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      review,
      stewardItem,
      reason: "merge_execution_disabled",
      warnings,
      recommendations: ["Set GITHUB_MERGE_STEWARD_EXECUTION_ENABLED=1 only when you want explicit steward merge commands to mutate GitHub."],
    });
  }

  if (!stewardItem.canAutoMergeIfEnabled) {
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      review,
      stewardItem,
      reason: stewardItem.reason,
      warnings,
      recommendations: ["Do not merge. Resolve the steward finding, then rerun the merge steward before asking for approval again."],
    });
  }

  if (!review.riskFindings.some((finding) => finding.code === "dependabot_low_risk")) {
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      review,
      stewardItem,
      reason: "not_low_risk_dependabot",
      warnings,
      recommendations: ["This first execution phase only merges low-risk Dependabot patch/minor dependency candidates."],
    });
  }

  const tokenConfig = buildGithubTokenConfig(env);
  const token = resolveGithubTokenForRepo(repo, tokenConfig);
  if (!token) {
    warnings.push({
      severity: "high",
      code: "github_repo_token_missing",
      repo,
      message: `No GitHub token is configured for ${repo}.`,
    });
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      review,
      stewardItem,
      reason: "github_repo_token_missing",
      warnings,
      recommendations: ["Configure a GitHub token with pull-request write permission for the target repository."],
    });
  }

  try {
    const baseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
    const mergeMethod = githubMergeMethod(env.GITHUB_MERGE_STEWARD_METHOD);
    const merge = await githubRequest<{ merged?: boolean; sha?: string; message?: string }>({
      url: `${baseUrl}/repos/${encodeRepoPath(repo)}/pulls/${pullRequestNumber}/merge`,
      token,
      fetchFn: options.fetchFn ?? fetch,
      method: "PUT",
      body: {
        merge_method: mergeMethod,
        commit_title: `${review.pullRequest?.title ?? `PR #${pullRequestNumber}`} (#${pullRequestNumber})`,
        commit_message: "Merged by Averray merge steward after explicit operator approval.",
      },
    });
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: true,
      executionEnabled,
      configured: review.configured,
      authConfigured: true,
      status: merge.merged === false ? "failed" : "merged",
      repo,
      pullRequestNumber,
      finalVerdict: stewardItem.finalVerdict,
      mergeRecommendation: stewardItem.mergeRecommendation,
      reason: merge.merged === false ? "github_merge_not_confirmed" : "merged_low_risk_dependabot",
      reviewReasons: stewardItem.reviewReasons,
      merge,
      safety: mergeApprovalSafety(true),
      warnings,
      recommendations: ["Watch CI and the production deploy workflow after the merge lands on main."],
    };
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_merge_failed",
      repo,
      message: error instanceof Error ? error.message : `Failed to merge ${repo}#${pullRequestNumber}.`,
    });
    return mergeApprovalBlocked({
      generatedAt,
      executionEnabled,
      repo,
      pullRequestNumber,
      review,
      stewardItem,
      reason: "github_merge_failed",
      warnings,
      recommendations: ["Do not retry blindly. Check the GitHub merge error, branch protection, and merge queue state first."],
      status: "failed",
    });
  }
}

export async function upsertGithubPullRequestComment(
  options: GithubPullRequestCommentInput
): Promise<GithubPullRequestCommentResult> {
  const env = options.env ?? process.env;
  const generatedAt = new Date().toISOString();
  const enabled = isTruthy(env.GITHUB_PR_HANDOFF_COMMENTS_ENABLED);
  const repo = normalizeRepo(options.repo ?? "");
  const pullRequestNumber = options.pullRequestNumber;
  const marker = options.marker ?? "<!-- averray-hermes-pr-handoff -->";
  const warnings: GithubWarning[] = [];

  if (!enabled) {
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      enabled,
      configured: Boolean(repo && pullRequestNumber),
      authConfigured: buildGithubTokenConfig(env).hasAnyToken,
      status: "skipped",
      ...(repo ? { repo } : {}),
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
      reason: "pr_comments_disabled",
      warnings,
    };
  }

  if (!repo || !pullRequestNumber) {
    warnings.push({
      severity: "high",
      code: "github_pr_comment_target_missing",
      message: "Cannot post a PR comment without repo and pullRequestNumber.",
    });
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      enabled,
      configured: false,
      authConfigured: buildGithubTokenConfig(env).hasAnyToken,
      status: "skipped",
      ...(repo ? { repo } : {}),
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
      reason: "target_missing",
      warnings,
    };
  }

  const tokenConfig = buildGithubTokenConfig(env);
  const token = resolveGithubTokenForRepo(repo, tokenConfig);
  if (!token) {
    warnings.push({
      severity: "high",
      code: "github_repo_token_missing",
      repo,
      message: `No GitHub token is configured for ${repo}.`,
    });
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      enabled,
      configured: true,
      authConfigured: tokenConfig.hasAnyToken,
      status: "failed",
      repo,
      pullRequestNumber,
      reason: "github_repo_token_missing",
      warnings,
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/g, "");
  const repoPath = encodeRepoPath(repo);
  const body = options.body.includes(marker) ? options.body : `${marker}\n${options.body}`;

  try {
    const comments = await githubGet<GithubApiIssueComment[]>(
      `${baseUrl}/repos/${repoPath}/issues/${pullRequestNumber}/comments?per_page=100`,
      token,
      fetchFn
    );
    const existing = comments.find((comment) => comment.body?.includes(marker) && comment.id);
    if (existing?.id) {
      const updated = await githubRequest<GithubApiIssueComment>({
        url: `${baseUrl}/repos/${repoPath}/issues/comments/${existing.id}`,
        token,
        fetchFn,
        method: "PATCH",
        body: { body },
      });
      return {
        schemaVersion: 1,
        generatedAt,
        mutatesGithub: true,
        enabled,
        configured: true,
        authConfigured: true,
        status: "updated",
        repo,
        pullRequestNumber,
        ...(updated.html_url ? { commentUrl: updated.html_url } : {}),
        warnings,
      };
    }

    const created = await githubRequest<GithubApiIssueComment>({
      url: `${baseUrl}/repos/${repoPath}/issues/${pullRequestNumber}/comments`,
      token,
      fetchFn,
      method: "POST",
      body: { body },
    });
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: true,
      enabled,
      configured: true,
      authConfigured: true,
      status: "posted",
      repo,
      pullRequestNumber,
      ...(created.html_url ? { commentUrl: created.html_url } : {}),
      warnings,
    };
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_pr_comment_failed",
      repo,
      message: error instanceof Error ? error.message : `Failed to comment on ${repo}#${pullRequestNumber}.`,
    });
    return {
      schemaVersion: 1,
      generatedAt,
      mutatesGithub: false,
      enabled,
      configured: true,
      authConfigured: true,
      status: "failed",
      repo,
      pullRequestNumber,
      reason: "github_pr_comment_failed",
      warnings,
    };
  }
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

function emptyPullRequestReview(input: {
  generatedAt: string;
  authConfigured: boolean;
  repo?: string;
  pullRequestNumber?: number;
  warnings: GithubWarning[];
}): GithubPullRequestReview {
  const configured = Boolean(input.authConfigured && input.repo && input.pullRequestNumber);
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mutatesGithub: false,
    configured,
    authConfigured: input.authConfigured,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    health: "degraded",
    files: { total: 0, highRisk: [], sample: [] },
    checks: { total: 0, passed: 0, failed: 0, active: 0, neutral: 0, skipped: 0, sample: [] },
    review: {
      touchedAreas: [],
      testFilesChanged: false,
      testSignals: [],
      missingTestSignals: [],
      rolloutNotesRequired: false,
      rolloutNotesPresent: false,
    },
    riskFindings: input.warnings.map((warning) => ({
      severity: warning.severity,
      code: warning.code,
      message: warning.message,
    })),
    mergeRecommendation: "hold",
    recommendations: [
      "Configure a read-only GitHub token and pass repo plus pullRequestNumber before using PR handoff.",
    ],
    warnings: input.warnings,
  };
}

async function readPullRequestChecks(input: {
  baseUrl: string;
  repoPath: string;
  headSha: string;
  token: string;
  fetchFn: typeof fetch;
  warnings: GithubWarning[];
  repo: string;
}): Promise<GithubApiCheckRun[]> {
  try {
    const checks = await githubGet<{ check_runs?: GithubApiCheckRun[] }>(
      `${input.baseUrl}/repos/${input.repoPath}/commits/${encodeURIComponent(input.headSha)}/check-runs?per_page=100`,
      input.token,
      input.fetchFn
    );
    return checks.check_runs ?? [];
  } catch (error) {
    input.warnings.push({
      severity: "medium",
      code: "github_pr_checks_unavailable",
      repo: input.repo,
      message: error instanceof Error ? error.message : "Failed to fetch PR check runs.",
    });
    return [];
  }
}

function parsePullRequestUrl(value: string | undefined): { repo: string; pullRequestNumber: number } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/github\.com$/i.test(url.hostname)) return undefined;
    const [, owner, repo, marker, number] = url.pathname.split("/");
    if (!owner || !repo || marker !== "pull") return undefined;
    const pullRequestNumber = Number.parseInt(number ?? "", 10);
    if (!Number.isFinite(pullRequestNumber) || pullRequestNumber <= 0) return undefined;
    return { repo: `${owner}/${repo}`, pullRequestNumber };
  } catch {
    return undefined;
  }
}

function summarizePullRequest(repo: string, pull: GithubApiPullRequest): NonNullable<GithubPullRequestReview["pullRequest"]> {
  const number = numberField(pull.number);
  return {
    repo,
    number,
    title: pull.title ?? "Untitled pull request",
    ...(pull.html_url ? { url: pull.html_url } : {}),
    ...(pull.user?.login ? { author: pull.user.login } : {}),
    state: pull.state ?? "unknown",
    draft: pull.draft === true,
    ...(pull.base?.ref ? { baseBranch: pull.base.ref } : {}),
    ...(pull.head?.ref ? { headBranch: pull.head.ref } : {}),
    ...(pull.head?.sha ? { headSha: pull.head.sha } : {}),
    ...(typeof pull.additions === "number" ? { additions: pull.additions } : {}),
    ...(typeof pull.deletions === "number" ? { deletions: pull.deletions } : {}),
    ...(typeof pull.changed_files === "number" ? { changedFiles: pull.changed_files } : {}),
    ...(pull.mergeable_state ? { mergeableState: pull.mergeable_state } : {}),
    ...(pull.updated_at ? { updatedAt: pull.updated_at } : {}),
  };
}

function fileSummary(file: GithubApiPullRequestFile): GithubPullRequestFileSummary | undefined {
  if (!file.filename) return undefined;
  return {
    filename: file.filename,
    ...(file.status ? { status: file.status } : {}),
    ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
    ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
    ...(typeof file.changes === "number" ? { changes: file.changes } : {}),
  };
}

function fileRisk(file: GithubPullRequestFileSummary): GithubPullRequestFileRisk | undefined {
  const path = file.filename.toLowerCase();
  const criticalPatterns: Array<Pick<GithubPullRequestFileRisk, "category" | "reason"> & { pattern: RegExp }> = [
    { pattern: /^\.env/, category: "secrets", reason: "touches environment or secret material" },
    { pattern: /(^|\/)\.env/, category: "secrets", reason: "touches environment or secret material" },
    { pattern: /(^|\/)secrets?\b/, category: "secrets", reason: "touches secret material" },
    { pattern: /(^|\/)contracts?\//, category: "contracts", reason: "touches smart contract code" },
    { pattern: /(^|\/)migrations?\//, category: "database", reason: "touches database migration code" },
  ];
  for (const match of criticalPatterns) {
    if (match.pattern.test(path)) return { ...file, risk: "high", category: match.category, reason: match.reason };
  }
  const reviewPatterns: Array<Pick<GithubPullRequestFileRisk, "category" | "reason"> & { pattern: RegExp }> = [
    { pattern: /^\.github\/workflows\//, category: "workflow", reason: "touches GitHub workflow automation" },
    { pattern: /(^|\/)ops\//, category: "ops", reason: "touches operator or infrastructure configuration" },
    { pattern: /(^|\/)deploy/, category: "deploy", reason: "touches deploy automation" },
    { pattern: /compose.*\.ya?ml$/, category: "ops", reason: "touches container compose configuration" },
    { pattern: /caddyfile$/, category: "ops", reason: "touches edge/proxy configuration" },
    { pattern: /package-lock\.json$/, category: "lockfile", reason: "touches dependency lockfile" },
  ];
  for (const match of reviewPatterns) {
    if (match.pattern.test(path)) return { ...file, risk: "medium", category: match.category, reason: match.reason };
  }
  if ((file.changes ?? 0) >= 400) {
    return { ...file, risk: "medium", category: "large_file", reason: "large single-file change" };
  }
  return undefined;
}

function buildPullRequestReviewSignals(input: {
  body?: string | null;
  files: GithubPullRequestFileSummary[];
  checks: GithubPullRequestCheckSummary[];
}): GithubPullRequestReviewSignals {
  const touchedAreas = unique(input.files.flatMap((file) => touchedAreasForPath(file.filename)));
  const testFilesChanged = input.files.some((file) => touchedAreasForPath(file.filename).includes("tests"));
  const checkNames = input.checks.map((check) => check.name.toLowerCase());
  const testSignals = unique([
    ...(testFilesChanged ? ["test files changed"] : []),
    ...input.checks
      .filter((check) => isTestSignalCheck(check.name))
      .map((check) => `check:${check.name}`),
  ]);
  const codeAreas = touchedAreas.filter((area) => isCodeArea(area));
  const missingTestSignals = testFilesChanged
    ? []
    : codeAreas.filter((area) => !areaHasCheckSignal(area, checkNames));
  const rolloutNotesRequired = touchedAreas.some((area) => requiresRolloutNotes(area));
  const rolloutNotesPresent = rolloutNotesRequired && hasRolloutNotes(input.body);

  return {
    touchedAreas,
    testFilesChanged,
    testSignals,
    missingTestSignals,
    rolloutNotesRequired,
    rolloutNotesPresent,
  };
}

function touchedAreasForPath(filename: string): GithubPullRequestTouchedArea[] {
  const path = filename.toLowerCase();
  const areas: GithubPullRequestTouchedArea[] = [];
  if (/(\btest\b|__tests__|\.test\.|\.spec\.|\/tests?\/)/.test(path)) areas.push("tests");
  if (/^docs?\//.test(path) || /\.mdx?$/.test(path)) areas.push("docs");
  if (/^app\//.test(path) || /^frontend\//.test(path) || /^site\//.test(path) || /\.(tsx|jsx|css|scss)$/.test(path)) {
    areas.push("frontend");
  }
  if (/^mcp-server\//.test(path) || /^packages\//.test(path) || /^services\//.test(path)) areas.push("backend");
  if (/^indexer\//.test(path)) areas.push("indexer");
  if (/^contracts?\//.test(path)) areas.push("contracts");
  if (/^ops\//.test(path) || /compose.*\.ya?ml$/.test(path) || /caddyfile$/.test(path)) areas.push("ops");
  if (/(^|\/)deploy/.test(path)) areas.push("deploy");
  if (/^\.github\/workflows\//.test(path)) areas.push("workflow");
  if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(path)) areas.push("dependencies");
  if (/\.json$|\.ya?ml$|\.toml$|\.ini$/.test(path)) areas.push("config");
  return areas.length > 0 ? areas : ["config"];
}

function isCodeArea(area: GithubPullRequestTouchedArea): boolean {
  return area === "frontend" || area === "backend" || area === "indexer" || area === "contracts";
}

function requiresRolloutNotes(area: GithubPullRequestTouchedArea): boolean {
  return area === "ops" || area === "deploy" || area === "workflow" || area === "contracts" || area === "indexer";
}

function hasRolloutNotes(body: string | null | undefined): boolean {
  if (!body) return false;
  return /(deploy|deployment|rollback|roll back|rollout|operator|vps|secret|env|migration|contract)/i.test(body);
}

function isTestSignalCheck(name: string): boolean {
  return /(test|typecheck|build|ci|lint|forge|vitest|playwright)/i.test(name);
}

function areaHasCheckSignal(area: GithubPullRequestTouchedArea, checkNames: string[]): boolean {
  if (checkNames.some((name) => /\bci\b/.test(name))) return true;
  const patterns: Partial<Record<GithubPullRequestTouchedArea, RegExp>> = {
    frontend: /(frontend|app|typecheck|build|playwright|ui)/,
    backend: /(backend|mcp|server|service|test|typecheck)/,
    indexer: /(indexer|typecheck|test)/,
    contracts: /(contract|forge|solidity|test)/,
  };
  const pattern = patterns[area];
  return pattern ? checkNames.some((name) => pattern.test(name)) : false;
}

function checkSummary(check: GithubApiCheckRun): GithubPullRequestCheckSummary {
  return {
    name: check.name ?? "Unnamed check",
    status: check.status ?? "unknown",
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(check.html_url ? { url: check.html_url } : {}),
  };
}

function summarizeChecks(checks: GithubPullRequestCheckSummary[]) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "completed" && check.conclusion === "success").length,
    failed: checks.filter((check) => isFailedCheck(check)).length,
    active: checks.filter((check) => check.status !== "completed").length,
    neutral: checks.filter((check) => check.status === "completed" && (check.conclusion === "neutral" || check.conclusion === "success_with_warnings")).length,
    skipped: checks.filter((check) => check.status === "completed" && check.conclusion === "skipped").length,
  };
}

function isFailedCheck(check: GithubPullRequestCheckSummary): boolean {
  return check.status === "completed"
    && (check.conclusion === "failure"
      || check.conclusion === "cancelled"
      || check.conclusion === "timed_out"
      || check.conclusion === "action_required");
}

function buildPullRequestRiskFindings(input: {
  pullRequest: NonNullable<GithubPullRequestReview["pullRequest"]>;
  files: GithubPullRequestFileSummary[];
  highRiskFiles: GithubPullRequestFileRisk[];
  checks: ReturnType<typeof summarizeChecks>;
  review: GithubPullRequestReviewSignals;
  warnings: GithubWarning[];
}): GithubPullRequestRiskFinding[] {
  const findings: GithubPullRequestRiskFinding[] = input.warnings.map((warning) => ({
    severity: warning.severity,
    code: warning.code,
    message: warning.message,
  }));
  if (input.pullRequest.state !== "open") {
    findings.push({ severity: "high", code: "pr_not_open", message: `PR state is ${input.pullRequest.state}.` });
  }
  if (input.pullRequest.draft) {
    findings.push({ severity: "high", code: "pr_is_draft", message: "PR is still marked as draft." });
  }
  if (input.checks.failed > 0) {
    findings.push({ severity: "high", code: "pr_checks_failed", message: `${input.checks.failed} PR check(s) failed.` });
  }
  if (input.checks.active > 0) {
    findings.push({ severity: "high", code: "pr_checks_active", message: `${input.checks.active} PR check(s) are still running.` });
  }
  if (input.checks.total === 0) {
    findings.push({ severity: "medium", code: "pr_checks_missing", message: "No PR check runs were found for the head commit." });
  }
  const criticalRisk = input.highRiskFiles.filter((file) => file.risk === "high");
  if (criticalRisk.length > 0) {
    findings.push({
      severity: "high",
      code: "pr_critical_files",
      message: `${criticalRisk.length} changed file(s) touch secrets, contracts, or database migrations.`,
    });
  }
  const reviewRisk = input.highRiskFiles.filter((file) => file.risk === "medium");
  if (reviewRisk.length > 0) {
    const categories = [...new Set(reviewRisk.map((file) => file.category))].join(", ");
    findings.push({
      severity: "medium",
      code: "pr_review_risk_files",
      message: `${reviewRisk.length} changed file(s) touch review-gated surfaces${categories ? ` (${categories})` : ""}.`,
    });
  }
  if (input.review.missingTestSignals.length > 0) {
    findings.push({
      severity: "medium",
      code: "pr_test_signal_missing",
      message: `No changed test files or matching check names found for ${input.review.missingTestSignals.join(", ")} changes.`,
    });
  }
  if (input.review.rolloutNotesRequired && !input.review.rolloutNotesPresent) {
    findings.push({
      severity: "medium",
      code: "pr_rollout_notes_missing",
      message: "Deploy, ops, workflow, contract, or indexer changes should include rollout or rollback notes in the PR body.",
    });
  }
  if (input.files.length > 25) {
    findings.push({ severity: "medium", code: "pr_large_file_count", message: `PR changes ${input.files.length} files.` });
  }
  const totalChanges = input.files.reduce((sum, file) => sum + (file.changes ?? 0), 0);
  if (totalChanges > 1_000) {
    findings.push({ severity: "medium", code: "pr_large_diff", message: `PR changes ${totalChanges} lines.` });
  }
  if (input.pullRequest.mergeableState && ["dirty", "blocked", "unknown"].includes(input.pullRequest.mergeableState)) {
    findings.push({
      severity: input.pullRequest.mergeableState === "dirty" ? "high" : "medium",
      code: "pr_mergeable_state_attention",
      message: `GitHub mergeable_state is ${input.pullRequest.mergeableState}.`,
    });
  }
  if (findings.length === 0) {
    findings.push({ severity: "low", code: "pr_review_green", message: "PR metadata, files, and checks look merge-ready." });
  }
  return findings;
}

function applyDependabotLowRiskPolicy(input: {
  pullRequest: NonNullable<GithubPullRequestReview["pullRequest"]>;
  files: GithubPullRequestFileSummary[];
  highRiskFiles: GithubPullRequestFileRisk[];
  checks: ReturnType<typeof summarizeChecks>;
  riskFindings: GithubPullRequestRiskFinding[];
}): GithubPullRequestRiskFinding[] {
  if (!isDependabotPullRequest(input.pullRequest)) return input.riskFindings;
  if (!isPatchOrMinorDependencyBump(input.pullRequest.title)) return input.riskFindings;
  if (!input.files.every((file) => isDependencyManifestOrLockfile(file.filename))) return input.riskFindings;
  if (input.checks.total === 0 || input.checks.failed > 0 || input.checks.active > 0) return input.riskFindings;
  if (input.pullRequest.state !== "open" || input.pullRequest.draft) return input.riskFindings;
  if (input.pullRequest.mergeableState && ["dirty", "blocked", "unknown"].includes(input.pullRequest.mergeableState)) {
    return input.riskFindings;
  }
  if (input.highRiskFiles.some((file) => file.risk === "high")) return input.riskFindings;

  const remainingFindings = input.riskFindings.filter((finding) => finding.code !== "pr_review_risk_files");
  if (remainingFindings.some((finding) => finding.severity !== "low")) return input.riskFindings;

  return [
    ...remainingFindings.filter((finding) => finding.code !== "pr_review_green"),
    {
      severity: "low",
      code: "dependabot_low_risk",
      message: "Dependabot patch/minor dependency-only PR with green checks.",
    },
  ];
}

function isDependabotPullRequest(pullRequest: NonNullable<GithubPullRequestReview["pullRequest"]>): boolean {
  return pullRequest.author === "dependabot[bot]" || pullRequest.author === "dependabot";
}

function isPatchOrMinorDependencyBump(title: string): boolean {
  const match = title.match(/\bfrom\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+\w.]*)?\s+to\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+\w.]*)?/i)
    ?? title.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:[-+\w.]*)?\s*(?:->|→|to)\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+\w.]*)?/i);
  if (!match) return false;
  const [, fromMajor, fromMinor, fromPatch, toMajor, toMinor, toPatch] = match.map(Number);
  if (![fromMajor, fromMinor, fromPatch, toMajor, toMinor, toPatch].every(Number.isFinite)) return false;
  if (toMajor !== fromMajor) return false;
  if (toMinor > fromMinor) return true;
  return toMinor === fromMinor && toPatch >= fromPatch;
}

function isDependencyManifestOrLockfile(filename: string): boolean {
  const path = filename.toLowerCase();
  return /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(path);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function chooseMergeRecommendation(findings: GithubPullRequestRiskFinding[]): GithubPullRequestMergeRecommendation {
  if (findings.some((finding) => finding.severity === "high")) return "hold";
  if (findings.some((finding) => finding.severity === "medium")) return "needs_review";
  return "ok_to_merge";
}

function buildPullRequestReviewRecommendations(input: {
  mergeRecommendation: GithubPullRequestMergeRecommendation;
  riskFindings: GithubPullRequestRiskFinding[];
}): string[] {
  if (input.mergeRecommendation === "ok_to_merge") {
    return ["PR looks merge-ready from read-only GitHub metadata and checks. Run the requested testbed case before merging."];
  }
  if (input.mergeRecommendation === "hold") {
    return ["Do not merge yet. Resolve high-severity findings such as draft state, failing checks, active checks, or merge conflicts first."];
  }
  const mediumCodes = input.riskFindings
    .filter((finding) => finding.severity === "medium")
    .map((finding) => finding.code);
  return [
    `Human review recommended before merge${mediumCodes.length > 0 ? ` (${[...new Set(mediumCodes)].join(", ")})` : ""}.`,
  ];
}

function stewardItemFromReview(review: GithubPullRequestReview): GithubMergeStewardItem {
  const finalVerdict: GithubMergeStewardVerdict = review.mergeRecommendation === "ok_to_merge"
    ? "pass"
    : review.mergeRecommendation === "needs_review"
      ? "human_review"
      : "block";
  const relevantReasons = review.riskFindings.filter((finding) => finding.code !== "pr_review_green");
  const reason = relevantReasons[0]?.code ?? (finalVerdict === "pass" ? "github_ok_to_merge" : `github_${review.mergeRecommendation}`);
  const pullRequest = review.pullRequest;
  const canAutoMergeIfEnabled = finalVerdict === "pass"
    && review.configured
    && review.checks.failed === 0
    && review.checks.active === 0
    && !review.files.highRisk.some((file) => file.risk === "high")
    && review.riskFindings.every((finding) => finding.severity === "low")
    && pullRequest?.state === "open"
    && pullRequest?.draft === false;

  return {
    repo: review.repo ?? pullRequest?.repo ?? "unknown",
    pullRequestNumber: review.pullRequestNumber ?? pullRequest?.number ?? 0,
    title: pullRequest?.title ?? "Unknown pull request",
    ...(pullRequest?.url ? { url: pullRequest.url } : {}),
    ...(pullRequest?.author ? { author: pullRequest.author } : {}),
    finalVerdict,
    mergeRecommendation: review.mergeRecommendation,
    reason,
    canAutoMergeIfEnabled,
    checks: {
      total: review.checks.total,
      passed: review.checks.passed,
      failed: review.checks.failed,
      active: review.checks.active,
    },
    touchedAreas: review.review.touchedAreas,
    testSignals: review.review.testSignals,
    reviewReasons: relevantReasons,
  };
}

function mergeApprovalBlocked(input: {
  generatedAt: string;
  executionEnabled: boolean;
  repo?: string;
  pullRequestNumber?: number;
  review?: GithubPullRequestReview;
  stewardItem?: GithubMergeStewardItem;
  reason: string;
  warnings: GithubWarning[];
  recommendations: string[];
  status?: "blocked" | "failed";
}): GithubMergeStewardApproval {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mutatesGithub: false,
    executionEnabled: input.executionEnabled,
    configured: input.review?.configured ?? false,
    authConfigured: input.review?.authConfigured ?? false,
    status: input.status ?? "blocked",
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.stewardItem ? { finalVerdict: input.stewardItem.finalVerdict } : {}),
    ...(input.stewardItem ? { mergeRecommendation: input.stewardItem.mergeRecommendation } : {}),
    reason: input.reason,
    reviewReasons: input.stewardItem?.reviewReasons ?? [],
    safety: mergeApprovalSafety(false),
    warnings: input.warnings,
    recommendations: input.recommendations,
  };
}

function mergeApprovalSafety(githubMutated: boolean): GithubMergeStewardApproval["safety"] {
  return {
    requiresExplicitCommand: true,
    requiresEnvFlag: true,
    onlyLowRiskDependabot: true,
    githubMutated,
    wikipediaEdited: false,
  };
}

function buildMergeStewardRecommendations(input: {
  autoMergeCandidates: GithubMergeStewardItem[];
  humanReview: GithubMergeStewardItem[];
  blocked: GithubMergeStewardItem[];
}): string[] {
  const recommendations: string[] = [];
  if (input.autoMergeCandidates.length > 0) {
    recommendations.push(`${input.autoMergeCandidates.length} PR(s) are clean merge candidates. Merge execution is still disabled in this read-only steward.`);
  }
  if (input.humanReview.length > 0) {
    recommendations.push(`${input.humanReview.length} PR(s) need a human review before merge.`);
  }
  if (input.blocked.length > 0) {
    recommendations.push(`${input.blocked.length} PR(s) are blocked. Fix high-severity findings before merge.`);
  }
  if (recommendations.length === 0) recommendations.push("No open PRs need steward action.");
  recommendations.push("Next phase: enable narrow auto-merge only for clean candidates after an explicit allowlist and audit policy.");
  return recommendations;
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
  return await githubRequest<T>({ url, token, fetchFn });
}

async function githubRequest<T>(input: {
  url: string;
  token: string;
  fetchFn: typeof fetch;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await input.fetchFn(input.url, {
    ...(input.method ? { method: input.method } : {}),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      "user-agent": "averray-reference-agent-github-helper",
      "x-github-api-version": "2022-11-28",
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} for ${input.url}${text ? `: ${text.slice(0, 180)}` : ""}`);
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

function githubMergeMethod(value: string | undefined): "merge" | "squash" | "rebase" {
  return value === "merge" || value === "rebase" ? value : "squash";
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
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
