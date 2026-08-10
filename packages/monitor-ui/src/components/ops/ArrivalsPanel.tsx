// ARRIVALS — who has actually crossed the public MCP front door, and how far.
//
// The platform owns these counts. This component only renders its versioned
// snapshot; it never infers a later stage from calls or client names. Most
// importantly, an absent/unreachable feed is a named instrument failure, not a
// seven-zero funnel that would read as "nobody arrived".
//
// Every headline here is the EXTERNAL count. Our own canaries, smokes and
// adversarial probes reach the same door, and for a while this panel added
// them to the same bars — it once read BROWSED 2 when one of the two was our
// own roadmap probe. Ours are still shown, deliberately: knowing a probe ran
// is useful. They are just never part of the number that reads as demand.

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

  // Scaled on the external peak so the bars are a picture of outside interest.
  // Scaling on the total would let one busy canary flatten every real bar.
  const peak = Math.max(1, ...ARRIVAL_STAGES.map((stage) => arrivals.funnelExternal[stage]));
  const advanced = arrivals.distinct.furthestExternal !== "reached";
  // Calls the platform counted before it split the funnel. Their actor was
  // never recorded and cannot be recovered, so they sit in neither half. They
  // have to be named: the furthest-stage figures come from the client table,
  // which DOES remember that history, so an operator can otherwise face a
  // funnel reading 0 outsiders beside "an outsider reached browsed" with
  // nothing on screen to reconcile them.
  const unattributed = ARRIVAL_STAGES.reduce(
    (total, stage) =>
      total + (arrivals.funnel[stage] - arrivals.funnelExternal[stage] - arrivals.funnelSelf[stage]),
    0,
  );

  return (
    <section className="ops-arrivals" aria-label="Arrivals — MCP front door" data-testid="ops-arrivals">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">ARRIVALS — MCP FRONT DOOR</h2>
        <span className="ops-panel-note">reached → submitted · outsiders, with ours counted apart</span>
      </header>

      <ol className="ops-arrivals-funnel" aria-label="Arrival funnel, reached through submitted">
        {ARRIVAL_STAGES.map((stage) => {
          const value = arrivals.funnelExternal[stage];
          const ours = arrivals.funnelSelf[stage];
          return (
            <li
              key={stage}
              data-testid={`ops-arrival-stage-${stage}`}
              aria-label={`${stage}: ${value} external, ${ours} ours`}
            >
              <span className="ops-arrivals-stage">{stage}</span>
              <span className="ops-arrivals-track" aria-hidden>
                <i style={{ width: `${(value / peak) * 100}%` }} />
              </span>
              <strong>{value}</strong>
              <span className="ops-arrivals-self" data-testid={`ops-arrival-self-${stage}`} aria-hidden>
                {ours > 0 ? `+${ours}` : ""}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="ops-arrivals-summary">
        <div className="ops-arrivals-distinct" aria-label="Distinct arrival clients">
          <span>DECLARED <strong>{arrivals.distinct.declared}</strong></span>
          <span>ANONYMOUS <strong>{arrivals.distinct.anonymous}</strong></span>
          <span>OURS <strong>{arrivals.distinct.self}</strong></span>
        </div>
        <div
          className="ops-arrivals-furthest"
          data-advanced={advanced ? "yes" : "no"}
          data-testid="ops-arrivals-furthest"
        >
          {/* An OUTSIDER, not "any arrival" — our own probes walk the whole
              funnel routinely, so the old wording turned a green board into a
              statement about ourselves. */}
          <span>FURTHEST STAGE AN OUTSIDER REACHED</span>
          <strong>{arrivals.distinct.furthestExternal}</strong>
        </div>
      </div>

      {unattributed > 0 ? (
        <p
          className="ops-arrivals-unattributed"
          data-tone="awaiting"
          data-testid="ops-arrivals-unattributed"
        >
          <strong>UNATTRIBUTED</strong> — {unattributed} call{unattributed === 1 ? "" : "s"} predate the
          external/self split and belong to neither column. The stage counts above begin at the split;
          the furthest stage does not, and may run ahead of them.
        </p>
      ) : null}
    </section>
  );
}
