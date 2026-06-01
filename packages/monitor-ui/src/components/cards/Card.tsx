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
import type { BoardCard, CardChecks, WaitingOn, RiskTag, AgentType } from "../../lib/monitor/card-types.js";
import { formatFreshness, freshnessTier } from "../../lib/monitor/urgency.js";
import { humanizedSignalParts } from "../../lib/monitor/signal-labels.js";
import { ChecksBar } from "./ChecksBar.js";

export type CardProps = {
  card: BoardCard;
  focused?: boolean;
  onClick?: (card: BoardCard) => void;
  /** Approve a proposed task card (O3). Operator-only; runs through a confirm. */
  onApprove?: (card: BoardCard) => void;
  /** Approve a requested tester mission (T6). Operator-only; runs through a confirm. */
  onApproveMission?: (card: BoardCard) => void;
  /** Hide this card from the current monitor view. Local UI-only control. */
  onDismiss?: (card: BoardCard) => void;
  /** Temporarily hide this card from the current monitor view. Local UI-only control. */
  onSnooze?: (card: BoardCard) => void;
  /** "Keep watching" on the archive hint — cancel/extend this card's auto-archive. */
  onKeepWatching?: (card: BoardCard) => void;
  /** Open the card's detail surface from an inline action. */
  onInvestigate?: (card: BoardCard) => void;
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
  onDismiss,
  onSnooze,
  onKeepWatching,
  onInvestigate,
}: CardProps) {
  const isAction = Boolean(card.isAction);
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
  const action = (card as { action?: { primary: string; secondary?: string } }).action;
  const checks: CardChecks | undefined = card.checks;
  const closedAt = (card as { closedAt?: string }).closedAt;
  const verdictText = (card as { verdictText?: string }).verdictText;

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

      {card.summary && !isClosed ? (
        <div className="hm-card-meta" style={{ lineHeight: 1.5 }}>
          <span style={{ color: "var(--hm-ink-soft)", fontFamily: "var(--font-body)", fontSize: 12 }}>
            <HumanizedText text={card.summary} />
          </span>
        </div>
      ) : null}

      {!isClosed && card.reviewRequests?.some((request) => request.status === "requested") ? (
        <ReviewRequestedLine card={card} />
      ) : null}

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
          onDismiss={onDismiss}
          onSnooze={onSnooze}
          onInvestigate={onInvestigate ?? onClick}
        />
      ) : null}

      {isAction && verdict ? (
        <div className="hm-verdict">
          <span className="label">Hermes verdict</span>
          <HumanizedText text={verdict} />
        </div>
      ) : null}

      {isAction && action ? (
        <div className="hm-card-cta">
          <button
            type="button"
            className="hm-btn hm-btn--action hm-btn--sm"
            onClick={(e) => e.stopPropagation()}
          >
            <HumanizedText text={action.primary} />
            <span className="hm-kbd">A</span>
          </button>
          {action.secondary ? (
            <button
              type="button"
              className="hm-btn hm-btn--ghost hm-btn--sm"
              onClick={(e) => e.stopPropagation()}
            >
              <HumanizedText text={action.secondary} />
            </button>
          ) : null}
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
  onDismiss,
  onSnooze,
  onInvestigate,
}: {
  card: BoardCard;
  onApprove?: (card: BoardCard) => void;
  onApproveMission?: (card: BoardCard) => void;
  onDismiss?: (card: BoardCard) => void;
  onSnooze?: (card: BoardCard) => void;
  onInvestigate?: (card: BoardCard) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const agent = agentLabel(card.agentType);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const taskStatus = (card as { taskStatus?: string }).taskStatus;
  const missionStatus = (card as { missionStatus?: string }).missionStatus;
  const canApproveTask = card.type === "task" && taskStatus === "proposed" && Boolean(onApprove);
  const canApproveMission = card.type === "mission" && missionStatus === "requested" && Boolean(onApproveMission);
  const canApprove = canApproveTask || canApproveMission;
  const approveLabel = canApproveMission ? "Approve tester run" : "Approve & dispatch";
  const confirmLabel = canApproveMission ? "Queue runner now?" : `Dispatch to ${agent}?`;
  const approve = canApproveMission ? onApproveMission : onApprove;

  if (!canApprove && !onDismiss && !onSnooze && !onInvestigate) return null;

  const action = (handler: ((card: BoardCard) => void) | undefined) => (e: { stopPropagation: () => void }) => {
    stop(e);
    handler?.(card);
  };

  if (!confirming) {
    return (
      <div className="hm-card-cta hm-card-cta--operator" role="group" aria-label="Operator actions">
        {canApprove ? (
          <button
            type="button"
            className="hm-btn hm-btn--action hm-btn--sm"
            onClick={(e) => {
              stop(e);
              setConfirming(true);
            }}
          >
            {approveLabel}
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={action(onDismiss)}>
            Dismiss
          </button>
        ) : null}
        {onSnooze ? (
          <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={action(onSnooze)}>
            Snooze
          </button>
        ) : null}
        {onInvestigate ? (
          <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={action(onInvestigate)}>
            Investigate
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="hm-card-cta hm-card-cta--operator" role="group" aria-label="Confirm operator action">
      <span style={{ fontSize: 12, color: "var(--hm-ink-soft)", marginRight: "auto" }}>
        {confirmLabel}
      </span>
      <button
        type="button"
        className="hm-btn hm-btn--action hm-btn--sm"
        onClick={(e) => {
          stop(e);
          setConfirming(false);
          approve?.(card);
        }}
      >
        Confirm
      </button>
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--sm"
        onClick={(e) => {
          stop(e);
          setConfirming(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
}
