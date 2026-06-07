// Hermes Handoff Monitor — inbox-first Kanban (PR-E1).
//
// The Hermes-4 "decision cockpit" layout (docs/design/hermes-4/project/
// board.jsx + kanban.jsx): a hero DECISION INBOX column ("Your decisions" —
// the union of every DECIDE-tier card, the single actionable surface), then
// read-only WATCH / HIDE tier columns in pipeline position. Empty non-gate
// pipeline lanes hide; gate / collapsed lanes show as reachable vertical rails.
//
// This component owns only the column STRUCTURE + chrome (tier eyebrows, count
// pills, collapse chevrons, rails). Card internals come from the caller's
// `renderCard` (the existing CardRouter) — richer inbox cards land in later
// E-PRs. Card membership + visibility live in board-columns.ts (pure, tested).

import type { ReactNode } from "react";
import type { BoardCard, Lane } from "../lib/monitor/card-types.js";
import {
  BOARD_COLUMNS,
  columnTier,
  columnVisibility,
  inboxCards,
  tierLabel,
  type BoardColumnDef,
} from "../lib/monitor/board-columns.js";

export interface KanbanBoardProps {
  /** Lane → card[] grouping from `groupByLane(cards)` (already search/filter-narrowed). */
  grouped: Record<Lane, BoardCard[]>;
  /** Pipeline lanes currently expanded (controlled). A lane not in the set collapses to a rail. */
  expanded: ReadonlySet<Lane>;
  /** Toggle a pipeline lane's expand/collapse (the rail + the header chevron). */
  onToggleLane: (lane: Lane) => void;
  /** Render a single card (the shared CardRouter renderer). */
  renderCard: (card: BoardCard) => ReactNode;
  /** Optional per-lane header content (e.g. the codex-needed create form). */
  renderLaneHeader?: (lane: Lane) => ReactNode;
  /** Optional whole-body renderer for a pipeline lane (grouping). Return undefined for the default. */
  renderLaneBody?: (lane: Lane, cards: BoardCard[]) => ReactNode | undefined;
  /** Accessible label for the column row region. */
  ariaLabel?: string;
}

export function KanbanBoard({
  grouped,
  expanded,
  onToggleLane,
  renderCard,
  renderLaneHeader,
  renderLaneBody,
  ariaLabel = "Kanban lane grid",
}: KanbanBoardProps) {
  const inbox = inboxCards(grouped);

  return (
    <div className="hm-kanban scroll-x" role="region" aria-label={ariaLabel}>
      {BOARD_COLUMNS.map((col) => {
        if (col.inbox) {
          return <InboxColumn key={col.id} col={col} cards={inbox} renderCard={renderCard} />;
        }
        const lane = col.lane!;
        const cards = grouped[lane] ?? [];
        const visibility = columnVisibility(col, cards.length, expanded);
        if (visibility === "hidden") return null;
        if (visibility === "rail") {
          return (
            <ColumnRail key={col.id} col={col} count={cards.length} onExpand={() => onToggleLane(lane)} />
          );
        }
        return (
          <PipelineColumn
            key={col.id}
            col={col}
            cards={cards}
            onCollapse={() => onToggleLane(lane)}
            renderCard={renderCard}
            laneHeader={renderLaneHeader?.(lane)}
            laneBody={renderLaneBody?.(lane, cards)}
          />
        );
      })}
    </div>
  );
}

/** Shared tier-eyebrow + name + count-pill + subtitle header. */
function ColumnHead({
  col,
  count,
  eyebrow,
  onCollapse,
}: {
  col: BoardColumnDef;
  count: number;
  eyebrow: string;
  onCollapse?: () => void;
}) {
  const tier = columnTier(col);
  return (
    <div className="hm-col-head" data-h4-tier={tier}>
      <div className="hm-col-head-top">
        <span className="hm-col-eyebrow">{eyebrow}</span>
        {onCollapse ? (
          <button
            type="button"
            className="hm-col-collapse"
            onClick={onCollapse}
            aria-label={`Collapse ${col.name} lane`}
            title="Collapse"
          >
            ‹
          </button>
        ) : null}
      </div>
      <div className="hm-col-title-row">
        <span className="hm-col-title">{col.name}</span>
        <span className={`hm-col-count${count ? "" : " is-empty"}`}>{count}</span>
        {col.gate ? <span className="hm-col-gate" title="Operator gate">gate</span> : null}
      </div>
      <div className="hm-col-sub">{col.sub}</div>
    </div>
  );
}

/** The hero Decision Inbox — the one actionable column. Always full-width, never collapses. */
function InboxColumn({
  col,
  cards,
  renderCard,
}: {
  col: BoardColumnDef;
  cards: readonly BoardCard[];
  renderCard: (card: BoardCard) => ReactNode;
}) {
  return (
    <section
      className="hm-col hm-col--inbox"
      data-h4-tier="decide"
      role="region"
      aria-label={`${col.name} lane`}
    >
      <ColumnHead col={col} count={cards.length} eyebrow="Decision inbox" />
      <div className="hm-col-body scroll-y">
        {cards.length === 0 ? (
          <EmptyColumn inbox />
        ) : (
          cards.map((card) => renderCard(card))
        )}
      </div>
    </section>
  );
}

/** A read-only WATCH / HIDE pipeline column. */
function PipelineColumn({
  col,
  cards,
  onCollapse,
  renderCard,
  laneHeader,
  laneBody,
}: {
  col: BoardColumnDef;
  cards: BoardCard[];
  onCollapse: () => void;
  renderCard: (card: BoardCard) => ReactNode;
  laneHeader?: ReactNode;
  laneBody?: ReactNode;
}) {
  const tier = columnTier(col);
  return (
    <section
      className={`hm-col hm-col--${tier}`}
      data-h4-tier={tier}
      role="region"
      aria-label={`${col.name} lane`}
    >
      <ColumnHead col={col} count={cards.length} eyebrow={tierLabel(tier)} onCollapse={onCollapse} />
      <div className="hm-col-body scroll-y">
        {laneHeader}
        {cards.length === 0 ? (
          <EmptyColumn />
        ) : laneBody !== undefined ? (
          laneBody
        ) : (
          cards.map((card) => renderCard(card))
        )}
      </div>
    </section>
  );
}

/** A collapsed pipeline lane — a reachable vertical rail (gate lanes keep one even at zero). */
function ColumnRail({
  col,
  count,
  onExpand,
}: {
  col: BoardColumnDef;
  count: number;
  onExpand: () => void;
}) {
  const tier = columnTier(col);
  return (
    <button
      type="button"
      className={`hm-col-rail hm-lane--collapsed${count ? "" : " is-empty"}`}
      data-h4-tier={tier}
      onClick={onExpand}
      aria-label={`Expand ${col.name} (${count} cards)`}
      title={`${col.name} — ${count} cards`}
    >
      <span className={`hm-col-rail-count${count ? "" : " is-empty"}`}>{count}</span>
      <span className="hm-col-rail-name">{col.name}</span>
      {col.gate ? <span className="hm-col-rail-gate">gate</span> : null}
    </button>
  );
}

function EmptyColumn({ inbox }: { inbox?: boolean }) {
  return (
    <div className={`hm-col-empty${inbox ? " hm-col-empty--inbox" : ""}`}>
      <span className="hm-col-empty-glyph" aria-hidden>
        {inbox ? "✓" : "·"}
      </span>
      <div>
        <div className="hm-col-empty-title">{inbox ? "Nothing waiting on you" : "No cards"}</div>
        <div className="hm-col-empty-sub">
          {inbox ? "agents are working — watch the lanes" : "nothing in this stage"}
        </div>
      </div>
    </div>
  );
}
