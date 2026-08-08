// ARRIVALS — who has actually crossed the public MCP front door, and how far.
//
// The platform owns these counts. This component only renders its versioned
// snapshot; it never infers a later stage from calls or client names. Most
// importantly, an absent/unreachable feed is a named instrument failure, not a
// seven-zero funnel that would read as "nobody arrived".

import {
  ARRIVAL_STAGES,
  type ArrivalsBlock,
} from "../../lib/monitor/product-health.js";

export interface ArrivalsPanelProps {
  arrivals: ArrivalsBlock | undefined;
}

export function ArrivalsPanel({ arrivals }: ArrivalsPanelProps) {
  if (!arrivals || "unavailable" in arrivals) {
    return (
      <section className="ops-arrivals" aria-label="Arrivals — MCP front door" data-testid="ops-arrivals">
        <header className="ops-panel-head">
          <h2 className="ops-panel-title">ARRIVALS — MCP FRONT DOOR</h2>
        </header>
        <p className="ops-arrivals-unreachable" data-tone="awaiting" role="status" data-testid="ops-arrivals-unreachable">
          <strong>UNREACHABLE</strong> — {arrivals?.unavailable ?? "feed not present in this product-health snapshot"}
        </p>
      </section>
    );
  }

  const peak = Math.max(1, ...ARRIVAL_STAGES.map((stage) => arrivals.funnel[stage]));
  const advanced = arrivals.distinct.furthest !== "reached";

  return (
    <section className="ops-arrivals" aria-label="Arrivals — MCP front door" data-testid="ops-arrivals">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">ARRIVALS — MCP FRONT DOOR</h2>
        <span className="ops-panel-note">reached → submitted · cumulative calls</span>
      </header>

      <ol className="ops-arrivals-funnel" aria-label="Arrival funnel, reached through submitted">
        {ARRIVAL_STAGES.map((stage) => {
          const value = arrivals.funnel[stage];
          return (
            <li key={stage} data-testid={`ops-arrival-stage-${stage}`} aria-label={`${stage}: ${value}`}>
              <span className="ops-arrivals-stage">{stage}</span>
              <span className="ops-arrivals-track" aria-hidden>
                <i style={{ width: `${(value / peak) * 100}%` }} />
              </span>
              <strong>{value}</strong>
            </li>
          );
        })}
      </ol>

      <div className="ops-arrivals-summary">
        <div className="ops-arrivals-distinct" aria-label="Distinct arrival clients">
          <span>DECLARED <strong>{arrivals.distinct.declared}</strong></span>
          <span>ANONYMOUS <strong>{arrivals.distinct.anonymous}</strong></span>
        </div>
        <div
          className="ops-arrivals-furthest"
          data-advanced={advanced ? "yes" : "no"}
          data-testid="ops-arrivals-furthest"
        >
          <span>FURTHEST STAGE ANY ARRIVAL REACHED</span>
          <strong>{arrivals.distinct.furthest}</strong>
        </div>
      </div>
    </section>
  );
}
