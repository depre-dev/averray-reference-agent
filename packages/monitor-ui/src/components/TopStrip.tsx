// Hermes Handoff Monitor — TopStrip
//
// Header strip showing the brand mark, KPI counts per lane, LIVE
// indicator, and a manual refresh button.
//
// M3' renders against derived board state from fixtures. M5' wires it to
// live SSE data + the real refresh; M11' adds the degraded-mode variant
// (KPIs show `?` instead of `0` when the live stream is disconnected).
//
// Visual contract is the bundle's `hm-top` block in styles/monitor.css.

import type { KPICounts } from "../lib/monitor/board-state.js";

export type TopStripProps = {
  /** Current KPI counts from `kpiCounts(cards)`. */
  counts: KPICounts;
  /** Live indicator timestamp, e.g. "14:32:08". When undefined, dashes shown. */
  liveAt?: string;
  /** Deploy-health label shown in the rightmost KPI pill. Default "OK". */
  deployHealth?: "OK" | "DEGRADED" | "UNKNOWN";
  /** Click handler for the refresh button (M5' wires the actual refresh). */
  onRefresh?: () => void;
};

export function TopStrip({ counts, liveAt, deployHealth = "OK", onRefresh }: TopStripProps) {
  return (
    <div className="hm-top" role="banner">
      <div className="hm-brand">
        <div className="hm-brand-mark" aria-hidden>
          A
        </div>
        <div>
          <div className="hm-brand-name">Hermes</div>
          <div className="hm-brand-sub">Handoff monitor · Averray</div>
        </div>
      </div>

      <div className="hm-kpis" role="status" aria-live="polite" aria-label="Board KPI counts">
        <Kpi count={counts.action} label="Action needed" tone={counts.action ? "action" : "zero"} />
        <Kpi count={counts.codex} label="Codex needed" tone={counts.codex ? "default" : "zero"} />
        <Kpi count={counts.review} label="Operator review" tone={counts.review ? "action" : "zero"} />
        <Kpi count={counts.checking} label="Hermes checking" tone={counts.checking ? "default" : "zero"} />
        <Kpi count={counts.queue} label="Release queue" tone={counts.queue ? "default" : "zero"} />
        <Kpi count={counts.deploying} label="Deploying" tone={counts.deploying ? "default" : "zero"} />
        <span className="hm-kpi hm-kpi--ok">
          <span className="dot" aria-hidden />
          Deploy {deployHealth}
        </span>
      </div>

      <div className="hm-top-right">
        <span className="hm-deploy-pill" aria-label={liveAt ? `Live as of ${liveAt}` : "Live indicator"}>
          <span className="ledge" aria-hidden />
          Live · {liveAt ?? "—"}
        </span>
        <button
          type="button"
          className="hm-refresh"
          onClick={onRefresh}
          disabled={!onRefresh}
          aria-label="Refresh board"
        >
          ⟳ Refresh
        </button>
      </div>
    </div>
  );
}

function Kpi({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "default" | "action" | "zero";
}) {
  const cls =
    tone === "action"
      ? "hm-kpi hm-kpi--action"
      : tone === "zero"
        ? "hm-kpi hm-kpi--zero"
        : "hm-kpi";
  return (
    <span className={cls}>
      <span className="n">{count}</span> {label}
    </span>
  );
}
