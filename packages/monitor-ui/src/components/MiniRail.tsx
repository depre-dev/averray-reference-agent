// Hermes Handoff Monitor — MiniRail
//
// A collapsed lane rendered as a vertical mini-rail: a thin strip
// showing the lane's card count and name, clickable to expand. In the
// Direction A layout there is no separate left/right rail container —
// every collapsed lane *is* a mini-rail, rendered inline in lane order
// inside `.hm-lanes`. `<Lane>` delegates here when `expanded` is false.
//
// Visual contract: the bundle's `hm-lane--collapsed` / `hm-lane-rail`
// block in styles/monitor.css.

import type { Lane } from "../lib/monitor/card-types.js";

/** Canonical lane id — re-exported so <Lane>/<Board> share one source. */
export type LaneId = Lane;

export type LaneDescriptor = {
  id: LaneId;
  name: string;
  /** Optional eyebrow / hint label shown under the lane title when expanded. */
  action?: string;
  /** When true the lane wears the amber action styling. */
  isAction?: boolean;
};

export type MiniRailProps = {
  lane: LaneDescriptor;
  /** Number of cards in the lane. */
  count: number;
  /** Click handler to expand this lane. */
  onToggle?: (id: LaneId) => void;
};

export function MiniRail({ lane, count, onToggle }: MiniRailProps) {
  const classes = ["hm-lane", "hm-lane--collapsed", lane.isAction ? "hm-lane--action" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onToggle?.(lane.id)}
      aria-label={`${lane.name} (${count} ${count === 1 ? "card" : "cards"}) — click to expand`}
      title={`${lane.name} (${count})`}
    >
      <div className="hm-lane-rail">
        <span className={"ct " + (count > 0 ? "ct--has" : "ct--zero")}>{count}</span>
        <span className="lbl">{lane.name}</span>
        <span className="icn" aria-hidden>
          ›
        </span>
      </div>
    </button>
  );
}
