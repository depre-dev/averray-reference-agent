import type { BoardCard, RiskTag } from "./monitor-v2.js";

export type BacklogSuggestionOwner = "codex" | "claude" | "operator" | "hermes";
export type BacklogSuggestionRiskTier = "low" | "high";

export interface BacklogSuggestionRelated {
  cardId: string;
  repo?: string;
  pullRequestNumber?: number;
  correlationId?: string;
  missionTarget?: string;
  missionVerdict?: string;
}

export interface BacklogSuggestion {
  id: string;
  title: string;
  reason: string;
  suggestedOwner: BacklogSuggestionOwner;
  riskTier: BacklogSuggestionRiskTier;
  related: BacklogSuggestionRelated;
  suggestedPrompt?: string;
  confidence: number;
  evidence: string[];
}

export interface BacklogSuggestionsSafety {
  readOnly: true;
  createsTasks: false;
  approvesTasks: false;
  mutatesGithub: false;
  mutatesSlack: false;
  mutatesTaskQueue: false;
}

export interface BacklogSuggestionsResponse {
  generatedAt: string;
  suggestions: BacklogSuggestion[];
  safety: BacklogSuggestionsSafety;
  source: {
    cardsRead: number;
    source: "monitor_v2_board";
  };
}

const HIGH_RISK_TAGS = new Set<RiskTag>(["contracts", "secrets", "indexer", "xcm", "config"]);

export function buildBacklogSuggestionsResponse(
  cards: readonly BoardCard[],
  options: { now?: Date; limit?: number } = {},
): BacklogSuggestionsResponse {
  const suggestions = suggestBacklogFromCards(cards, { limit: options.limit });
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    suggestions,
    safety: {
      readOnly: true,
      createsTasks: false,
      approvesTasks: false,
      mutatesGithub: false,
      mutatesSlack: false,
      mutatesTaskQueue: false,
    },
    source: {
      cardsRead: cards.length,
      source: "monitor_v2_board",
    },
  };
}

export function suggestBacklogFromCards(
  cards: readonly BoardCard[],
  options: { limit?: number } = {},
): BacklogSuggestion[] {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 10));
  const suggestions: BacklogSuggestion[] = [];

  for (const card of cards) {
    if (card.type === "done") continue;
    const suggestion =
      highRiskReviewSuggestion(card) ??
      failedMissionSuggestion(card) ??
      staleDraftSuggestion(card) ??
      failedTaskSuggestion(card);
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions
    .sort((a, b) => scoreSuggestion(b) - scoreSuggestion(a))
    .slice(0, limit);
}

function highRiskReviewSuggestion(card: BoardCard): BacklogSuggestion | undefined {
  if (!isHighRiskCard(card)) return undefined;
  return {
    id: suggestionId("operator-review", card),
    title: `Review high-risk follow-up for ${card.title}`,
    reason: "The card touches a high-risk surface, so backlog planning should escalate to the operator before any agent work is proposed.",
    suggestedOwner: "operator",
    riskTier: "high",
    related: relatedFor(card),
    confidence: 0.9,
    evidence: compact([
      `card:${card.id}`,
      `risk:${card.risk.join(",") || "high"}`,
      card.riskTier ? `riskTier:${card.riskTier}` : undefined,
      highSeveritySignal(card),
      criticalFileEvidence(card),
    ]),
  };
}

function failedMissionSuggestion(card: BoardCard): BacklogSuggestion | undefined {
  if (card.type !== "mission") return undefined;
  const mission = card.mission;
  if (!mission) return undefined;
  const verdict = card.mission?.verdict;
  if (verdict !== "FAILED" && verdict !== "PARTIAL") return undefined;
  const blocker = mission.blockers[0];
  const recommendation = mission.recommendations[0];
  const target = mission.target;
  const prompt = [
    `Investigate and propose a product fix for the failed testbed mission "${card.title}".`,
    target ? `Target: ${target}.` : undefined,
    blocker ? `Top blocker: ${blocker.head} — ${blocker.body}` : undefined,
    recommendation ? `Recommendation from mission: ${recommendation}` : undefined,
    "Keep the work narrow, preserve the product truth boundary, and open a PR for operator review.",
  ].filter(Boolean).join("\n");

  return {
    id: suggestionId("failed-mission", card),
    title: `Follow up failed mission: ${card.title}`,
    reason: `The latest testbed mission verdict is ${verdict}; a human-readable fix or rerun plan would keep the evidence loop moving.`,
    suggestedOwner: "claude",
    riskTier: "low",
    related: relatedFor(card),
    suggestedPrompt: prompt,
    confidence: verdict === "FAILED" ? 0.86 : 0.76,
    evidence: compact([
      `card:${card.id}`,
      `missionVerdict:${verdict}`,
      target ? `target:${target}` : undefined,
      blocker ? `blocker:${blocker.head}` : undefined,
    ]),
  };
}

function staleDraftSuggestion(card: BoardCard): BacklogSuggestion | undefined {
  if (card.type !== "draft" && !card.isDraft) return undefined;
  if (card.state !== "stale" && !card.archiveHint && card.freshness < 24 * 60) return undefined;
  return {
    id: suggestionId("stale-draft", card),
    title: `Decide stale draft next step: ${card.title}`,
    reason: "This draft is stale. The safe next step is to ask the PR author for status or explicitly approve a takeover; Hermes should not auto-create agent work.",
    suggestedOwner: "operator",
    riskTier: isHighRiskCard(card) ? "high" : "low",
    related: relatedFor(card),
    confidence: 0.72,
    evidence: compact([
      `card:${card.id}`,
      `freshnessMinutes:${card.freshness}`,
      card.archiveHint ? "archiveHint:true" : undefined,
      `waitingOn:${card.waitingOn.actor}`,
    ]),
  };
}

function failedTaskSuggestion(card: BoardCard): BacklogSuggestion | undefined {
  if (card.type !== "task" || card.taskStatus !== "failed") return undefined;
  const owner = card.agentType === "claude" ? "claude" : "codex";
  return {
    id: suggestionId("failed-task", card),
    title: `Plan retry for failed task: ${card.title}`,
    reason: "A dispatched task failed. Suggest a narrow retry plan, but leave task creation and approval to the operator.",
    suggestedOwner: owner,
    riskTier: card.riskTier === "high" ? "high" : "low",
    related: relatedFor(card),
    suggestedPrompt: [
      `Investigate the failed task "${card.title}" and propose the smallest safe fix.`,
      card.failureReason ? `Failure reason: ${card.failureReason}` : undefined,
      card.output ? `Recent output: ${card.output.slice(0, 800)}` : undefined,
      "Do not merge or deploy; open a PR for operator review if code changes are needed.",
    ].filter(Boolean).join("\n"),
    confidence: 0.78,
    evidence: compact([
      `card:${card.id}`,
      `taskStatus:${card.taskStatus}`,
      card.failureReason ? `failure:${card.failureReason}` : undefined,
    ]),
  };
}

function scoreSuggestion(suggestion: BacklogSuggestion): number {
  const riskBoost = suggestion.riskTier === "high" ? 0.2 : 0;
  const ownerBoost = suggestion.suggestedOwner === "operator" ? 0.1 : 0;
  return suggestion.confidence + riskBoost + ownerBoost;
}

function isHighRiskCard(card: BoardCard): boolean {
  return card.riskTier === "high"
    || card.risk.some((risk) => HIGH_RISK_TAGS.has(risk))
    || (card.files ?? []).some((file) => file.critical)
    || (card.riskSignals ?? []).some((signal) => signal.severity === "high");
}

function relatedFor(card: BoardCard): BacklogSuggestionRelated {
  return {
    cardId: card.id,
    ...(card.repo ? { repo: card.repo } : {}),
    ...(pullRequestNumberFor(card) ? { pullRequestNumber: pullRequestNumberFor(card) } : {}),
    ...(card.decisionRecord?.id ? { correlationId: card.decisionRecord.id } : {}),
    ...(card.type === "mission" && card.mission?.target ? { missionTarget: card.mission.target } : {}),
    ...(card.type === "mission" && card.mission?.verdict ? { missionVerdict: card.mission.verdict } : {}),
  };
}

function pullRequestNumberFor(card: BoardCard): number | undefined {
  const subjectNumber = card.decisionRecord?.subject.pullRequestNumber;
  if (typeof subjectNumber === "number" && Number.isInteger(subjectNumber) && subjectNumber > 0) return subjectNumber;
  const match = card.id.match(/#(\d+)\b/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function suggestionId(prefix: string, card: BoardCard): string {
  return `${prefix}:${card.id}`.toLowerCase().replace(/[^a-z0-9:#-]+/g, "-").slice(0, 96);
}

function highSeveritySignal(card: BoardCard): string | undefined {
  const signal = (card.riskSignals ?? []).find((entry) => entry.severity === "high");
  return signal ? `riskSignal:${signal.code}` : undefined;
}

function criticalFileEvidence(card: BoardCard): string | undefined {
  const file = (card.files ?? []).find((entry) => entry.critical);
  return file ? `criticalFile:${file.path}` : undefined;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
