// Hermes Handoff Monitor — LanesBar
//
// The thin tools row between the BoardNow banner and the lane grid.
// Holds:
//   - Search input on the left (with `/` keyboard hint)
//   - Short status tip ("focus on the lane that needs you" / "everything
//     quiet · history below" / "data may be stale; auto-reconnecting")
//   - "sorted by next-action urgency" label
//   - Six filter chips: All, Blocked, Review, Ready, Running, Done
//
// M3': search input renders but is disabled (M5' wires the filter state
// via URL params). Filter chips render count-only and are
// non-interactive. The tip is derived from the board mode.

import type { KPICounts, BoardMode } from "../lib/monitor/board-state.js";

const TIPS: Record<BoardMode, string> = {
  action: "· focus on the lane that needs you",
  calm: "· everything quiet · history below",
  degraded: "· data may be stale; auto-reconnecting",
};

export type LanesBarProps = {
  counts: KPICounts;
  mode: BoardMode;
  /** Search value (M5' wires this; M3' is read-only). */
  searchValue?: string;
};

export function LanesBar({ counts, mode, searchValue = "" }: LanesBarProps) {
  const tip = TIPS[mode];
  const filters: Array<[label: string, count: number]> = [
    ["All", counts.total],
    ["Blocked", counts.blocked],
    ["Review", counts.review],
    ["Ready", counts.queue],
    ["Running", counts.checking],
    ["Done", counts.done],
  ];

  return (
    <div className="hm-lanes-bar">
      <div className="hm-lanes-tools">
        <span className="hm-search">
          <span className="hm-muted" aria-hidden>
            ⌕
          </span>
          <input
            type="search"
            placeholder="search PR, repo, correlation id…"
            value={searchValue}
            disabled
            aria-label="Search PRs, repos, or correlation IDs (wired in M5')"
            readOnly
          />
          <kbd>/</kbd>
        </span>
        <span className="hm-mono hm-muted" style={{ marginLeft: 6 }}>
          {tip}
        </span>
      </div>

      <div className="hm-lanes-tools">
        <span className="hm-mono hm-muted">sorted by next-action urgency</span>
        {filters.map(([label, n], i) => (
          <span key={label} className={"hm-filter-chip " + (i === 0 ? "is-active" : "")} aria-disabled="true">
            {label} <span className="ct">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
