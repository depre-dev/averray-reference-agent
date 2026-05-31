import type { AlertChannel, AlertPayload } from "./alert-bridge.js";
import type { AutonomyState } from "./autonomy-mode.js";
import { taskAgent, type CodexTask } from "./codex-task-queue.js";
import type { BoardCard } from "./monitor-v2.js";
import {
  createHermesDecisionRecord,
  whyHermesLine,
  type HermesDecisionRecord,
} from "@avg/averray-mcp/decision-records";

export interface AutopilotAwayDigestTrackerState {
  active?: AutopilotAwaySession;
  emittedSessionIds: string[];
}

export interface AutopilotAwaySession {
  sessionId: string;
  startedAt: string;
  setBy?: string;
  until?: string;
}

export interface EndedAutopilotAwaySession extends AutopilotAwaySession {
  endedAt: string;
  endedBy: string;
}

export interface AutopilotAwayDigestObservation {
  now: Date;
  autonomy: AutonomyState;
  suspended?: boolean;
  halt?: boolean;
  endedAutonomy?: AutonomyState;
  endedBy?: string;
}

export interface AutopilotAuditEvent {
  at: string;
  commandText?: string;
  result?: Record<string, unknown>;
}

export type AwayDigestBoardCard = Pick<
  BoardCard,
  "id" | "lane" | "title" | "summary" | "repo" | "agentType" | "waitingOn" | "state" | "next"
>;

export interface AutopilotAwayDigestItem {
  id: string;
  title: string;
  repo?: string;
  agent?: string;
  riskTier?: string;
  reason?: string;
  status?: string;
  at?: string;
}

export interface AutopilotAwayDigest {
  schemaVersion: 1;
  kind: "autopilot_away_digest";
  generatedAt: string;
  mutates: false;
  session: EndedAutopilotAwaySession;
  headline: string;
  counts: {
    routed: number;
    autoApproved: number;
    escalated: number;
    openedPrs: number;
    failures: number;
    d3Suspends: number;
    waitingOnOperator: number;
  };
  routed: AutopilotAwayDigestItem[];
  autoApproved: AutopilotAwayDigestItem[];
  escalated: AutopilotAwayDigestItem[];
  openedPrs: AutopilotAwayDigestItem[];
  failures: AutopilotAwayDigestItem[];
  d3Suspends: AutopilotAwayDigestItem[];
  waitingOnOperator: AutopilotAwayDigestItem[];
  recommendedNextActions: string[];
  decisionRecord: HermesDecisionRecord;
  safety: {
    readOnly: true;
    mutatesGithub: false;
    mutatesAverray: false;
    editsWikipedia: false;
  };
}

export interface BuildAutopilotAwayDigestInput {
  session: EndedAutopilotAwaySession;
  generatedAt: Date;
  tasks: CodexTask[];
  auditEvents: AutopilotAuditEvent[];
  boardCards: AwayDigestBoardCard[];
}

export interface DeliverAutopilotAwayDigestDeps {
  session: EndedAutopilotAwaySession;
  now: () => Date;
  boardUrl: string;
  loadTasks: () => Promise<CodexTask[]>;
  loadAuditEvents: (startedAt: string, endedAt: string) => Promise<AutopilotAuditEvent[]>;
  loadBoardCards: () => Promise<AwayDigestBoardCard[]>;
  recordBoardDigest: (digest: AutopilotAwayDigest, text: string) => Promise<void>;
  alert: AlertChannel;
  auditDigest: (digest: AutopilotAwayDigest) => Promise<void>;
}

export function initialAutopilotAwayDigestTrackerState(): AutopilotAwayDigestTrackerState {
  return { emittedSessionIds: [] };
}

export function observeAutopilotAwayDigestSession(
  state: AutopilotAwayDigestTrackerState,
  observation: AutopilotAwayDigestObservation,
): { state: AutopilotAwayDigestTrackerState; ended?: EndedAutopilotAwaySession } {
  const nowIso = observation.now.toISOString();
  const activeAutopilot = observation.autonomy.mode === "autopilot" && !observation.suspended && !observation.halt;

  if (activeAutopilot) {
    const active = sessionFromAutonomy(observation.autonomy, nowIso);
    return {
      state: {
        ...state,
        active,
      },
    };
  }

  const active = state.active ?? (
    observation.endedAutonomy && observation.endedAutonomy.mode === "autopilot"
      ? sessionFromAutonomy(observation.endedAutonomy, nowIso)
      : undefined
  );
  if (!active) return { state: { ...state, active: undefined } };

  if (state.emittedSessionIds.includes(active.sessionId)) {
    return { state: { ...state, active: undefined } };
  }

  const ended: EndedAutopilotAwaySession = {
    ...active,
    endedAt: nowIso,
    endedBy: observation.endedBy ?? inferEndedBy(observation),
  };
  return {
    state: {
      active: undefined,
      emittedSessionIds: [...state.emittedSessionIds, active.sessionId],
    },
    ended,
  };
}

export function buildAutopilotAwayDigest(input: BuildAutopilotAwayDigestInput): AutopilotAwayDigest {
  const startMs = Date.parse(input.session.startedAt);
  const endMs = Date.parse(input.session.endedAt);
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));

  const routed = input.tasks
    .filter((task) => inWindow(task.createdAt, startMs, endMs))
    .map(taskItem);

  const autoApproved = input.tasks
    .filter((task) => task.approvedBy === "hermes-autopilot" && inWindow(task.approvedAt, startMs, endMs))
    .map(taskItem);

  const escalated = input.auditEvents
    .filter((event) => inWindow(event.at, startMs, endMs) && event.result?.kind === "autopilot_auto_approval" && event.result.action === "escalated")
    .map((event) => auditTaskItem(event, tasksById));

  const d3Suspends = input.auditEvents
    .filter((event) => inWindow(event.at, startMs, endMs) && event.result?.kind === "anomaly_autopause")
    .map((event) => ({
      id: stringValue(event.result?.reason) ?? event.commandText ?? "d3-suspend",
      title: stringValue(event.result?.message) ?? stringValue(event.result?.reason) ?? "Autopilot suspended by anomaly guard",
      reason: stringValue(event.result?.reason),
      at: event.at,
    }));

  const failures = input.tasks
    .filter((task) => inWindow(task.failedAt, startMs, endMs))
    .map(taskItem);

  const openedPrs = input.tasks
    .filter((task) => task.status === "completed" && inWindow(task.completedAt ?? task.updatedAt, startMs, endMs) && taskPullNumber(task) !== undefined)
    .map((task) => ({
      ...taskItem(task),
      title: `${task.repo}#${taskPullNumber(task)} opened/updated by ${taskAgent(task)}`,
    }));

  const waitingOnOperator = input.boardCards
    .filter((card) => card.lane === "needs-attention" || card.lane === "operator-review" || card.waitingOn?.actor === "operator")
    .map((card) => ({
      id: card.id,
      title: card.title,
      repo: card.repo,
      agent: card.agentType,
      status: card.lane,
      reason: card.next ?? card.summary,
    }));

  const counts = {
    routed: routed.length,
    autoApproved: autoApproved.length,
    escalated: escalated.length,
    openedPrs: openedPrs.length,
    failures: failures.length,
    d3Suspends: d3Suspends.length,
    waitingOnOperator: waitingOnOperator.length,
  };

  const recommendedNextActions = recommendedNextActionsFor({ waitingOnOperator, escalated, failures, openedPrs, autoApproved });
  const decisionRecord = createHermesDecisionRecord({
    kind: "away_digest",
    subject: { type: "autopilot_session", id: input.session.sessionId },
    decision: "reported",
    reasons: [
      `Autopilot session ended because ${input.session.endedBy}.`,
      `Hermes summarized ${counts.routed} routed, ${counts.autoApproved} auto-approved, ${counts.escalated} escalated, and ${counts.waitingOnOperator} waiting item(s).`,
      recommendedNextActions[0] ?? "Nothing needs operator action right now.",
    ],
    inputs: {
      counts,
      session: input.session,
      waitingOnOperator: waitingOnOperator.slice(0, 5),
      escalated: escalated.slice(0, 5),
      failures: failures.slice(0, 5),
      d3Suspends: d3Suspends.slice(0, 5),
      wouldChangeDecision: "No digest would be emitted until the autopilot session ended or was interrupted.",
    },
    outcome: {
      summary: "Hermes emitted an away digest for the operator.",
      waitingNext: recommendedNextActions[0] ?? "Nothing needs operator action right now.",
    },
    safety: {
      readOnly: true,
      mutates: false,
      mutatesGithub: false,
      mutatesAverray: false,
      editsWikipedia: false,
    },
    generatedAt: input.generatedAt,
  });

  return {
    schemaVersion: 1,
    kind: "autopilot_away_digest",
    generatedAt: input.generatedAt.toISOString(),
    mutates: false,
    session: input.session,
    headline: headlineFor(counts),
    counts,
    routed,
    autoApproved,
    escalated,
    openedPrs,
    failures,
    d3Suspends,
    waitingOnOperator,
    recommendedNextActions,
    decisionRecord,
    safety: {
      readOnly: true,
      mutatesGithub: false,
      mutatesAverray: false,
      editsWikipedia: false,
    },
  };
}

export function formatAutopilotAwayDigestForOperator(digest: AutopilotAwayDigest): string {
  const lines = [
    digest.headline,
    `Window: ${digest.session.startedAt} -> ${digest.session.endedAt} (${digest.session.endedBy}).`,
    `Hermes routed ${digest.counts.routed}, auto-approved ${digest.counts.autoApproved}, escalated ${digest.counts.escalated}, opened/updated ${digest.counts.openedPrs} PR task(s), and left ${digest.counts.waitingOnOperator} item(s) waiting on you.`,
    whyHermesLine(digest.decisionRecord),
  ];

  if (digest.autoApproved.length > 0) {
    lines.push(`Auto-approved: ${digest.autoApproved.slice(0, 3).map(shortItem).join("; ")}`);
  }
  if (digest.escalated.length > 0) {
    lines.push(`Escalated: ${digest.escalated.slice(0, 3).map(shortItem).join("; ")}`);
  }
  if (digest.failures.length > 0 || digest.d3Suspends.length > 0) {
    lines.push(`Interruptions: ${[...digest.failures, ...digest.d3Suspends].slice(0, 3).map(shortItem).join("; ")}`);
  }
  if (digest.waitingOnOperator.length > 0) {
    lines.push(`Waiting on you: ${digest.waitingOnOperator.slice(0, 3).map(shortItem).join("; ")}`);
  }
  lines.push(`Next: ${digest.recommendedNextActions[0] ?? "Nothing needs you right now."}`);
  return lines.join("\n");
}

export function buildAutopilotAwayDigestAlertPayload(digest: AutopilotAwayDigest, boardUrl: string): AlertPayload {
  return {
    count: digest.counts.waitingOnOperator + digest.counts.escalated + digest.counts.failures + digest.counts.d3Suspends,
    items: digest.waitingOnOperator.slice(0, 5).map((item) => ({ id: item.id, title: item.title })),
    boardUrl,
    text: `${formatAutopilotAwayDigestForOperator(digest)}\nBoard: ${boardUrl}`,
  };
}

export async function deliverAutopilotAwayDigest(deps: DeliverAutopilotAwayDigestDeps): Promise<AutopilotAwayDigest> {
  const [tasks, auditEvents, boardCards] = await Promise.all([
    deps.loadTasks(),
    deps.loadAuditEvents(deps.session.startedAt, deps.session.endedAt),
    deps.loadBoardCards(),
  ]);
  const digest = buildAutopilotAwayDigest({
    session: deps.session,
    generatedAt: deps.now(),
    tasks,
    auditEvents,
    boardCards,
  });
  const text = formatAutopilotAwayDigestForOperator(digest);
  await deps.recordBoardDigest(digest, text);
  await deps.alert.dispatch(buildAutopilotAwayDigestAlertPayload(digest, deps.boardUrl));
  await deps.auditDigest(digest);
  return digest;
}

function sessionFromAutonomy(autonomy: AutonomyState, fallbackStartedAt: string): AutopilotAwaySession {
  const startedAt = autonomy.setAt ?? fallbackStartedAt;
  return {
    sessionId: `autopilot:${startedAt}`,
    startedAt,
    ...(autonomy.setBy ? { setBy: autonomy.setBy } : {}),
    ...(autonomy.until ? { until: autonomy.until } : {}),
  };
}

function inferEndedBy(observation: AutopilotAwayDigestObservation): string {
  if (observation.suspended) return "d3-suspend";
  if (observation.halt) return "halt";
  return observation.autonomy.setBy ?? "supervised";
}

function inWindow(value: string | undefined, startMs: number, endMs: number): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
}

function taskItem(task: CodexTask): AutopilotAwayDigestItem {
  return {
    id: task.id,
    title: task.title ?? task.reason ?? firstLine(task.prompt),
    repo: task.repo,
    agent: taskAgent(task),
    ...(task.riskTier ? { riskTier: task.riskTier } : {}),
    ...((task.routingReason ?? task.reason) ? { reason: task.routingReason ?? task.reason } : {}),
    status: task.status,
    at: task.approvedAt ?? task.completedAt ?? task.failedAt ?? task.createdAt,
  };
}

function auditTaskItem(event: AutopilotAuditEvent, tasksById: Map<string, CodexTask>): AutopilotAwayDigestItem {
  const taskId = stringValue(event.result?.taskId) ?? event.commandText ?? "autopilot-escalation";
  const task = tasksById.get(taskId);
  if (task) {
    return {
      ...taskItem(task),
      reason: stringValue(event.result?.detail) ?? stringValue(event.result?.reason) ?? task.routingReason ?? task.reason,
      at: event.at,
    };
  }
  return {
    id: taskId,
    title: stringValue(event.result?.title) ?? taskId,
    repo: stringValue(event.result?.repo),
    agent: stringValue(event.result?.agent),
    riskTier: stringValue(event.result?.riskTier),
    reason: stringValue(event.result?.detail) ?? stringValue(event.result?.reason),
    status: stringValue(event.result?.action),
    at: event.at,
  };
}

function taskPullNumber(task: CodexTask): number | undefined {
  const fromSummary = task.completionSummary?.match(/(?:pull\/|#)(\d{1,6})\b/i)?.[1];
  if (fromSummary) return Number.parseInt(fromSummary, 10);
  return task.pullRequestNumber;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || "Codex task";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headlineFor(counts: AutopilotAwayDigest["counts"]): string {
  const total = counts.routed + counts.autoApproved + counts.escalated + counts.openedPrs + counts.failures + counts.d3Suspends + counts.waitingOnOperator;
  if (total === 0) return "While you were away: autopilot ended, and nothing needed action.";
  return `While you were away: autopilot ended with ${counts.autoApproved} auto-approved, ${counts.escalated} escalated, and ${counts.waitingOnOperator} waiting on you.`;
}

function recommendedNextActionsFor(input: {
  waitingOnOperator: AutopilotAwayDigestItem[];
  escalated: AutopilotAwayDigestItem[];
  failures: AutopilotAwayDigestItem[];
  openedPrs: AutopilotAwayDigestItem[];
  autoApproved: AutopilotAwayDigestItem[];
}): string[] {
  const firstWaiting = input.waitingOnOperator[0];
  if (firstWaiting) return [`Review ${firstWaiting.title}; it is waiting on ${firstWaiting.status ?? "operator action"}.`];
  const firstEscalated = input.escalated[0];
  if (firstEscalated) return [`Decide the escalated item ${firstEscalated.title}.`];
  const firstFailure = input.failures[0];
  if (firstFailure) return [`Inspect the failed task ${firstFailure.title}.`];
  if (input.openedPrs.length > 0) return ["Review the PRs opened while autopilot was engaged."];
  if (input.autoApproved.length > 0) return ["No operator action is waiting; skim the auto-approved work when convenient."];
  return ["Nothing needs you right now."];
}

function shortItem(item: AutopilotAwayDigestItem): string {
  const suffix = item.reason ? ` (${item.reason})` : "";
  return `${item.title}${suffix}`;
}
