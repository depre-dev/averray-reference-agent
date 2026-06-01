import type { BoardNowBanner } from "./board-state.js";
import type {
  AgentType,
  BoardCard,
  CardReviewRequest,
  HermesDecisionRecord,
} from "./card-types.js";
import type { CollaborationAuthor, CollaborationMessage } from "./collaboration.js";
import { actorLabel, formatTurnTime, relatedPrForCard } from "./collaboration.js";
import { humanizeSignalText } from "./signal-labels.js";

export type ActivityTone = "neutral" | "info" | "action" | "success" | "warning";

export interface HermesActivityEntry {
  id: string;
  atMs: number;
  source: "board" | "decision" | "collaboration" | "review" | "summary";
  tone: ActivityTone;
  actor: CollaborationAuthor;
  kindLabel: "narration" | "question" | "reply" | "proposal" | "request" | "status";
  text: string;
  meta?: string;
  cardId?: string;
  suggestions?: string[];
}

export interface BuildHermesActivityFeedInput {
  cards: readonly BoardCard[];
  messages: readonly CollaborationMessage[];
  banner: BoardNowBanner;
  boardAt?: string;
  now?: () => number;
  limit?: number;
}

const DEFAULT_LIMIT = 12;

export function buildHermesActivityFeed(input: BuildHermesActivityFeedInput): HermesActivityEntry[] {
  const now = input.now ?? Date.now;
  const boardAtMs = parseTime(input.boardAt) ?? now();
  const entries: HermesActivityEntry[] = [];

  for (const card of input.cards) {
    entries.push(...cardActivity(card, boardAtMs));
    if (card.decisionRecord) entries.push(decisionRecordActivity(card, card.decisionRecord, boardAtMs));
    entries.push(...reviewRequestActivity(card));
  }

  for (const message of input.messages) {
    entries.push(collaborationActivity(message, cardIdForMessage(message, input.cards)));
  }

  const deduped = dedupeEntries(entries)
    .sort((a, b) => a.atMs - b.atMs)
    .slice(-clampLimit(input.limit));

  if (deduped.length === 0) {
    deduped.push({
      id: "activity-empty",
      atMs: boardAtMs,
      source: "summary",
      tone: "neutral",
      actor: "hermes",
      kindLabel: "narration",
      text: "No real Hermes activity has been logged yet. New board events and card-scoped coordination will appear here.",
      meta: "waiting for events",
    });
  }

  deduped.push(summaryActivity(input.banner, now()));
  return deduped;
}

function cardActivity(card: BoardCard, boardAtMs: number): HermesActivityEntry[] {
  const atMs = estimateCardTime(card, boardAtMs);
  const entries: HermesActivityEntry[] = [];
  if (card.type === "task" && card.taskStatus) {
    const label = agentLabel(card.agentType);
    const title = cardTitle(card);
    if (card.taskStatus === "proposed") {
      entries.push({
        id: `task:${card.id}:proposed`,
        atMs,
        source: "board",
        tone: "action",
        actor: "hermes",
        kindLabel: "narration",
        text: `Proposed ${label} work for ${title}; waiting on your dispatch decision.`,
        meta: card.riskTier ? `${card.riskTier} risk` : "task proposed",
        cardId: card.id,
        suggestions: ["Why this route?", "Show dispatch guardrails"],
      });
    } else if (card.taskStatus === "approved") {
      entries.push({
        id: `task:${card.id}:approved`,
        atMs,
        source: "board",
        tone: "info",
        actor: "hermes",
        kindLabel: "narration",
        text: `Dispatched ${label} work for ${title}; the runner can claim it when available.`,
        meta: "dispatch approved",
        cardId: card.id,
      });
    } else if (card.taskStatus === "running") {
      entries.push({
        id: `task:${card.id}:running`,
        atMs,
        source: "board",
        tone: "info",
        actor: "hermes",
        kindLabel: "narration",
        text: `${label} is working on ${title}; Hermes is watching for progress or a PR.`,
        meta: "runner active",
        cardId: card.id,
      });
    } else if (card.taskStatus === "failed") {
      entries.push({
        id: `task:${card.id}:failed`,
        atMs,
        source: "board",
        tone: "warning",
        actor: "hermes",
        kindLabel: "narration",
        text: `${label} work failed on ${title}; operator triage is needed before retrying or splitting it.`,
        meta: card.failureReason ?? "task failed",
        cardId: card.id,
        suggestions: ["Show failure evidence", "Should this be split?"],
      });
    }
  }

  if (card.isAction && card.lane === "needs-attention") {
    entries.push({
      id: `action:${card.id}:${card.summary}`,
      atMs,
      source: "board",
      tone: "action",
      actor: "hermes",
      kindLabel: "narration",
      text: `Escalated ${cardTitle(card)} to you: ${plain(card.summary) || "Hermes needs an operator decision."}`,
      meta: "needs your call",
      cardId: card.id,
      suggestions: ["Summarize what needs review", "What happens if I dismiss this?"],
    });
  }

  if (card.type === "done" && card.mergeStatus) {
    entries.push({
      id: `done:${card.id}:${card.mergeStatus}`,
      atMs,
      source: "board",
      tone: card.mergeStatus === "MERGED" ? "success" : "neutral",
      actor: "hermes",
      kindLabel: "narration",
      text: `${card.mergeStatus === "MERGED" ? "Merged" : "Closed"} ${cardTitle(card)}; it is now release history.`,
      meta: card.closedAt ? formatDateMeta(card.closedAt) : "done",
      cardId: card.id,
    });
  }

  return entries;
}

function decisionRecordActivity(
  card: BoardCard,
  record: HermesDecisionRecord,
  boardAtMs: number,
): HermesActivityEntry {
  const atMs = parseTime(record.generatedAt) ?? boardAtMs;
  const reason = record.reasons[0] ?? record.outcome.summary;
  const waiting = record.outcome.waitingNext ? ` Waiting next: ${record.outcome.waitingNext}` : "";
  return {
    id: `decision:${record.id}`,
    atMs,
    source: "decision",
    tone: toneForDecision(record),
    actor: "hermes",
    kindLabel: "narration",
    text: `${decisionVerb(record)} ${cardTitle(card)}: ${plain(reason)}.${waiting}`,
    meta: record.kind.replace(/_/g, " "),
    cardId: card.id,
    suggestions: ["Why this decision?", "What would change it?"],
  };
}

function reviewRequestActivity(card: BoardCard): HermesActivityEntry[] {
  const requests = card.reviewRequests ?? [];
  return requests.map((request) => {
    const panel = request.reviewMode === "panel" || (request.panelSize ?? 0) > 1;
    const atMs = parseTime(request.response?.respondedAt ?? request.updatedAt ?? request.createdAt) ?? Date.now();
    if (request.response) {
      return {
        id: `review:${request.id}:response:${request.response.respondedAt}`,
        atMs,
        source: "review",
        tone: request.response.verdict === "block" ? "action" : request.response.verdict === "concern" ? "warning" : "success",
        actor: "hermes",
        kindLabel: "narration",
        text: `${agentLabel(request.reviewer)} returned a ${request.response.verdict} review on ${cardTitle(card)}: ${plain(request.response.reasoning)}`,
        meta: panel ? "reviewer panel" : "review response",
        cardId: card.id,
        suggestions: request.response.verdict === "block" ? ["What blocks this?", "Summarize panel verdicts"] : undefined,
      };
    }
    return {
      id: `review:${request.id}:requested`,
      atMs,
      source: "review",
      tone: panel ? "action" : "info",
      actor: "hermes",
      kindLabel: "narration",
      text: `${agentLabel(request.requestedBy)} requested ${panel ? "a reviewer panel" : `${agentLabel(request.reviewer)} review`} for ${cardTitle(card)}: ${plain(request.reason)}`,
      meta: panel ? "panel requested" : "review requested",
      cardId: card.id,
      suggestions: ["Why request review?", "What should I check?"],
    };
  });
}

function collaborationActivity(message: CollaborationMessage, cardId: string | undefined): HermesActivityEntry {
  const actor = actorLabel(message.author);
  const target = message.addressedTo === "everyone" ? "the room" : actorLabel(message.addressedTo);
  const scope = message.relatedPr
    ? ` on ${message.relatedPr.repo}#${message.relatedPr.number}`
    : message.relatedCorrelationId
      ? ` for ${message.relatedCorrelationId}`
      : "";
  const verb =
    message.kind === "request_help"
      ? "asked for help"
      : message.kind === "proposal"
        ? "proposed"
        : message.kind === "status"
          ? "reported"
          : "said";
  return {
    id: `collaboration:${message.id}`,
    atMs: message.ts,
    source: "collaboration",
    tone: message.kind === "request_help" ? "action" : message.kind === "proposal" ? "info" : "neutral",
    actor: message.author,
    kindLabel: collaborationKindLabel(message),
    text: `${actor} ${verb}${scope} to ${target}: ${plain(message.text)}`,
    meta: `${message.kind} · ${formatTurnTime(message.ts)}`,
    ...(cardId ? { cardId } : {}),
  };
}

function summaryActivity(banner: BoardNowBanner, nowMs: number): HermesActivityEntry {
  const text =
    banner.tone === "action"
      ? `Needs you: review the current action lane${banner.primaryActionId ? `, starting with ${banner.primaryActionId}` : ""}.`
      : banner.tone === "hermes-focus"
        ? `Hermes is answering the active review thread${banner.primaryActionId ? ` for ${banner.primaryActionId}` : ""}.`
      : banner.tone === "degraded"
        ? "Needs you: reconnect or verify freshness before approving anything."
        : "Needs you: nothing right now.";
  return {
    id: "activity-current-summary",
    atMs: nowMs,
    source: "summary",
    tone: banner.tone === "action" || banner.tone === "hermes-focus" ? "action" : banner.tone === "degraded" ? "warning" : "success",
    actor: "hermes",
    kindLabel: "narration",
    text,
    meta: banner.sub,
    ...(banner.primaryActionId ? { cardId: banner.primaryActionId } : {}),
    ...(banner.primaryActionId && (banner.tone === "action" || banner.tone === "hermes-focus")
      ? { suggestions: ["Summarize the top card", "What decision is pending?"] }
      : {}),
  };
}

function collaborationKindLabel(message: CollaborationMessage): HermesActivityEntry["kindLabel"] {
  if (message.author === "operator") return "question";
  if (message.author === "hermes") return "reply";
  if (message.kind === "proposal") return "proposal";
  if (message.kind === "request_help") return "request";
  return "status";
}

function cardIdForMessage(message: CollaborationMessage, cards: readonly BoardCard[]): string | undefined {
  for (const card of cards) {
    const relatedPr = relatedPrForCard(card);
    if (
      relatedPr
      && message.relatedPr?.repo === relatedPr.repo
      && message.relatedPr.number === relatedPr.number
    ) {
      return card.id;
    }
    const correlation = card.correlationId ?? card.id;
    if (message.relatedCorrelationId && message.relatedCorrelationId === correlation) {
      return card.id;
    }
  }
  return undefined;
}

function decisionVerb(record: HermesDecisionRecord): string {
  switch (record.kind) {
    case "routing": return "Routed";
    case "auto_approval": return record.decision.toLowerCase().includes("approved") ? "Approved dispatch for" : "Checked dispatch for";
    case "escalation": return "Escalated";
    case "anomaly_pause": return "Paused automation around";
    case "away_digest": return "Reported";
  }
}

function toneForDecision(record: HermesDecisionRecord): ActivityTone {
  if (record.kind === "escalation" || record.kind === "anomaly_pause") return "action";
  if (record.kind === "auto_approval" && record.safety.mutates) return "info";
  if (record.kind === "away_digest") return "neutral";
  return "info";
}

function estimateCardTime(card: BoardCard, boardAtMs: number): number {
  const freshnessMs = Math.max(0, card.freshness || 0) * 60_000;
  return boardAtMs - freshnessMs;
}

function dedupeEntries(entries: readonly HermesActivityEntry[]): HermesActivityEntry[] {
  const byId = new Map<string, HermesActivityEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing || existing.atMs <= entry.atMs) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function plain(value: string | undefined): string {
  return humanizeSignalText(value).replace(/\s+/g, " ").trim();
}

function cardTitle(card: BoardCard): string {
  return card.title || card.id;
}

function agentLabel(agent: AgentType | CardReviewRequest["requestedBy"] | CardReviewRequest["reviewer"]): string {
  if (agent === "hermes") return "Hermes";
  if (agent === "operator") return "Pascal";
  if (agent === "claude") return "Claude";
  if (agent === "test-writer") return "Test-writer";
  if (agent === "ext") return "external agent";
  return "Codex";
}

function formatDateMeta(value: string): string {
  const ms = parseTime(value);
  if (ms === undefined) return "done";
  return formatTurnTime(ms);
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_LIMIT;
  return Math.min(24, Math.max(4, Math.floor(value!)));
}
