export interface StalePrAlertItem {
  correlationId: string;
  repo: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  owner: string;
  ageMinutes: number;
  ageLabel: string;
  nextAction: string;
  reason: string;
  updatedAt?: string;
}

export interface StalePrAlertInput {
  monitor: unknown;
  staleAfterMinutes: number;
  now?: Date;
}

export function stalePrAlertItems(input: StalePrAlertInput): StalePrAlertItem[] {
  const now = input.now ?? new Date();
  const monitor = toRecord(input.monitor);
  const candidates = [...arrayField(monitor, "active"), ...arrayField(monitor, "recent")];
  const seen = new Set<string>();
  const items: StalePrAlertItem[] = [];
  for (const value of candidates) {
    const item = toRecord(value);
    if (!isPrHandoff(item)) continue;
    const correlationId = stringField(item, "correlationId") ?? "";
    const key = correlationId || `${stringField(item, "repo") ?? "unknown"}#${numberField(item, "pullRequestNumber") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const updatedAt = stringField(item, "updatedAt");
    const ageMinutes = ageInMinutes(updatedAt, now);
    if (ageMinutes < input.staleAfterMinutes) continue;
    const verdict = releaseVerdict(item);
    const owner = nextOwner(item, verdict);
    items.push({
      correlationId: correlationId || key,
      repo: stringField(item, "repo") ?? "unknown repo",
      pullRequestNumber: numberField(item, "pullRequestNumber"),
      pullRequestUrl: stringField(item, "pullRequestUrl") ?? derivePullRequestUrl(item),
      owner,
      ageMinutes,
      ageLabel: formatDuration(ageMinutes),
      nextAction: nextActionText(owner, verdict, item),
      reason: releaseReason(item, verdict),
      updatedAt,
    });
  }
  return items.sort((a, b) => b.ageMinutes - a.ageMinutes);
}

export function stalePrAlertSignature(items: StalePrAlertItem[]): string | undefined {
  if (items.length === 0) return undefined;
  return items
    .map((item) => `${item.correlationId}:${item.owner}:${Math.floor(item.ageMinutes / 30)}`)
    .sort()
    .join("|");
}

export function shouldPostStalePrAlert(
  items: StalePrAlertItem[],
  previousSignature: string | undefined
): { shouldPost: boolean; signature?: string } {
  const signature = stalePrAlertSignature(items);
  if (!signature) return { shouldPost: false };
  return { shouldPost: signature !== previousSignature, signature };
}

export function formatStalePrAlertForSlack(items: StalePrAlertItem[], monitorUrl?: string): string {
  const header = `*Hermes stale PR handoffs* — ${items.length} need attention`;
  const lines = items.slice(0, 8).map((item) => {
    const pr = item.pullRequestUrl
      ? `<${item.pullRequestUrl}|${item.repo}${item.pullRequestNumber ? ` #${item.pullRequestNumber}` : ""}>`
      : `${item.repo}${item.pullRequestNumber ? ` #${item.pullRequestNumber}` : ""}`;
    return [
      `• ${pr}`,
      `owner: \`${item.owner}\``,
      `age: \`${item.ageLabel}\``,
      `next: ${item.nextAction}`,
      `why: ${item.reason}`,
    ].join(" · ");
  });
  const extra = items.length > 8 ? [`• plus ${items.length - 8} more stale handoff${items.length - 8 === 1 ? "" : "s"}`] : [];
  const footer = monitorUrl ? [`Open monitor: ${monitorUrl}`] : [];
  return [header, ...lines, ...extra, ...footer].join("\n");
}

function isPrHandoff(item: Record<string, unknown>): boolean {
  const intent = normalize(stringField(item, "intent"));
  const correlationId = stringField(item, "correlationId") ?? "";
  return Boolean(
    numberField(item, "pullRequestNumber")
    || intent === "pr_handoff"
    || intent === "pr_code_review"
    || correlationId.startsWith("github-pr-")
  );
}

function releaseVerdict(item: Record<string, unknown>): "block" | "needs-review" | "pass" | "running" | "unknown" {
  const summary = toRecord(item.summary);
  const status = normalize(stringField(item, "status"));
  const finalVerdict = normalize(stringField(summary, "finalVerdict") ?? stringField(summary, "status"));
  const mergeRecommendation = normalize(stringField(summary, "mergeRecommendation"));
  const reason = normalize(stringField(summary, "finalReason") ?? stringField(summary, "reason") ?? stringField(item, "reason"));
  const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
  if (status === "running") return "running";
  if (
    status === "failed"
    || status === "blocked"
    || includesAny(finalVerdict, ["block", "blocked", "failed", "failure", "hold"])
    || includesAny(mergeRecommendation, ["block", "blocked", "failed", "failure", "hold", "do_not_merge"])
    || includesAny(reason, ["deploy_failure", "deploy_failed", "ci_failed"])
  ) {
    return "block";
  }
  if (
    status === "needs_review"
    || includesAny(finalVerdict, ["review", "needs_review"])
    || includesAny(mergeRecommendation, ["review", "wait", "needs_review"])
    || includesAny(reason, ["github_needs_review", "pr_review_hold", "needs_review"])
    || reviewReasons.length > 0
  ) {
    return "needs-review";
  }
  if (status || finalVerdict || mergeRecommendation) return "pass";
  return "unknown";
}

function nextOwner(item: Record<string, unknown>, verdict: ReturnType<typeof releaseVerdict>): string {
  const status = normalize(stringField(item, "status"));
  if (item.active === true || stringField(item, "activeState") === "running" || status === "running") return "Hermes";
  if (isDraftPullRequest(item)) return "Codex";
  if (verdict === "block") return "Codex";
  if (verdict === "needs-review") return "Operator";
  if (verdict === "pass") return "Merge queue";
  return "GitHub Actions";
}

function nextActionText(owner: string, verdict: ReturnType<typeof releaseVerdict>, item: Record<string, unknown>): string {
  if (owner === "Hermes") return "finish checks and publish a verdict";
  if (owner === "Codex" && isDraftPullRequest(item)) return "finish the draft or mark it ready for review so CI and Hermes can run";
  if (owner === "Codex") return "fix the blocking signal and push an update";
  if (owner === "Operator") return "use the agent pre-check evidence to decide project intent, architecture, and rollout risk";
  if (owner === "Merge queue") return "merge when branch protection and queue checks are green";
  if (verdict === "unknown") return "wait for CI/Hermes metadata";
  return "finish CI before release-gate recommendation";
}

function releaseReason(item: Record<string, unknown>, verdict: ReturnType<typeof releaseVerdict>): string {
  const summary = toRecord(item.summary);
  const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
  const first = toRecord(reviewReasons.find(Boolean));
  if (stringField(first, "message")) return stringField(first, "message") ?? "Operator review recommended.";
  if (isDraftPullRequest(item)) return "PR is still draft; Codex must finish it or mark it ready before Hermes/operator can proceed.";
  const reason = normalize(stringField(summary, "finalReason") ?? stringField(summary, "reason") ?? stringField(item, "reason"));
  if (reason === "github_needs_review") return "Operator review recommended by the GitHub risk gate; agent pre-check evidence should be attached.";
  if (reason === "pr_review_hold") return "PR risk gate held this for operator review.";
  if (reason === "ci_failed") return "CI failed; fix before merge.";
  if (reason === "ci_in_progress") return "CI is still running.";
  if (verdict === "block") return "Blocked by release gate.";
  if (verdict === "needs-review") return "Operator review recommended.";
  if (verdict === "pass") return "No blocking release signals recorded.";
  return "No reason recorded.";
}

function isDraftPullRequest(item: Record<string, unknown>): boolean {
  const prState = pullRequestState(item);
  return Boolean(prState && prState.draft === true && !isDonePullRequestState(prState));
}

function pullRequestState(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary = toRecord(item.summary);
  const current = toRecord(summary.currentPullRequest);
  if (Object.keys(current).length > 0) return current;
  const pullRequest = toRecord(summary.pullRequest);
  if (Object.keys(pullRequest).length > 0) return pullRequest;
  return undefined;
}

function isDonePullRequestState(prState: Record<string, unknown> | undefined): boolean {
  if (!prState) return false;
  return prState.merged === true || normalize(stringField(prState, "state")) === "closed";
}

function ageInMinutes(updatedAt: string | undefined, now: Date): number {
  const parsed = Date.parse(updatedAt ?? "");
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 60_000));
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return "unknown age";
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function derivePullRequestUrl(item: Record<string, unknown>): string | undefined {
  const repo = stringField(item, "repo") ?? "";
  const prNumber = numberField(item, "pullRequestNumber");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  if (prNumber === undefined || !Number.isInteger(prNumber) || prNumber < 1) return undefined;
  return `https://github.com/${repo}/pull/${prNumber}`;
}

function normalize(value: string | undefined): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function stringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = toRecord(value)[key];
  return Array.isArray(field) ? field : [];
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
