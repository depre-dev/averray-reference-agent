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
import type { BoardCard } from "../../lib/monitor/card-types.js";
import type { ProductHealth, SolvencyPool } from "../../lib/monitor/product-health.js";
import { isDecision } from "../../lib/monitor/lane-rules.js";
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
  const decisions = cards.filter(isDecision);
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
        <MobileNeedsYouCard
          decisions={decisions}
          onCardClick={onCardClick}
          onApproveTask={onApproveTask}
          onDismissCard={onDismissCard}
        />
        <MobileAgentsCard cards={cards} />
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
  // Fill is share-of-a-safe-buffer (5× floor), capped — a floored pool at 5×
  // reads full, and one at its floor reads nearly empty.
  const pct = floor && floor > 0 ? Math.max(4, Math.min(100, Math.round((pool.amount / (floor * 5)) * 100))) : 100;
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
      <div className="hm-mb-bar" role="img" aria-label={`${pool.label} ${pool.amount} ${pool.unit}`}>
        <span className={`hm-mb-bar-fill hm-mb-bar-fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
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
 * The decisions waiting on the operator. Uses `isDecision` — the same selector
 * the desktop inbox and the "waiting on you" count use — so the phone can't
 * show a different backlog than the board.
 *
 * SAFETY: only approve/dismiss of already-proposed work is reachable here. The
 * phone never moves funds; a prepare-only task stays prepare-only.
 */
export function MobileNeedsYouCard({
  decisions,
  onCardClick,
  onApproveTask,
  onDismissCard,
}: {
  decisions: BoardCard[];
  onCardClick?: (id: string) => void;
  onApproveTask?: (id: string) => void;
  onDismissCard?: (card: BoardCard) => void;
}) {
  if (decisions.length === 0) {
    return (
      <MobileCard label="Needs you">
        <p className="hm-mb-empty">Nothing waiting on you.</p>
      </MobileCard>
    );
  }
  const shown = decisions.slice(0, DECISION_LIMIT);
  const rest = decisions.length - shown.length;
  return (
    <MobileCard label={`Needs you · ${decisions.length}`}>
      {shown.map((card) => (
        <DecisionRow
          key={card.id}
          card={card}
          onCardClick={onCardClick}
          onApproveTask={onApproveTask}
          onDismissCard={onDismissCard}
        />
      ))}
      {rest > 0 ? <p className="hm-mb-note">+{rest} more on the full board.</p> : null}
    </MobileCard>
  );
}

function DecisionRow({
  card,
  onCardClick,
  onApproveTask,
  onDismissCard,
}: {
  card: BoardCard;
  onCardClick?: (id: string) => void;
  onApproveTask?: (id: string) => void;
  onDismissCard?: (card: BoardCard) => void;
}) {
  const taskStatus = (card as { taskStatus?: string }).taskStatus;
  const proposed = card.type === "task" && taskStatus === "proposed";
  return (
    <div className="hm-mb-item">
      <button type="button" className="hm-mb-item-open" onClick={onCardClick ? () => onCardClick(card.id) : undefined}>
        <span className="hm-mb-item-title">{card.title}</span>
        <span className="hm-mb-item-meta">
          {card.agentType}
          {card.repo ? ` · ${card.repo.split("/").pop()}` : ""}
        </span>
      </button>
      {proposed ? (
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
      ) : null}
    </div>
  );
}

/** Who is actually working right now — real `workingNow` only, never inferred. */
export function MobileAgentsCard({ cards }: { cards: BoardCard[] }) {
  const working = cards
    .map((card) => (card as { workingNow?: { agent?: string; label?: string } }).workingNow)
    .filter((w): w is { agent?: string; label?: string } => Boolean(w));
  return (
    <MobileCard label="Agents">
      {working.length === 0 ? (
        <p className="hm-mb-empty">No agent is running right now.</p>
      ) : (
        working.map((w, i) => (
          <div className="hm-mb-agent" key={`${w.agent ?? "agent"}-${i}`}>
            <span className="hm-mb-jewel" aria-hidden />
            <span className="hm-mb-agent-name">{w.agent ?? "agent"}</span>
            <span className="hm-mb-agent-state">{w.label ?? "working"}</span>
          </div>
        ))
      )}
    </MobileCard>
  );
}
