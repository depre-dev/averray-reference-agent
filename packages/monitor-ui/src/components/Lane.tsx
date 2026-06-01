// Hermes Handoff Monitor — Lane
//
// A single lane rendered in one of two visual modes:
//   - collapsed → delegates to <MiniRail>: a vertical strip showing the
//     lane's name and card count. Clicking expands.
//   - expanded → full lane with header, optional action eyebrow, and the
//     card list (or an empty placeholder when count === 0).
//
// M3': renders the empty / mini-rail / populated variants. Card bodies
// are supplied by the page via the `children` slot; the rich <Card>
// vocabulary lands in M4'.

import type { ReactNode } from "react";
import { MiniRail, type LaneDescriptor, type LaneId } from "./MiniRail.js";

export type { LaneDescriptor, LaneId };

// Per-lane empty copy. The generic "No {lane} right now." reads wrong for
// several lanes ("No done right now.", "No deploying right now."), so each
// lane gets a sentence that fits its meaning. Falls back to the generic
// form for any lane id not listed.
const LANE_EMPTY_COPY: Partial<Record<LaneId, string>> = {
  "needs-attention": "Nothing needs your review right now.",
  drafts: "No drafts in progress.",
  "codex-needed": "No tasks waiting to be created.",
  "hermes-checking": "Nothing in pre-check right now.",
  "operator-review": "Nothing waiting on your risk decision.",
  "release-queue": "Release queue is empty.",
  deploying: "Nothing deploying right now.",
  done: "Nothing shipped yet.",
};

function laneEmptyMessage(lane: LaneDescriptor): string {
  return LANE_EMPTY_COPY[lane.id] ?? `No ${lane.name.toLowerCase()} right now.`;
}

export type LaneProps = {
  lane: LaneDescriptor;
  /** Whether the lane is expanded (default) or collapsed to a mini-rail. */
  expanded: boolean;
  /** Number of cards in the lane. */
  count: number;
  /** Cards rendered into the body slot. M4' wires the <Card /> renders. */
  children?: ReactNode;
  /** Optional content at the top of the expanded body, above the cards
   *  (e.g. the codex-needed create-task form, O3). */
  headerAccessory?: ReactNode;
  /** Click handler to toggle this lane's expand/collapse state. */
  onToggle?: (id: LaneId) => void;
};

export function Lane({ lane, expanded, count, children, headerAccessory, onToggle }: LaneProps) {
  if (!expanded) {
    return <MiniRail lane={lane} count={count} onToggle={onToggle} />;
  }

  const classes = [
    "hm-lane",
    count === 0 ? "" : "hm-lane--expanded",
    lane.isAction ? "hm-lane--action" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} aria-label={`${lane.name} lane`}>
      <div className="hm-lane-head">
        <div className="hm-lane-head-row">
          <span className="hm-lane-title">{lane.name}</span>
          <span className="hm-lane-count">{count}</span>
          {onToggle ? (
            <button
              type="button"
              className="hm-lane-collapse"
              onClick={() => onToggle(lane.id)}
              aria-label={`Collapse ${lane.name} lane`}
            >
              collapse ‹
            </button>
          ) : null}
        </div>
        {lane.action ? <div className="hm-lane-action">{lane.action}</div> : null}
      </div>
      <div className="hm-lane-body">
        {headerAccessory}
        {count === 0 ? (
          <div className="hm-lane-empty">{laneEmptyMessage(lane)}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
