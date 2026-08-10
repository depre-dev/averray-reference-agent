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
//
// A third column is neither. A declared client name identifies the client
// SOFTWARE, not the operator: our own Claude session and a stranger's both
// announce `Anthropic/ClaudeAI`, so no rule over that name can separate them.
// Counted as outsiders they manufacture demand every time we inspect our own
// front door; counted as ours they erase the real users who arrive the same
// way. So they are shown apart, and the panel says why — an operator watching
// the external figure drop is owed the reason it was wrong before.
//
// The column is absent, not zero, against a platform deployed before the
// bucket existed. Zero is a measurement; absent is not.

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
  // Absent means a platform deployed before the bucket existed, which is a
  // different thing from a platform reporting none — so the column appears
  // only when there is actually a reading behind it.
  const ambiguousCounts = arrivals.funnelAmbiguous;
  // Calls the platform counted before it split the funnel. Their actor was
  // never recorded and cannot be recovered, so they sit in none of the
  // columns. They have to be named: the furthest-stage figures come from the
  // client table, which DOES remember that history, so an operator can
  // otherwise face a funnel reading 0 outsiders beside "an outsider reached
  // browsed" with nothing on screen to reconcile them.
  //
  // Ambiguous calls are subtracted here too. They are unattributed in the
  // ordinary sense, but they do NOT predate the split — saying so on screen
  // would be a false explanation of a real number.
  const unattributed = ARRIVAL_STAGES.reduce(
    (total, stage) =>
      total +
      (arrivals.funnel[stage] -
        arrivals.funnelExternal[stage] -
        arrivals.funnelSelf[stage] -
        (ambiguousCounts?.[stage] ?? 0)),
    0,
  );

  return (
    <section className="ops-arrivals" aria-label="Arrivals — MCP front door" data-testid="ops-arrivals">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">ARRIVALS — MCP FRONT DOOR</h2>
        <span className="ops-panel-note">
          reached → submitted · outsiders, with ours and the unclaimable counted apart
        </span>
      </header>

      <ol className="ops-arrivals-funnel" aria-label="Arrival funnel, reached through submitted">
        {ARRIVAL_STAGES.map((stage) => {
          const value = arrivals.funnelExternal[stage];
          const ours = arrivals.funnelSelf[stage];
          const unclear = ambiguousCounts?.[stage];
          return (
            <li
              key={stage}
              data-testid={`ops-arrival-stage-${stage}`}
              aria-label={
                `${stage}: ${value} external, ${ours} ours` +
                (unclear === undefined ? "" : `, ${unclear} unattributable`)
              }
            >
              <span className="ops-arrivals-stage">{stage}</span>
              <span className="ops-arrivals-track" aria-hidden>
                <i style={{ width: `${(value / peak) * 100}%` }} />
              </span>
              <strong>{value}</strong>
              <span className="ops-arrivals-self" data-testid={`ops-arrival-self-${stage}`} aria-hidden>
                {ours > 0 ? `+${ours}` : ""}
              </span>
              {/* Beside the headline, never inside it. Rendered only when the
                  platform actually reports the bucket. */}
              {unclear !== undefined ? (
                <span
                  className="ops-arrivals-ambiguous"
                  data-testid={`ops-arrival-ambiguous-${stage}`}
                  aria-hidden
                >
                  {unclear > 0 ? `?${unclear}` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="ops-arrivals-summary">
        <div className="ops-arrivals-distinct" aria-label="Distinct arrival clients">
          <span>DECLARED <strong>{arrivals.distinct.declared}</strong></span>
          <span>ANONYMOUS <strong>{arrivals.distinct.anonymous}</strong></span>
          <span>OURS <strong>{arrivals.distinct.self}</strong></span>
          {arrivals.distinct.ambiguous === undefined ? null : (
            <span data-testid="ops-arrivals-distinct-ambiguous">
              UNCLAIMABLE <strong>{arrivals.distinct.ambiguous}</strong>
            </span>
          )}
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
          {/* Shown beside it, because narrowing the claim must not throw the
              signal away: this may well have been an outsider, and the honest
              statement is that we cannot tell. */}
          {arrivals.distinct.furthestAmbiguous === undefined ? null : (
            <span className="ops-arrivals-furthest-ambiguous" data-testid="ops-arrivals-furthest-ambiguous">
              possibly, unclaimable client <strong>{arrivals.distinct.furthestAmbiguous}</strong>
            </span>
          )}
        </div>
      </div>

      {ambiguousCounts ? (
        <p className="ops-arrivals-ambiguous-note" data-testid="ops-arrivals-ambiguous-note">
          <strong>UNCLAIMABLE</strong> — calls under a client name we use ourselves. A declared name
          identifies the client software, not the operator, so our own session and a stranger's are
          indistinguishable. Counted as outsiders they would manufacture demand; counted as ours they
          would erase real users. They are neither, and are shown apart.
        </p>
      ) : null}

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
