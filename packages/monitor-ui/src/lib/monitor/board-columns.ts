// Hermes Handoff Monitor — inbox-first column model (PR-E1).
//
// The Hermes-4 "decision cockpit" replaces the flat 8-lane render with an
// inbox-first column layout (docs/design/hermes-4/project/board.jsx +
// kanban.jsx): a hero DECISION INBOX column holding the union of every card
// waiting on the operator (the one actionable surface), then read-only WATCH /
// HIDE tier columns in pipeline position.
//
// This module is the pure mapping layer — the lane→column metadata (design
// eyebrows + subtitles), the inbox card union, and the per-column
// hidden/rail/column visibility rule. It reuses `tierFor` so the tier system
// stays single-sourced (lane-rules.ts), and is unit-tested in
// board-columns.test.ts so the structure is litigated here, not in the view.

import type { BoardCard, Lane } from "./card-types.js";
import { LANES } from "./card-types.js";
import { isDecision, tierFor, type KanbanTier } from "./lane-rules.js";

export interface BoardColumnDef {
  /** Stable column key (the lane id for pipeline columns; "inbox" for the hero). */
  id: string;
  /** The existing lane this column mirrors. Omitted for the inbox hero (it's a union). */
  lane?: Lane;
  /** The hero Decision Inbox — the single actionable surface. */
  inbox?: boolean;
  /** A gate lane stays reachable (as a rail) even when empty — never hidden. */
  gate?: boolean;
  /** Design column name (board.jsx / kanban.jsx LANES). */
  name: string;
  /** Design eyebrow subtitle under the column name. */
  sub: string;
}

/**
 * The design's lane→column mapping (data.jsx LANES), mapped onto the existing
 * eight lanes. `needs-attention` (the only DECIDE-tier lane) is folded into the
 * inbox hero and so has no pipeline column of its own; the remaining seven
 * lanes become read-only pipeline columns in this order.
 */
export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { id: "inbox", inbox: true, gate: true, name: "Your decisions", sub: "Everything waiting on you" },
  { id: "codex-needed", lane: "codex-needed", name: "Builder tasks", sub: "Proposed by Claude / Codex" },
  { id: "drafts", lane: "drafts", name: "Drafts", sub: "Author finishes" },
  { id: "hermes-checking", lane: "hermes-checking", name: "Hermes checking", sub: "Verifying" },
  { id: "operator-review", lane: "operator-review", gate: true, name: "Runs needing review", sub: "Failed / finished runs" },
  { id: "release-queue", lane: "release-queue", name: "Release queue", sub: "Staged for release" },
  { id: "deploying", lane: "deploying", name: "Deploying", sub: "Verifying post-merge" },
  { id: "done", lane: "done", name: "Done", sub: "Release history" },
] as const;

/** The tier a column belongs to. The inbox is always DECIDE; pipeline columns defer to `tierFor`. */
export function columnTier(col: BoardColumnDef): KanbanTier {
  if (col.inbox) return "decide";
  return col.lane ? tierFor(col.lane) : "watch";
}

/** Human tier label shown as the column eyebrow (the inbox gets its own copy). */
export function tierLabel(tier: KanbanTier): string {
  return tier === "decide" ? "Decide" : tier === "watch" ? "Watch" : "Hide";
}

/**
 * The Decision Inbox holds every card that's a real operator decision
 * (`isDecision`, PR-F1) — the single place to act. Most are promoted into
 * `needs-attention` by laneFor(), but cards can still mirror in pipeline lanes
 * (operator-review / codex-needed) while they await a decision; include them
 * here exactly once so pipeline "jump to inbox" links always target a real
 * actionable card. `isDecision` excludes done / verified / closed release
 * history, so the hero never inflates with finished work.
 */
export function inboxCards(grouped: Partial<Record<Lane, BoardCard[]>>): BoardCard[] {
  const seen = new Set<string>();
  const out: BoardCard[] = [];
  for (const lane of LANES) {
    for (const card of grouped[lane] ?? []) {
      if (!isDecision(card) || seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
  }
  return out;
}

export type ColumnVisibility = "hidden" | "rail" | "column";

/**
 * Per-column visibility, matching the design (kanban.jsx KanbanRow):
 *   - the inbox is always a full column;
 *   - an empty NON-gate pipeline lane hides entirely (no junk-drawer rails);
 *   - an expanded pipeline lane is a full column;
 *   - otherwise it collapses to a reachable vertical rail (gate lanes included,
 *     so a gate never disappears even at zero cards).
 */
export function columnVisibility(
  col: BoardColumnDef,
  cardCount: number,
  expanded: ReadonlySet<Lane>,
): ColumnVisibility {
  if (col.inbox) return "column";
  if (cardCount === 0 && !col.gate) return "hidden";
  if (col.lane && expanded.has(col.lane)) return "column";
  return "rail";
}
