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

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: MonitorPullRequestState }>();

export async function enrichMonitorWithGithubPrState<T extends MonitorPayload>(
  monitor: T,
  deps: GithubPrStateDeps = {}
): Promise<T> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const entries = [...monitorEntries(monitor.active), ...monitorEntries(monitor.recent)];
  const keys = uniquePrKeys(entries);
  if (!keys.length) return monitor;

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
  if (states.size === 0) return monitor;

  return {
    ...monitor,
    ...(Array.isArray(monitor.active) ? { active: enrichEntries(monitor.active, states) } : {}),
    ...(Array.isArray(monitor.recent) ? { recent: enrichEntries(monitor.recent, states) } : {}),
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
    ...(stringField(pull, "updated_at") ? { updatedAt: stringField(pull, "updated_at") } : {}),
    checkedAt: input.now.toISOString(),
    source: "github_live",
  };
  cache.set(key, { expiresAt: input.now.getTime() + CACHE_TTL_MS, value });
  return value;
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
