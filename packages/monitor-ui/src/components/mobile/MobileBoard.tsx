// MobileBoard — the dedicated phone surface. NOT a responsive squeeze of the
// desktop board: the top strip, lane grid and co-pilot rail are 1500px-canvas
// furniture, so this replaces them with a single priority-ordered feed —
//   is it fine → is the money fine → what needs me → who's working.
//
// EXTENSIBILITY (the operator's "room for further features down the line"):
// cards compose exactly like OpsBoard composes zones. Each card is a
// self-contained component that owns its own truth-boundary and returns null
// when it has nothing to say, so adding a feature is adding one component to
// the list below — no rework to the cards around it.
//
// It renders the SAME ProductHealth + BoardCard payload the desktop board uses
// and reuses the desktop's own derivations (opsBannerData, isDecision), so the
// two surfaces cannot drift apart or disagree about what is wrong.

import type { ReactNode } from "react";
import type { BoardCard, CardWorkingNow } from "../../lib/monitor/card-types.js";
import type { ProductHealth, SolvencyPool } from "../../lib/monitor/product-health.js";
import { decisionPriorityFor } from "../../lib/monitor/decision-rank.js";
import { approvalBasisFor, triageForPhone } from "../../lib/monitor/phone-triage.js";
import { describeWorkingNow } from "../../lib/monitor/working-now.js";
import { opsBannerData } from "../ops/ops-frame.js";

export interface MobileBoardProps {
  health?: ProductHealth;
  cards: BoardCard[];
  nowMs?: number;
  onCardClick?: (id: string) => void;
  /** Approve a proposed task — the operator gate, same as the desktop drawer. */
  onApproveTask?: (id: string) => void;
  onDismissCard?: (card: BoardCard) => void;
}

/** How many decisions the feed shows before deferring to the desktop board. */
const DECISION_LIMIT = 5;

export function MobileBoard({
  health,
  cards,
  nowMs = Date.now(),
  onCardClick,
  onApproveTask,
  onDismissCard,
}: MobileBoardProps) {
  // A phone is an ACTION surface, not a triage board: ops-blocking work and
  // approvals that can explain themselves earn a slot; the rest is an honest
  // count. Nothing is dropped — see phone-triage.ts.
  const { actNow, delivery } = triageForPhone(cards, health);
  return (
    <div className="hm-mb" data-testid="mobile-board">
      <header className="hm-mb-top">
        <div>
          <div className="hm-mb-brand">Hermes</div>
          <div className="hm-mb-net">{networkLine(health)}</div>
        </div>
        <span className="hm-mb-live" aria-hidden />
      </header>

      <div className="hm-mb-feed">
        {/* Add a card here to add a feature. Each returns null when empty. */}
        <MobileStatusCard health={health} nowMs={nowMs} />
        <MobileMoneyCard health={health} />
        <MobileActNowCard
          decisions={actNow}
          health={health}
          onCardClick={onCardClick}
          onApproveTask={onApproveTask}
          onDismissCard={onDismissCard}
        />
        <MobileDeliveryLine delivery={delivery} onCardClick={onCardClick} />
        <MobileAgentsCard cards={cards} nowMs={nowMs} />
      </div>

      <p className="hm-mb-foot">Grey is awaiting data, never fake-green.</p>
    </div>
  );
}

function networkLine(health?: ProductHealth): string {
  if (!health?.network || health.network === "unknown") return "monitor";
  const chain = typeof health.chainId === "number" ? ` · ${health.chainId}` : "";
  return `${health.network}${chain}`;
}

function MobileCard({ label, tone, children }: { label?: string; tone?: "ok" | "warn" | "red"; children: ReactNode }) {
  return (
    <section className={`hm-mb-card${tone ? ` hm-mb-card--${tone}` : ""}`}>
      {label ? <span className="hm-mb-label">{label}</span> : null}
      {children}
    </section>
  );
}

/**
 * The one-glance answer. Reuses opsBannerData so the phone states exactly what
 * the desktop banner states — including a runway projection ("Signer gas ~13h
 * to floor"), which is why this can't quietly say "all nominal" when the desk
 * board doesn't.
 */
export function MobileStatusCard({ health, nowMs }: { health?: ProductHealth; nowMs: number }) {
  if (!health) return null;
  const banner = opsBannerData(health, nowMs);
  const tone = banner.tone === "degraded" ? "red" : banner.tone === "action" ? "warn" : "ok";
  const glyph = tone === "red" ? "‼" : tone === "warn" ? "!" : "✓";
  return (
    <MobileCard tone={tone}>
      <div className="hm-mb-status">
        <span className={`hm-mb-badge hm-mb-badge--${tone}`} aria-hidden>{glyph}</span>
        <div>
          <h2 className="hm-mb-h">{banner.headline}</h2>
          {banner.sub ? <p className="hm-mb-sub">{banner.sub}</p> : null}
        </div>
      </div>
    </MobileCard>
  );
}

/** Money — the thing that actually hurts when you're away from the desk. */
export function MobileMoneyCard({ health }: { health?: ProductHealth }) {
  const pools = (health?.solvency?.pools ?? []).filter((p) => !p.informational);
  if (pools.length === 0) return null;
  const note = health?.solvency?.runwayNote;
  return (
    <MobileCard label="Money">
      {pools.map((pool) => (
        <PoolRow key={pool.key} pool={pool} />
      ))}
      {note ? <p className="hm-mb-note">{note}</p> : null}
    </MobileCard>
  );
}

function PoolRow({ pool }: { pool: SolvencyPool }) {
  // amount null = awaiting data. Say so; never draw a bar we can't justify.
  if (pool.amount === null || pool.amount === undefined) {
    return (
      <div className="hm-mb-pool">
        <div className="hm-mb-pool-row">
          <strong>{pool.label}</strong>
          <span className="hm-mb-awaiting">awaiting data</span>
        </div>
      </div>
    );
  }
  const floor = pool.floor ?? null;
  // A meter needs a scale. Without a floor there's nothing to fill against, and
  // an empty pool has nothing to show — so draw NO bar rather than a full one.
  // Shipped as a full green bar on "Treasury reserve · 0 USDC", which read as
  // "healthy and full" for a pool that is deliberately empty. A meter you can't
  // justify is a fake-green, same rule as the awaiting-data branch above.
  const scalable = floor !== null && floor > 0 && pool.amount > 0;
  // Fill is share-of-a-safe-buffer (5× floor), capped — a floored pool at 5×
  // reads full, and one at its floor reads nearly empty.
  const pct = scalable ? Math.max(4, Math.min(100, Math.round((pool.amount / (floor * 5)) * 100))) : 0;
  const tone = pool.status === "red" ? "red" : pool.status === "degraded" ? "warn" : "ok";
  return (
    <div className="hm-mb-pool">
      <div className="hm-mb-pool-row">
        <strong>{pool.label}</strong>
        <span>
          {formatAmount(pool.amount)} {pool.unit}
          {floor !== null ? ` · floor ${formatFloor(floor)}` : ""}
        </span>
      </div>
      {scalable ? (
        <div className="hm-mb-bar" role="img" aria-label={`${pool.label} ${pool.amount} ${pool.unit}`}>
          <span className={`hm-mb-bar-fill hm-mb-bar-fill--${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {pool.note ? <p className="hm-mb-note">{pool.note}</p> : null}
    </div>
  );
}

function formatAmount(value: number): string {
  if (value === 0) return "0";
  return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4);
}

/** Floors are round numbers set by an operator — "floor 1", not "floor 1.00". */
function formatFloor(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * ACT NOW — money-blocking work plus approvals that can state their basis.
 *
 * The shipped version listed every decision and put a green Approve button
 * under a card whose only title was "codex task". The operator's words: "what
 * should I approve here if I have no clue what it is". An approval you cannot
 * identify is worse than one you were never shown, so the button is now GATED
 * on the card being able to say what it will do.
 */
export function MobileActNowCard({
  decisions,
  health,
  onCardClick,
  onApproveTask,
  onDismissCard,
}: {
  decisions: BoardCard[];
  health?: ProductHealth;
  onCardClick?: (id: string) => void;
  onApproveTask?: (id: string) => void;
  onDismissCard?: (card: BoardCard) => void;
}) {
  if (decisions.length === 0) {
    return (
      <MobileCard label="Act now">
        <p className="hm-mb-empty">Nothing needs you right now.</p>
      </MobileCard>
    );
  }
  const shown = decisions.slice(0, DECISION_LIMIT);
  const rest = decisions.length - shown.length;
  return (
    <MobileCard label={`Act now · ${decisions.length}`}>
      {shown.map((card) => (
        <DecisionRow
          key={card.id}
          card={card}
          health={health}
          onCardClick={onCardClick}
          onApproveTask={onApproveTask}
          onDismissCard={onDismissCard}
        />
      ))}
      {rest > 0 ? <p className="hm-mb-note">+{rest} more on the full board.</p> : null}
    </MobileCard>
  );
}

/**
 * Delivery work, as a number rather than a demand. Renders nothing when there
 * is none. This is a COLLAPSE, not a hide: the count is real and the desktop
 * board still lists every one of these cards unchanged.
 */
export function MobileDeliveryLine({
  delivery,
  onCardClick,
}: {
  delivery: BoardCard[];
  onCardClick?: (id: string) => void;
}) {
  if (delivery.length === 0) return null;
  const first = delivery[0]!;
  return (
    <button
      type="button"
      className="hm-mb-delivery"
      onClick={onCardClick ? () => onCardClick(first.id) : undefined}
      data-testid="mobile-delivery-line"
    >
      <span className="hm-mb-delivery-n">{delivery.length}</span>
      <span className="hm-mb-delivery-t">
        delivery item{delivery.length === 1 ? "" : "s"} waiting · review on the full board
      </span>
    </button>
  );
}

function DecisionRow({
  card,
  health,
  onCardClick,
  onApproveTask,
  onDismissCard,
}: {
  card: BoardCard;
  health?: ProductHealth;
  onCardClick?: (id: string) => void;
  onApproveTask?: (id: string) => void;
  onDismissCard?: (card: BoardCard) => void;
}) {
  const priority = decisionPriorityFor(card, health);
  const basis = approvalBasisFor(card);
  const proposed = card.type === "task" && (card as { taskStatus?: string }).taskStatus === "proposed";
  // Approve requires a basis. Without one the row says so and sends you to the
  // desktop rather than offering a decision you cannot make.
  const approvable = proposed && basis !== undefined;
  return (
    <div className="hm-mb-item">
      <button type="button" className="hm-mb-item-open" onClick={onCardClick ? () => onCardClick(card.id) : undefined}>
        <span className="hm-mb-item-title">{basis?.what ?? card.title}</span>
        <span className={`hm-mb-chip hm-mb-chip--${priority.tier === "money-blocking" ? "act" : "warn"}`}>
          {priority.reason}
        </span>
        {basis?.why ? <span className="hm-mb-item-why">{basis.why}</span> : null}
        <span className="hm-mb-item-meta">
          {card.agentType}
          {card.repo ? ` · ${card.repo.split("/").pop()}` : ""}
          {basis?.risk ? ` · ${basis.risk} risk` : ""}
        </span>
      </button>
      {approvable ? (
        <div className="hm-mb-acts">
          <button
            type="button"
            className="hm-mb-btn hm-mb-btn--primary"
            onClick={onApproveTask ? () => onApproveTask(card.id) : undefined}
            disabled={!onApproveTask}
          >
            Approve
          </button>
          <button
            type="button"
            className="hm-mb-btn"
            onClick={onDismissCard ? () => onDismissCard(card) : undefined}
            disabled={!onDismissCard}
          >
            Dismiss
          </button>
        </div>
      ) : proposed ? (
        <p className="hm-mb-nobasis">Can&rsquo;t say what this does — review on the full board.</p>
      ) : null}
    </div>
  );
}

/**
 * Who is actually working right now — real `workingNow` only, never inferred.
 * Away from the desk the useful question isn't "is something running" but
 * "what is it trying to do", so each row carries the agent's own intent and its
 * last reported step, aged. A step past the staleness bound is toned down
 * rather than presented as current.
 */
export function MobileAgentsCard({ cards, nowMs }: { cards: BoardCard[]; nowMs: number }) {
  const working = cards
    .map((card) => (card as { workingNow?: CardWorkingNow }).workingNow)
    .filter((w): w is CardWorkingNow => Boolean(w));
  return (
    <MobileCard label="Agents">
      {working.length === 0 ? (
        <p className="hm-mb-empty">No agent is running right now.</p>
      ) : (
        working.map((w, i) => {
          const view = describeWorkingNow(w, nowMs);
          return (
            <div className="hm-mb-agent-row" key={`${w.agent ?? "agent"}-${i}`}>
              <div className="hm-mb-agent">
                <span className="hm-mb-jewel" aria-hidden />
                <span className="hm-mb-agent-name">{w.agent ?? "agent"}</span>
                <span className="hm-mb-agent-state">{w.label ?? "working"}</span>
              </div>
              {view?.intent ? <p className="hm-mb-agent-intent">{view.intent}</p> : null}
              {view?.progress ? (
                <p className={`hm-mb-agent-step${view.stale ? " is-stale" : ""}`}>
                  {view.progress}
                  {view.progressAge ? <span className="hm-mb-agent-age"> · {view.progressAge}</span> : null}
                </p>
              ) : null}
              {view?.emptyNote ? <p className="hm-mb-agent-step is-empty">{view.emptyNote}</p> : null}
            </div>
          );
        })
      )}
    </MobileCard>
  );
}
