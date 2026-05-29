import type { HermesBoardCardSnapshot, HermesBoardSnapshot } from "./monitor-hermes-voice.js";
import { testbedMissionRunToMonitorItem, type TestbedMissionRun } from "./monitor-testbed-missions.js";

interface PrIdentity {
  repo?: string;
  number?: number;
}

interface BoardClassification {
  lane: string;
  owner: string;
  verdict: string;
  next: string;
}

const TERMINAL_CODEX_STATUSES = new Set(["completed", "cancelled", "failed", "terminal"]);

export function buildHermesBoardSnapshotFromMonitor(snapshot: unknown): HermesBoardSnapshot | undefined {
  if (!isRecord(snapshot)) return undefined;

  const activeTasks = activeCodexTaskMap(snapshot);
  const missionItems = arrayRecords(snapshot.testbedMissions)
    .map((run) => testbedMissionRunToMonitorItem(run as unknown as TestbedMissionRun));
  const rawItems = dedupeItems([...arrayRecords(snapshot.active), ...arrayRecords(snapshot.recent), ...missionItems]);
  const cards = rawItems
    .map((item) => boardCardFromItem(item, snapshot, activeTasks))
    .filter((item): item is HermesBoardCardSnapshot => Boolean(item))
    .slice(0, 10);

  const counts = boardCounts(cards, snapshot);
  const runner = runnerSummary(snapshot);
  return {
    ...stringProp(snapshot, "generatedAt", "generatedAt"),
    ...stringProp(snapshot, "status", "status"),
    headline: boardHeadline(counts),
    counts,
    ...(runner ? { runner } : {}),
    items: cards,
  };
}

function boardCardFromItem(
  item: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  activeTasks: ReadonlyMap<string, string>
): HermesBoardCardSnapshot | undefined {
  const summary = recordProp(item, "summary") ?? {};
  const prState = pullRequestState(item, summary);
  const identity = prIdentity(item, summary, prState);
  const key = identityKey(identity);
  const codexTaskStatus = key ? activeTasks.get(key) : undefined;
  const classification = classifyItem(item, summary, prState, codexTaskStatus);
  const title = titleForItem(item, summary, prState, identity);
  if (!title && !identity.repo) return undefined;
  const why = reasonForItem(item, summary, prState, codexTaskStatus);
  const correlationId = textProp(item, "correlationId");
  return {
    ...identity,
    title: title || "Untitled handoff",
    lane: classification.lane,
    owner: classification.owner,
    verdict: classification.verdict,
    ...ageLabelProp(item, snapshot),
    ...(why ? { why } : {}),
    next: classification.next,
    tags: tagsForItem(item, summary),
    ...(correlationId ? { correlationId } : {}),
  };
}

function classifyItem(
  item: Record<string, unknown>,
  summary: Record<string, unknown>,
  prState: Record<string, unknown> | undefined,
  codexTaskStatus?: string
): BoardClassification {
  const reason = normalize(textProp(summary, "finalReason") || textProp(summary, "reason") || textProp(item, "reason"));
  const status = normalize(textProp(item, "status"));
  const finalVerdict = normalize(textProp(summary, "finalVerdict") || textProp(summary, "status"));
  const mergeRecommendation = normalize(textProp(summary, "mergeRecommendation"));
  const intent = normalize(textProp(item, "intent"));
  if (intent === "testbed_agent_mission") {
    const failed = status === "failed" || includesAny(finalVerdict, ["failed", "failure", "block"]);
    const completed = status === "completed" || includesAny(finalVerdict, ["pass", "completed"]);
    if (failed) {
      return {
        lane: "Needs Attention",
        owner: "Hermes",
        verdict: "mission failed",
        next: "inspect the browser-agent report and decide whether the page or the mission prompt needs the next fix",
      };
    }
    if (completed) {
      return {
        lane: "Done",
        owner: "History",
        verdict: "mission completed",
        next: "use the report as evidence for the next testbed/product improvement",
      };
    }
    return {
      lane: "Hermes Checking",
      owner: "Hermes",
      verdict: "mission ready",
      next: "run the browser-only mission with a fresh agent, then post the structured report back into the monitor",
    };
  }

  if (isDonePrState(prState)) {
    return {
      lane: "Done",
      owner: "History",
      verdict: prState && booleanProp(prState, "merged") ? "merged" : "closed",
      next: "keep this as release history; no board action is needed",
    };
  }
  if (intent.includes("deploy")) {
    const failed = includesAny(reason, ["failed", "failure"]) || includesAny(finalVerdict, ["failed", "failure", "block"]);
    if (status === "running" || booleanProp(item, "active")) {
      return {
        lane: "Deploying",
        owner: "Hermes",
        verdict: "deploy running",
        next: "wait for production verification to publish a pass or failure",
      };
    }
    if (failed) {
      return {
        lane: "Needs Attention",
        owner: "Codex",
        verdict: "deploy failed",
        next: "prepare a fix or rollback plan, then let deployment verification run again",
      };
    }
  }
  if (isRunningItem(item, status)) {
    return {
      lane: "Hermes Checking",
      owner: "Hermes",
      verdict: "running",
      next: "wait for Hermes/GitHub checks to finish before assigning new work",
    };
  }
  if (booleanProp(prState, "draft")) {
    if (codexTaskStatus) {
      return {
        lane: "Codex Needed",
        owner: "Codex",
        verdict: "delegated draft",
        next: "continue the explicit Codex takeover task, finish only verifiable work, then mark the PR ready when it is actually ready",
      };
    }
    return {
      lane: "Waiting / Drafts",
      owner: "PR author",
      verdict: "draft",
      next: "wait for the PR author or owning agent to mark it ready; Codex takes over only if Pascal explicitly delegates it",
    };
  }
  if (
    reason === "pr_checks_active"
    || reason === "ci_in_progress"
    || includesAny(finalVerdict, ["running", "active"])
  ) {
    return {
      lane: "Codex Needed",
      owner: "Codex",
      verdict: "CI running",
      next: "wait for CI on the current commit; if it fails, Codex should push the smallest fix and let Hermes re-run",
    };
  }
  if (
    status === "failed"
    || status === "blocked"
    || reason === "pr_checks_failed"
    || includesAny(reason, ["failed", "failure", "block"])
    || includesAny(finalVerdict, ["failed", "failure", "block", "hold"])
    || includesAny(mergeRecommendation, ["failed", "failure", "block", "hold", "do_not_merge"])
  ) {
    return {
      lane: "Needs Attention",
      owner: "Codex",
      verdict: "blocked",
      next: "inspect the failing signal, make the smallest justified fix or propose a smaller retry task, then wait for CI and Hermes",
    };
  }
  if (
    reason === "pr_critical_files"
    || reason === "pr_review_risk_files"
    || finalVerdict.includes("review")
    || mergeRecommendation.includes("review")
    || reviewReasons(summary).length > 0
  ) {
    return {
      lane: "Operator Review",
      owner: "Operator",
      verdict: "needs review",
      next: "use Hermes/Codex pre-check evidence to decide whether the project intent, rollout risk, and critical-file boundary are acceptable",
    };
  }
  if (
    finalVerdict === "ok_to_merge"
    || finalVerdict === "pass"
    || mergeRecommendation === "ok_to_merge"
    || mergeRecommendation === "merge"
    || status === "completed"
  ) {
    return {
      lane: "Release Queue",
      owner: "Merge steward",
      verdict: "ready",
      next: "merge only after branch protection is green and any operator sign-off is clean",
    };
  }
  return {
    lane: "Hermes Checking",
    owner: "Hermes",
    verdict: status || finalVerdict || "unknown",
    next: "collect a fresh Hermes verdict before moving the card forward",
  };
}

function reasonForItem(
  item: Record<string, unknown>,
  summary: Record<string, unknown>,
  prState: Record<string, unknown> | undefined,
  codexTaskStatus?: string
): string {
  if (codexTaskStatus) return `Codex task is ${codexTaskStatus}.`;
  const firstReason = reviewReasons(summary)[0];
  if (firstReason) return firstReason;
  const codeReview = recordProp(summary, "codeReview");
  const codeReviewWhy = codeReview ? textProp(codeReview, "why") : "";
  if (codeReviewWhy) return codeReviewWhy;
  if (booleanProp(prState, "draft")) return "GitHub reports this PR is still a draft.";
  const live = recordProp(summary, "githubLive");
  const totals = live ? recordProp(live, "checkTotals") : undefined;
  if (totals) {
    const failed = numberProp(totals, "failed") ?? 0;
    const active = numberProp(totals, "active") ?? 0;
    if (failed > 0) return `${failed} PR check(s) failed.`;
    if (active > 0) return `${active} PR check(s) are still running.`;
  }
  return textProp(summary, "finalReason")
    || textProp(summary, "reason")
    || textProp(item, "reason")
    || textProp(item, "phase")
    || "";
}

function titleForItem(
  item: Record<string, unknown>,
  summary: Record<string, unknown>,
  prState: Record<string, unknown> | undefined,
  identity: PrIdentity
): string {
  const directTitle = textProp(item, "title") || textProp(summary, "title");
  if (directTitle) return directTitle;
  const prTitle = prState ? textProp(prState, "title") : "";
  if (prTitle) return prTitle;
  const pullRequest = recordProp(summary, "pullRequest");
  const summaryTitle = pullRequest ? textProp(pullRequest, "title") : "";
  if (summaryTitle) return summaryTitle;
  const fallback = textProp(item, "reason") || textProp(summary, "finalReason") || textProp(item, "intent");
  if (fallback) return fallback.replace(/_/g, " ");
  if (identity.repo && identity.number) return `${identity.repo}#${identity.number}`;
  return "";
}

function tagsForItem(item: Record<string, unknown>, summary: Record<string, unknown>): string[] {
  const reviewSignals = recordProp(summary, "reviewSignals");
  const touchedAreas = reviewSignals ? arrayStrings(reviewSignals.touchedAreas) : [];
  const testCaseIds = arrayStrings(item.testCaseIds);
  return unique([...touchedAreas, ...testCaseIds]).slice(0, 6);
}

function boardCounts(
  cards: ReadonlyArray<HermesBoardCardSnapshot>,
  snapshot: Record<string, unknown>
): Record<string, number | string | boolean> {
  const counts: Record<string, number | string | boolean> = {
    attention: countLane(cards, "Needs Attention"),
    waiting: countLane(cards, "Waiting / Drafts"),
    codex: countLane(cards, "Codex Needed"),
    hermes: countLane(cards, "Hermes Checking"),
    operator: countLane(cards, "Operator Review"),
    queue: countLane(cards, "Release Queue"),
    deploying: countLane(cards, "Deploying"),
  };
  const sourceCounts = recordProp(snapshot, "counts");
  if (sourceCounts) {
    const active = numberProp(sourceCounts, "active");
    const running = numberProp(sourceCounts, "running");
    const recent = numberProp(sourceCounts, "recent");
    if (active !== undefined) counts.active = active;
    if (running !== undefined) counts.running = running;
    if (recent !== undefined) counts.recent = recent;
  }
  const codexTasks = recordProp(snapshot, "codexTasks");
  const codexTaskCounts = codexTasks ? recordProp(codexTasks, "counts") : undefined;
  if (codexTaskCounts) {
    const proposed = numberProp(codexTaskCounts, "proposed");
    const approved = numberProp(codexTaskCounts, "approved");
    const taskRunning = numberProp(codexTaskCounts, "running");
    if (proposed !== undefined) counts.codexTasksProposed = proposed;
    if (approved !== undefined) counts.codexTasksApproved = approved;
    if (taskRunning !== undefined) counts.codexTasksRunning = taskRunning;
  }
  return counts;
}

function boardHeadline(counts: Readonly<Record<string, number | string | boolean>>): string {
  const parts: string[] = [];
  const attention = numericCount(counts.attention);
  const waiting = numericCount(counts.waiting);
  const codex = numericCount(counts.codex);
  const operator = numericCount(counts.operator);
  const queue = numericCount(counts.queue);
  const deploying = numericCount(counts.deploying);
  if (attention > 0) parts.push(`${attention} blocked/attention item${attention === 1 ? "" : "s"}`);
  if (waiting > 0) parts.push(`${waiting} draft${waiting === 1 ? "" : "s"} parked`);
  if (codex > 0) parts.push(`${codex} Codex-owned item${codex === 1 ? "" : "s"}`);
  if (operator > 0) parts.push(`${operator} operator decision${operator === 1 ? "" : "s"}`);
  if (queue > 0) parts.push(`${queue} ready for merge stewardship`);
  if (deploying > 0) parts.push(`${deploying} deploy verification${deploying === 1 ? "" : "s"}`);
  return parts.length > 0
    ? `Board now: ${parts.join("; ")}.`
    : "Board now: no active PR handoffs need attention.";
}

function runnerSummary(snapshot: Record<string, unknown>): string {
  const codexTasks = recordProp(snapshot, "codexTasks");
  const runner = codexTasks ? recordProp(codexTasks, "runner") : undefined;
  if (!runner) return "";
  const status = textProp(runner, "status");
  const message = textProp(runner, "message");
  const stale = booleanProp(runner, "stale");
  return [status ? `status=${status}` : "", stale ? "stale=true" : "", message].filter(Boolean).join(" | ");
}

function activeCodexTaskMap(snapshot: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  const codexTasks = recordProp(snapshot, "codexTasks");
  const items = codexTasks ? arrayRecords(codexTasks.items) : [];
  for (const task of items) {
    const status = normalize(textProp(task, "status"));
    if (!status || TERMINAL_CODEX_STATUSES.has(status)) continue;
    const repo = textProp(task, "repo");
    const number = numberProp(task, "pullRequestNumber");
    if (!repo || !number) continue;
    result.set(`${repo}#${number}`, status);
  }
  return result;
}

function dedupeItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const summary = recordProp(item, "summary") ?? {};
    const prState = pullRequestState(item, summary);
    const identity = prIdentity(item, summary, prState);
    const key = identityKey(identity) || textProp(item, "correlationId");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function prIdentity(
  item: Record<string, unknown>,
  summary: Record<string, unknown>,
  prState?: Record<string, unknown>
): PrIdentity {
  const repo = textProp(item, "repo")
    || (prState ? textProp(prState, "repo") : "")
    || textProp(recordProp(summary, "pullRequest") ?? {}, "repo");
  const number = numberProp(item, "pullRequestNumber")
    ?? (prState ? numberProp(prState, "number") : undefined)
    ?? numberProp(recordProp(summary, "pullRequest") ?? {}, "number")
    ?? pullRequestNumberFromCorrelation(textProp(item, "correlationId"));
  return {
    ...(repo ? { repo } : {}),
    ...(number ? { number } : {}),
  };
}

function identityKey(identity: PrIdentity): string {
  return identity.repo && identity.number ? `${identity.repo}#${identity.number}` : "";
}

function pullRequestState(
  item: Record<string, unknown>,
  summary: Record<string, unknown>
): Record<string, unknown> | undefined {
  return recordProp(summary, "currentPullRequest")
    ?? recordProp(summary, "pullRequest")
    ?? recordProp(item, "pullRequest")
    ?? undefined;
}

function reviewReasons(summary: Record<string, unknown>): string[] {
  return arrayRecords(summary.reviewReasons)
    .map((reason) => {
      const message = textProp(reason, "message");
      const code = textProp(reason, "code");
      if (code && message) return `${code}: ${message}`;
      return message || code;
    })
    .filter(Boolean);
}

function isRunningItem(item: Record<string, unknown>, status: string): boolean {
  return status === "running" || booleanProp(item, "active") || normalize(textProp(item, "activeState")) === "running";
}

function isDonePrState(prState: Record<string, unknown> | undefined): boolean {
  if (!prState) return false;
  return booleanProp(prState, "merged") === true || normalize(textProp(prState, "state")) === "closed";
}

function ageLabelProp(item: Record<string, unknown>, snapshot: Record<string, unknown>): { ageLabel?: string } {
  const updatedAt = textProp(item, "updatedAt") || textProp(item, "startedAt");
  const generatedAt = textProp(snapshot, "generatedAt");
  if (!updatedAt || !generatedAt) return {};
  const updated = Date.parse(updatedAt);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(updated) || !Number.isFinite(generated) || generated < updated) return {};
  const minutes = Math.floor((generated - updated) / 60_000);
  if (minutes < 2) return { ageLabel: "fresh" };
  if (minutes < 60) return { ageLabel: `${minutes}m` };
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return { ageLabel: `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}` };
}

function stringProp<T extends string>(record: Record<string, unknown>, key: string, outputKey: T): Partial<Record<T, string>> {
  const value = textProp(record, key);
  return value ? { [outputKey]: value } as Partial<Record<T, string>> : {};
}

function countLane(cards: ReadonlyArray<HermesBoardCardSnapshot>, lane: string): number {
  return cards.filter((card) => card.lane === lane).length;
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordProp(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function textProp(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberProp(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanProp(record: Record<string, unknown> | undefined, key: string): boolean {
  return Boolean(record && record[key] === true);
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pullRequestNumberFromCorrelation(correlationId: string): number | undefined {
  const match = correlationId.match(/(?:^|-)pr-([0-9]+)(?:-|$)/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
