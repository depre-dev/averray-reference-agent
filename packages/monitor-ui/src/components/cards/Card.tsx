// Hermes Handoff Monitor — Card (unified renderer)
//
// One component handles every "live" card type the monitor knows about
// (PR, Mission, Codex task, Deploy, Draft, Done). The visual differences
// between types are driven by which fields are populated, not by separate
// React components — the design bundle's pattern, mirrored 1:1.
//
// The two non-live states (`failed-fetch`, `source-offline`) render
// through <DegradedCard> instead; <CardRouter> owns that dispatch.
//
// State variants this component handles:
//   - fresh / running → normal shell, full-saturation freshness pip
//   - stale           → is-stale class; CSS desaturates + "STALE Xh" badge
//   - done            → compressed historical layout (no risk pills /
//                       checks bar; header + optional closed-at line)
//
// Action variants:
//   - isAction = true   → amber wash + Hermes verdict + CTA buttons
//   - archiveHint = true → "archive in 4h?" tail line

import { useState } from "react";
import type {
  BoardCard,
  CardChecks,
  WaitingOn,
  RiskTag,
  AgentType,
  HermesDecisionRecord,
  CardWorkingNow,
  MissionCard,
  MissionReport,
} from "../../lib/monitor/card-types.js";
import { formatFreshness, freshnessTier } from "../../lib/monitor/urgency.js";
import { laneFor } from "../../lib/monitor/lane-rules.js";
import { humanizedSignalParts } from "../../lib/monitor/signal-labels.js";
import { missionFailureCardSummary } from "../../lib/monitor/mission-failure.js";
import { relatedPrForCard } from "../../lib/monitor/collaboration.js";
import { ChecksBar } from "./ChecksBar.js";
import { AgentDiscussion } from "./AgentDiscussion.js";

export type CardProps = {
  card: BoardCard;
  focused?: boolean;
  onClick?: (card: BoardCard) => void;
  /** Approve a proposed task card (O3). Operator-only; runs through a confirm. */
  onApprove?: (card: BoardCard) => void;
  /** Approve a requested tester mission (T6). Operator-only; runs through a confirm. */
  onApproveMission?: (card: BoardCard) => void;
  /** Dismiss a requested tester mission before the runner can claim it. */
  onDismissMission?: (card: BoardCard) => void;
  /** Approve a PR for merge review. Opens/records only; humans still merge. */
  onApproveMerge?: (card: BoardCard) => void;
  /** Re-run a failed tester mission. */
  onRerunMission?: (card: BoardCard, freshness: "fresh" | "memory") => void;
  /** Accept/acknowledge a failed tester mission without dispatching code work. */
  onAcceptMissionFailure?: (card: BoardCard) => void;
  /** File a GitHub issue for a failed tester mission. */
  onOpenMissionIssue?: (card: BoardCard) => void;
  /** "Keep watching" on the archive hint — cancel/extend this card's auto-archive. */
  onKeepWatching?: (card: BoardCard) => void;
};

// ── Helpers (mirror the bundle's small inline helpers) ──────────────

function agentLabel(t: AgentType | undefined): string {
  if (t === "codex" || t === "claude" || t === "test-writer" || t === "security" || t === "docs" || t === "hermes") return t;
  return "ext";
}

/** CSS class hook for the freshness pip (is-fresh / is-warm / is-stale). */
function freshClass(card: BoardCard): string {
  if (card.state === "stale") return "is-stale";
  const tier = freshnessTier(card.freshness);
  if (tier === "fresh") return "is-fresh";
  if (tier === "warm") return "is-warm";
  return "";
}

/**
 * Strip the leading agent-type prefix from a card ID for the monospace
 * badge. `agent #548` → `#548`, `mission browser-X` → `browser-X`.
 */
function shortId(id: string): string {
  return id.replace(/^[a-z-]+ /, "");
}

// Risk-tag pill classification — matches the bundle's branching.
const HIGH_RISK_TAGS = new Set<RiskTag>(["contracts", "workflow", "review-gated", "secrets", "config"]);
const SECRET_RISK_TAGS = new Set<RiskTag>(["secrets"]);

function riskPillClass(tag: RiskTag): string {
  if (SECRET_RISK_TAGS.has(tag)) return "hm-pill hm-pill--secret";
  if (HIGH_RISK_TAGS.has(tag)) return "hm-pill hm-pill--risk";
  return "hm-pill hm-pill--neutral";
}

// ── Card ───────────────────────────────────────────────────────────

export function Card({
  card,
  focused = false,
  onClick,
  onApprove,
  onApproveMission,
  onDismissMission,
  onApproveMerge,
  onRerunMission,
  onAcceptMissionFailure,
  onOpenMissionIssue,
  onKeepWatching,
}: CardProps) {
  const isAction = laneFor(card) === "needs-attention";
  const isStale = card.state === "stale";
  const isClosed = card.type === "done";

  const classes = [
    "hm-card",
    isAction ? "hm-card--action" : "",
    isStale ? "is-stale" : "",
    focused ? "is-focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Pull the card-type-specific tail fields where they exist. The
  // discriminated union means these are narrow per branch; we read them
  // defensively because the same Card renders every type.
  const verdict = (card as { verdict?: string }).verdict;
  const checks: CardChecks | undefined = card.checks;
  const closedAt = (card as { closedAt?: string }).closedAt;
  const verdictText = (card as { verdictText?: string }).verdictText;

  // A failed/partial browser mission must show a CLEAN one-liner here, not
  // the raw multi-line Playwright/runner dump. The full raw detail lives in
  // the drawer (MissionBody blockers + Evidence). Falls back to the normal
  // summary for every other card.
  const cardSummary = missionFailureCardSummary(card) ?? card.summary;

  const onCardClick = onClick ? () => onClick(card) : undefined;

  return (
    <div
      className={classes}
      onClick={onCardClick}
      // Focusable so j/k traversal (M10') can land on this card; the
      // Board's keyboard handler reads document.activeElement. tabIndex=-1
      // keeps it out of the natural tab order (tab would otherwise cycle
      // through dozens of cards) while staying programmatically reachable.
      tabIndex={-1}
      data-card-id={card.id}
      role={onClick ? "button" : "article"}
      aria-label={`${agentLabel(card.agentType)} ${shortId(card.id)} — ${card.title}`}
    >
      <CardHead card={card} isStale={isStale} isClosed={isClosed} />

      <div className="hm-card-title">{card.title}</div>

      {cardSummary && !isClosed ? (
        <div className="hm-card-meta" style={{ lineHeight: 1.5 }}>
          <span style={{ color: "var(--hm-ink-soft)", fontFamily: "var(--font-body)", fontSize: 12 }}>
            <HumanizedText text={cardSummary} />
          </span>
        </div>
      ) : null}

      {!isClosed && card.type === "mission" ? <MissionRunSummary card={card} /> : null}

      {/* P1-2: hoist the decision onto operator-facing cards. On the two
          lanes where the operator decides (needs-attention, codex-needed),
          surface Hermes's outcome summary + top reason in the body so they
          read *what they're deciding* without opening the drawer. The full
          record (all reasons, safety, changed) still lives in the drawer's
          "Why Hermes did this". Renders nothing when there's no decision
          record — never a fabricated rationale. */}
      {!isClosed && card.decisionRecord && isDecisionLane(card) ? (
        <CardDecisionLine record={card.decisionRecord} />
      ) : null}

      {!isClosed && card.reviewRequests?.some((request) => request.status === "requested") ? (
        <ReviewRequestedLine card={card} />
      ) : null}

      {!isClosed ? <AgentDiscussion messages={card.discussion} compact /> : null}

      {!isClosed && card.workingNow ? <WorkingNowLine workingNow={card.workingNow} /> : null}

      {isClosed && verdictText ? (
        <div className="hm-card-meta">
          <span className="hm-mono">{closedAt}</span>
          <span className="sep">·</span>
          <span style={{ color: "var(--hm-ink-soft)" }}>{verdictText}</span>
        </div>
      ) : null}

      {!isClosed && card.risk && card.risk.length > 0 ? (
        <div className="hm-pillrow">
          {card.risk.map((r) => (
            <span key={r} className={riskPillClass(r)}>
              {r}
            </span>
          ))}
          {card.isDraft ? <span className="hm-pill hm-pill--draft">draft</span> : null}
        </div>
      ) : null}

      {checks ? (
        <div className="hm-checks">
          <ChecksBar checks={checks} />
          <ChecksLabel checks={checks} />
        </div>
      ) : null}

      {/* Closed cards use the compressed historical layout (header +
          close-time + verdict only) — they never show a waiting-on line,
          matching the design. Live data still carries a waitingOn on done
          cards, so gate it here rather than relying on the source. */}
      {!isClosed && card.waitingOn ? <WaitingOnLine waitingOn={card.waitingOn} /> : null}

      {card.type === "mission" && (card as { missionStatus?: string }).missionStatus === "requested" ? (
        <div className="hm-waiting hm-waiting--neutral">
          not started
          <span className="target">→ awaiting operator approval</span>
        </div>
      ) : null}

      {!isClosed && card.waitingOn?.actor === "operator" ? (
        <OperatorActions
          card={card}
          onApprove={onApprove}
          onApproveMission={onApproveMission}
          onDismissMission={onDismissMission}
          onApproveMerge={onApproveMerge}
          onRerunMission={onRerunMission}
          onAcceptMissionFailure={onAcceptMissionFailure}
          onOpenMissionIssue={onOpenMissionIssue}
        />
      ) : null}

      {isAction && verdict ? (
        <div className="hm-verdict">
          <span className="label">Hermes verdict</span>
          <HumanizedText text={verdict} />
        </div>
      ) : null}

      {card.archiveHint ? (
        <div className="hm-waiting hm-waiting--neutral" style={{ color: "var(--hm-muted-soft)" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 500,
              fontSize: 11,
            }}
          >
            Hermes: archive in 4h?{" "}
            {onKeepWatching ? (
              <button
                type="button"
                className="hm-keep-watching"
                style={{
                  color: "var(--hm-sage-deep)",
                  cursor: "pointer",
                  borderBottom: "1px dotted",
                  background: "none",
                  border: 0,
                  padding: 0,
                  font: "inherit",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onKeepWatching(card);
                }}
              >
                Keep watching
              </button>
            ) : (
              // No handler wired ⇒ honest disabled label, not a fake link.
              <span style={{ color: "var(--hm-muted)" }} aria-disabled="true">
                Keep watching
              </span>
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ── Card header — agent dot + ID + freshness pill ──────────────────

function CardHead({ card, isStale, isClosed }: { card: BoardCard; isStale: boolean; isClosed: boolean }) {
  const formatted = formatFreshness(card.freshness);
  const freshnessLabel = isClosed ? "CLOSED" : isStale ? `STALE ${formatted ?? ""}` : `FRESH ${formatted ?? ""}`;

  return (
    <div className="hm-card-head">
      <span className="hm-card-id">
        <span className={`agent-dot agent-dot--${card.agentType ?? "ext"}`} aria-hidden />
        <span className="hm-mono">{agentLabel(card.agentType)}</span>
        <strong className="hm-mono">{shortId(card.id)}</strong>
      </span>
      <span className={"hm-card-fresh " + freshClass(card)}>
        <span className="fresh-dot" aria-hidden />
        {freshnessLabel}
      </span>
    </div>
  );
}

function ReviewRequestedLine({ card }: { card: BoardCard }) {
  const active = card.reviewRequests?.filter((request) => request.status === "requested") ?? [];
  const first = active[0];
  if (!first) return null;
  const isPanel = active.length > 1 || first.reviewMode === "panel";
  const label = isPanel ? "Panel review" : "Review requested";
  const reviewers = isPanel
    ? active.map((request) => actorDisplayName(request.reviewer)).join(", ")
    : actorDisplayName(first.reviewer);
  return (
    <div className="hm-review-request" aria-label={`${label} from ${reviewers}`}>
      <span className="hm-review-request-dot" aria-hidden />
      <span>{label}</span>
      <strong>{reviewers}</strong>
    </div>
  );
}

function actorDisplayName(actor: "hermes" | "operator" | "codex" | "claude" | "test-writer" | "security" | "docs"): string {
  if (actor === "hermes") return "Hermes";
  if (actor === "operator") return "Pascal";
  if (actor === "claude") return "Claude";
  if (actor === "test-writer") return "Test-writer";
  if (actor === "security") return "Security";
  if (actor === "docs") return "Docs";
  return "Codex";
}

function WorkingNowLine({ workingNow }: { workingNow: CardWorkingNow }) {
  const details = [
    workingNow.runnerId ? `runner: ${workingNow.runnerId}` : undefined,
    workingNow.taskId ? `task: ${workingNow.taskId}` : undefined,
    workingNow.since ? `since: ${workingNow.since}` : undefined,
    `source: ${workingNow.source}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="hm-working-now" aria-label={`Working now: ${workingNow.label}`} title={details || undefined}>
      <span className={`agent-dot agent-dot--${workingNow.agent}`} aria-hidden />
      working now
      <span className="target">{workingNow.label}</span>
    </div>
  );
}

function MissionRunSummary({ card }: { card: MissionCard }) {
  const mission = card.mission;
  const status = missionRunStatus(card, mission);
  const tone = missionRunTone(card, mission);
  const target = mission?.target ? shortMissionTarget(mission.target) : undefined;
  const blocker = mission ? missionPrimaryBlocker(card, mission) : undefined;
  const evidence = mission ? missionEvidenceSummary(mission) : [];
  const boundary = mission?.mutationBoundary ? compactSentence(mission.mutationBoundary, 92) : undefined;

  return (
    <div className={`hm-mission-run hm-mission-run--${tone}`} aria-label={`Tester run ${status}`}>
      <div className="hm-mission-run-top">
        <span className="hm-mission-run-kicker">Tester run</span>
        <span className={`hm-mission-run-verdict hm-mission-run-verdict--${tone}`}>{status}</span>
        {target ? <span className="hm-mission-run-target">{target}</span> : null}
      </div>

      {blocker ? (
        <div className="hm-mission-run-blocker">
          <span>Blocker</span>
          <strong>
            <HumanizedText text={blocker} />
          </strong>
        </div>
      ) : null}

      {mission ? (
        <div className="hm-mission-run-facts">
          <span>{mission.seed || "fresh agent"}</span>
          {mission.latency ? <span>{mission.latency}</span> : null}
          {evidence.length > 0 ? (
            evidence.map((item) => <span key={item}>{item}</span>)
          ) : (
            <span>no artifacts captured</span>
          )}
        </div>
      ) : (
        <div className="hm-mission-run-facts">
          <span>waiting for operator approval</span>
        </div>
      )}

      {boundary ? <div className="hm-mission-run-boundary">{boundary}</div> : null}
    </div>
  );
}

function missionRunStatus(card: MissionCard, mission: MissionReport | undefined): string {
  if (mission) {
    const confidence = Math.round(mission.confidence * 100);
    return `${mission.verdict} ${confidence}%`;
  }
  if (card.missionStatus === "requested") return "REQUESTED";
  if (card.missionStatus === "running") return "RUNNING";
  if (card.missionStatus === "completed") return "COMPLETED";
  if (card.missionStatus === "failed") return "FAILED";
  return "QUEUED";
}

function missionRunTone(card: MissionCard, mission: MissionReport | undefined): "ok" | "warn" | "fail" | "neutral" {
  if (mission?.verdictTone) return mission.verdictTone;
  if (card.missionStatus === "failed") return "fail";
  if (card.missionStatus === "completed") return "ok";
  if (card.missionStatus === "running") return "warn";
  return "neutral";
}

function shortMissionTarget(target: string): string {
  try {
    const parsed = new URL(target);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return compactSentence(target, 64);
  }
}

function missionPrimaryBlocker(card: MissionCard, mission: MissionReport): string | undefined {
  const cleanFailure = missionFailureCardSummary(card)?.replace(/^Mission failed\s+—\s+/i, "").trim();
  if (cleanFailure) return cleanFailure;
  const first = mission.blockers[0];
  if (!first) return undefined;
  return compactSentence([first.head, first.body].filter(Boolean).join(" — "), 118);
}

function missionEvidenceSummary(mission: MissionReport): string[] {
  const counts = new Map<string, number>();
  for (const item of mission.evidence) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return Array.from(counts.entries()).map(([kind, count]) => (count > 1 ? `${count} ${kind}s` : kind));
}

function compactSentence(value: string, maxLength: number): string {
  const firstLine = value
    .replace(/[│║╔╗╚╝═]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

// ── Checks label (e.g. "5/6 · 1 running") ──────────────────────────

function ChecksLabel({ checks }: { checks: CardChecks }) {
  return (
    <span className="hm-checks-label">
      {checks.pass}/{checks.total}
      {checks.fail > 0 ? (
        <span style={{ color: "var(--hm-rose)" }}>
          {" · "}
          {checks.fail} fail
        </span>
      ) : null}
      {checks.running > 0 ? (
        <span style={{ color: "var(--hm-amber-deep)" }}>
          {" · "}
          {checks.running} running
        </span>
      ) : null}
    </span>
  );
}

function HumanizedText({ text }: { text: string | undefined }) {
  const parts = humanizedSignalParts(text);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, index) => (
        part.rawCode ? (
          <span className="hm-signal-code" title={`raw code: ${part.rawCode}`} key={`${part.rawCode}:${index}`}>
            {part.text}
          </span>
        ) : (
          <span key={`text:${index}`}>{part.text}</span>
        )
      ))}
    </>
  );
}

// ── Decision hoist (P1-2) ───────────────────────────────────────────
// The operator decides on cards in the needs-attention and codex-needed
// lanes. We use laneFor() (the authoritative classifier) rather than
// reading card.lane directly, per lane-rules.ts.

function isDecisionLane(card: BoardCard): boolean {
  const lane = laneFor(card);
  return lane === "needs-attention" || lane === "codex-needed";
}

function CardDecisionLine({ record }: { record: HermesDecisionRecord }) {
  const summary = record.outcome.summary?.trim();
  const topReason = record.reasons.find((reason) => reason.trim().length > 0)?.trim();
  // Nothing meaningful to hoist → render nothing rather than an empty box.
  if (!summary && !topReason) return null;
  return (
    <div className="hm-card-decision" aria-label="Hermes decision">
      <span className="hm-card-decision-label">Hermes decided</span>
      {summary ? (
        <span className="hm-card-decision-summary">
          <HumanizedText text={summary} />
        </span>
      ) : null}
      {topReason ? (
        <span className="hm-card-decision-reason">
          <span className="hm-card-decision-reason-dot" aria-hidden />
          <HumanizedText text={topReason} />
        </span>
      ) : null}
    </div>
  );
}

// ── Waiting-on line ────────────────────────────────────────────────

function WaitingOnLine({ waitingOn }: { waitingOn: WaitingOn }) {
  return (
    <div className={`hm-waiting hm-waiting--${waitingOn.tone}`}>
      waiting on
      <span className="target">→ {waitingOn.actor}</span>
    </div>
  );
}

// ── Operator actions ────────────────────────────────────────────────
// Approve is only shown when it maps to an existing human gate. Dismiss and
// snooze persist for task-backed cards; they do not grant runner authority.

function OperatorActions({
  card,
  onApprove,
  onApproveMission,
  onDismissMission,
  onApproveMerge,
  onRerunMission,
  onAcceptMissionFailure,
  onOpenMissionIssue,
}: {
  card: BoardCard;
  onApprove?: (card: BoardCard) => void;
  onApproveMission?: (card: BoardCard) => void;
  onDismissMission?: (card: BoardCard) => void;
  onApproveMerge?: (card: BoardCard) => void;
  onRerunMission?: (card: BoardCard, freshness: "fresh" | "memory") => void;
  onAcceptMissionFailure?: (card: BoardCard) => void;
  onOpenMissionIssue?: (card: BoardCard) => void;
}) {
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const agent = agentLabel(card.agentType);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const taskStatus = (card as { taskStatus?: string }).taskStatus;
  const missionStatus = (card as { missionStatus?: string }).missionStatus;
  const missionTarget = card.type === "mission" ? card.mission?.target : undefined;
  const relatedPr = card.type === "pr" ? relatedPrForCard(card) : undefined;
  const actions =
    card.type === "task" && taskStatus === "proposed" && onApprove
      ? [{
          key: "approve",
          label: "Approve & dispatch",
          confirm: `Dispatch to ${agent}?`,
          run: () => onApprove(card),
          kind: "action" as const,
        }]
      : card.type === "mission" && missionStatus === "requested"
        ? [
            onApproveMission
              ? {
                  key: "approve-mission",
                  label: "Approve & dispatch",
                  confirm: "Dispatch tester runner?",
                  run: () => onApproveMission(card),
                  kind: "action" as const,
                }
              : undefined,
            onDismissMission
              ? {
                  key: "dismiss-mission",
                  label: "Dismiss",
                  confirm: "Dismiss this requested tester mission?",
                  run: () => onDismissMission(card),
                  kind: "ghost" as const,
                }
              : undefined,
          ].filter((action): action is {
            key: string;
            label: string;
            confirm: string;
            run: () => void;
            kind: "action" | "ghost";
          } => Boolean(action))
        : card.type === "mission" && missionStatus === "failed"
          ? [
              missionTarget && onRerunMission
                ? {
                    key: "rerun-mission",
                    label: "Re-run",
                    confirm: "Re-run as a fresh mission?",
                    run: () => onRerunMission(card, "fresh" as const),
                    kind: "action" as const,
                  }
                : undefined,
              onAcceptMissionFailure
                ? {
                    key: "accept-failure",
                    label: "Accept failure",
                    confirm: "Accept this failed mission and clear the triage card?",
                    run: () => onAcceptMissionFailure(card),
                    kind: "ghost" as const,
                  }
                : undefined,
              onOpenMissionIssue
                ? {
                    key: "open-issue",
                    label: "Open issue",
                    confirm: "File a GitHub issue for this failed mission?",
                    run: () => onOpenMissionIssue(card),
                    kind: "ghost" as const,
                  }
                : undefined,
            ].filter((action): action is {
              key: string;
              label: string;
              confirm: string;
              run: () => void;
              kind: "action" | "ghost";
            } => Boolean(action))
          : card.type === "pr" && card.isAction && relatedPr && onApproveMerge
            ? [{
                key: "approve-merge",
                label: "Approve merge",
                confirm: "Open GitHub merge review?",
                run: () => onApproveMerge(card),
                kind: "action" as const,
              }]
            : [];

  if (actions.length === 0) return null;
  const confirming = confirmingKey ? actions.find((action) => action.key === confirmingKey) : undefined;

  if (!confirming) {
    return (
      <div className="hm-card-cta hm-card-cta--operator hm-card-cta--actions" role="group" aria-label="Operator actions">
        {actions.map((action) => (
          <button
            type="button"
            className={`hm-btn ${action.kind === "action" ? "hm-btn--action" : "hm-btn--ghost"} hm-btn--sm`}
            key={action.key}
            title={`${action.label} opens a confirmation before running.`}
            onClick={(e) => {
              stop(e);
              setConfirmingKey(action.key);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="hm-card-cta hm-card-cta--operator hm-card-cta--confirm" role="group" aria-label="Confirm operator action">
      <span className="hm-card-confirm-copy">
        {confirming.confirm}
        <small>First click only arms this action. Confirm to send it to the live queue.</small>
      </span>
      <button
        type="button"
        className="hm-btn hm-btn--action hm-btn--sm"
        onClick={(e) => {
          stop(e);
          setConfirmingKey(null);
          confirming.run();
        }}
      >
        Confirm
      </button>
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--sm"
        onClick={(e) => {
          stop(e);
          setConfirmingKey(null);
        }}
      >
        Cancel
      </button>
    </div>
  );
}
