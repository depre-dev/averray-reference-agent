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

import type { Ref } from "react";
import type { KPICounts, BoardMode, BoardFilter } from "../lib/monitor/board-state.js";

const TIPS: Record<BoardMode, string> = {
  action: "· focus on the lane that needs you",
  calm: "· everything quiet · history below",
  degraded: "· data may be stale; auto-reconnecting",
};

export type LanesBarProps = {
  counts: KPICounts;
  mode: BoardMode;
  /** Current search query. */
  searchValue?: string;
  /** Search change handler. When omitted the input is read-only. */
  onSearchChange?: (value: string) => void;
  /** Ref to the search input so `/` can focus it (M10'). */
  searchInputRef?: Ref<HTMLInputElement>;
  /** Active filter chip. Defaults to "all". */
  activeFilter?: BoardFilter;
  /** Filter change handler. When omitted the chips render count-only (read-only). */
  onFilterChange?: (filter: BoardFilter) => void;
};

export function LanesBar({
  counts,
  mode,
  searchValue = "",
  onSearchChange,
  searchInputRef,
  activeFilter = "all",
  onFilterChange,
}: LanesBarProps) {
  const tip = TIPS[mode];
  const filters: Array<[label: string, count: number, key: BoardFilter]> = [
    ["All", counts.total, "all"],
    ["Blocked", counts.blocked, "blocked"],
    ["Review", counts.review, "review"],
    ["Ready", counts.queue, "ready"],
    ["Running", counts.checking, "running"],
    ["Done", counts.done, "done"],
  ];

  return (
    <div className="hm-lanes-bar">
      <div className="hm-lanes-tools">
        <span className="hm-search">
          <span className="hm-muted" aria-hidden>
            ⌕
          </span>
          <input
            ref={searchInputRef}
            type="search"
            placeholder="search PR, repo, correlation id…"
            value={searchValue}
            onChange={onSearchChange ? (e) => onSearchChange(e.target.value) : undefined}
            readOnly={!onSearchChange}
            aria-label="Search PRs, repos, or correlation IDs"
          />
          <kbd>/</kbd>
        </span>
        <span className="hm-mono hm-muted" style={{ marginLeft: 6 }}>
          {tip}
        </span>
      </div>

      <div className="hm-lanes-tools">
        <span className="hm-mono hm-muted">sorted by next-action urgency</span>
        {filters.map(([label, n, key]) => {
          const active = activeFilter === key;
          const className = "hm-filter-chip " + (active ? "is-active" : "");
          // Interactive when a handler is wired; otherwise count-only (read-only).
          return onFilterChange ? (
            <button
              key={label}
              type="button"
              className={className}
              aria-pressed={active}
              onClick={() => onFilterChange(key)}
            >
              {label} <span className="ct">{n}</span>
            </button>
          ) : (
            <span key={label} className={className} aria-disabled="true">
              {label} <span className="ct">{n}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
