// ARRIVALS — the operator verdict first, raw transport counters second.
//
// Visual grammar per the Averray design system's operator kit (the design
// project's SKILL.md): records render as KPI cards — uppercase display
// eyebrow, one large display value, mono sub-line; instrumentation renders as
// a table; OURS / UNKNOWN counts are status pills; identifiers stay mono.
// Translated onto the board's --h4 tokens so every color profile keeps
// working.
//
// The backend owns identity joins, historical payout evidence, and windows.
// This component never recovers a verdict from the legacy call funnels: doing
// so would make canaries look like demand and compare unlike instrumentation.

import { formatAgo } from "../../lib/monitor/ops-model.js";
import { doorJourneys } from "../../lib/monitor/arrivals-view.js";
import type {
  ArrivalOperatorView,
  ArrivalOperatorDoorRow,
  ArrivalsBlock,
} from "../../lib/monitor/product-health.js";

export interface ArrivalsPanelProps {
  arrivals: ArrivalsBlock | undefined;
}

export function ArrivalsPanel({ arrivals }: ArrivalsPanelProps) {
  if (!arrivals || "unavailable" in arrivals) {
    return <Unavailable reason={arrivals?.unavailable ?? "feed not present in this product-health snapshot"} />;
  }
  const operatorView = arrivals.operatorView;
  if (!operatorView || "unavailable" in operatorView) {
    return (
      <Unavailable
        label="VERDICT VIEW UNAVAILABLE"
        reason={operatorView?.unavailable ?? "shared identity registry projection not present in this snapshot"}
      />
    );
  }

  const { outsiders, ours, unknown, generatedAtMs } = operatorView;
  const furthest = outsiders.furthestEver;
  const last = outsiders.lastActivity;
  return (
    <section className="ops-arrivals" aria-label="Arrivals — who is actually showing up" data-testid="ops-arrivals">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">ARRIVALS — WHO IS ACTUALLY SHOWING UP?</h2>
        <span className="ops-panel-note">identities after SIWE · self and unknown never count as demand</span>
      </header>

      <section className="ops-arrivals-verdict" data-testid="ops-arrivals-outsiders">
        <div className="ops-arrivals-block-head">
          <h3>OUTSIDERS</h3>
          <span>the only demand signal</span>
        </div>

        {/* The four records, as KPI cards. The value is the record; the mono
            sub-line is its provenance (count, date, door); the window badge
            rides every figure, exactly as before. */}
        <div className="ops-arrivals-kpis">
          <Kpi label="FURTHEST EVER" testId="ops-arrivals-furthest-ever">
            {furthest ? (
              <>
                <span className="ops-kpi-val">{furthest.stage.toUpperCase()}</span>
                <Figure window={furthest.window} testId="ops-arrivals-figure-furthest">
                  {furthestSub(furthest)}
                </Figure>
              </>
            ) : (
              <Figure window="all-time" testId="ops-arrivals-figure-furthest">
                NO IDENTIFIED OUTSIDER YET
              </Figure>
            )}
          </Kpi>

          <Kpi label="LAST ACTIVITY" testId="ops-arrivals-last-activity">
            {last ? (
              <>
                <span className="ops-kpi-val">{formatAgo(last.atMs, generatedAtMs)}</span>
                <Figure window={last.window} testId="ops-arrivals-figure-last">
                  {last.stage} ({last.door.toUpperCase()})
                </Figure>
              </>
            ) : (
              <Figure window="all-time" testId="ops-arrivals-figure-last">
                NO IDENTIFIED OUTSIDER ACTIVITY YET
              </Figure>
            )}
          </Kpi>

          <Kpi label="THIS WEEK" testId="ops-arrivals-this-week">
            <Figure window={outsiders.week.window} testId="ops-arrivals-figure-week-identified">
              <span className="ops-kpi-val">{outsiders.week.identified}</span> identified
            </Figure>
            <Figure window={outsiders.week.window} testId="ops-arrivals-figure-week-worked">
              {outsiders.week.worked} worked
            </Figure>
          </Kpi>

          <Kpi label="POSTED WORK" testId="ops-arrivals-posted-work">
            {outsiders.postedWork.status === "observed" ? (
              <>
                <span className="ops-kpi-val">
                  {outsiders.postedWork.count ?? 0} <span className="ops-kpi-word">POSTED</span>
                </span>
                <Figure window={outsiders.postedWork.window} testId="ops-arrivals-figure-posted">
                  FIRST {formatDate(outsiders.postedWork.firstAtMs)}
                </Figure>
              </>
            ) : (
              <Figure window={outsiders.postedWork.window} testId="ops-arrivals-figure-posted">
                {outsiders.postedWork.status === "never" ? "NEVER — THE OPEN GATE" : "UNKNOWN — JOB CATALOGUE UNREADABLE"}
              </Figure>
            )}
          </Kpi>
        </div>

        <JourneyPanel view={operatorView} />
      </section>

      <div className="ops-arrivals-secondary">
        <section className="ops-arrivals-owned" data-testid="ops-arrivals-ours">
          <div className="ops-arrivals-block-head">
            <h3>OURS</h3>
            <span>operational traffic, kept apart</span>
          </div>
          <div className="ops-arrivals-figures">
            <Figure window={ours.day.window} testId="ops-arrivals-figure-canary">
              {countLabel(ours.day.canaryRuns, "canary run")}
            </Figure>
            <Figure window={ours.day.window} testId="ops-arrivals-figure-acceptance">
              {countLabel(ours.day.acceptanceRuns, "acceptance run")}
            </Figure>
            <Figure window={ours.day.window} testId="ops-arrivals-figure-admin">
              {countLabel(ours.day.adminConsoleAgents, "admin console agent")}
            </Figure>
            <Figure window={ours.day.window} testId="ops-arrivals-figure-operator">
              {countLabel(ours.day.operatorAgents, "operator agent")}
            </Figure>
          </div>
        </section>

        <section className="ops-arrivals-unknown" data-testid="ops-arrivals-unknown">
          <div className="ops-arrivals-block-head">
            <h3>UNKNOWN / UNCLAIMABLE</h3>
            <span>counted apart</span>
          </div>
          <div className="ops-arrivals-figures">
            <Figure window={unknown.window} testId="ops-arrivals-figure-shared-clients">
              shared client names {unknown.sharedClientNames}
            </Figure>
            <Figure window={unknown.window} testId="ops-arrivals-figure-presplit">
              pre-split calls {unknown.preSplitCalls}
            </Figure>
          </div>
        </section>
      </div>

      <details className="ops-arrivals-evidence" data-testid="ops-arrivals-evidence">
        <summary>DOORS — RAW INSTRUMENTATION</summary>
        <p>
          Reached, browsed and evaluated are independently instrumented calls, not a monotonic agent funnel.
          From identified onward, rows are distinct SIWE wallets reaching at least that stage.
        </p>
        <div className="ops-arrivals-door-tables">
          <DoorTable name="MCP" door="mcp" view={operatorView} />
          <DoorTable name="HTTP API" door="http" view={operatorView} />
        </div>
        {arrivals.httpCutover ? (
          <p className="ops-arrivals-cutover" data-testid="ops-arrivals-http-cutover">
            {arrivals.httpCutover.note}
          </p>
        ) : null}
      </details>
    </section>
  );
}

function Unavailable({ reason, label = "UNREACHABLE" }: { reason: string; label?: string }) {
  return (
    <section className="ops-arrivals" aria-label="Arrivals — who is actually showing up" data-testid="ops-arrivals">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">ARRIVALS — WHO IS ACTUALLY SHOWING UP?</h2>
      </header>
      <p className="ops-arrivals-unreachable" data-tone="awaiting" role="status" data-testid="ops-arrivals-unreachable">
        <strong>{label}</strong> — {reason}
      </p>
    </section>
  );
}

/** One record card: uppercase eyebrow, then whatever the record renders. */
function Kpi({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="ops-kpi" data-testid={testId}>
      <span className="ops-kpi-lbl">{label}</span>
      {children}
    </div>
  );
}

/** The furthest-ever provenance sub-line: burst, date, door. */
function furthestSub(reading: NonNullable<ArrivalOperatorView["outsiders"]["furthestEver"]>): string {
  const burst =
    reading.payouts === undefined ? "" : `${reading.payouts} payouts in ${reading.payoutWindow ?? "the measured burst"} · `;
  return `${burst}${formatDate(reading.atMs)} (${reading.door.toUpperCase()})`;
}

/**
 * The wallet journey, as the kit's table pattern — one row per wallet stage,
 * one column per door.
 *
 * Only rows the producer declared in the `agents` unit are drawn: distinct
 * SIWE wallets reaching AT LEAST each stage, monotonic by construction, which
 * is what makes the fill behind each count honest. Each door fills against
 * its OWN busiest stage — a 1-wallet MCP door and a 160-wallet HTTP door are
 * both legible without the widths implying a comparison the windows cannot
 * support. The pre-identity call counters stay un-charted in the DOORS drawer.
 */
function JourneyPanel({ view }: { view: ArrivalOperatorView }) {
  const doors = doorJourneys(view);
  // Row spine: every wallet stage any door reported, in producer order.
  const stageOrder = doors.flatMap((d) => d.stages.map((s) => s.stage)).filter((s, i, all) => all.indexOf(s) === i);

  return (
    <div className="ops-journey" data-testid="ops-arrivals-journey">
      <div className="ops-journey-head">
        <h4>WALLET JOURNEY</h4>
        <span>wallets reaching at least each stage · each door on its own scale · doors never sum</span>
      </div>
      {stageOrder.length === 0 ? (
        <p className="ops-journey-absent" data-testid="ops-arrivals-journey-absent">
          no wallet-stage rows reported by either door
        </p>
      ) : (
        <div className="ops-journey-grid" role="table" aria-label="Outsider wallets by stage, per door">
          <div className="ops-journey-row ops-journey-row--head" role="row">
            <span role="columnheader" className="ops-journey-stage-head">
              stage
            </span>
            {doors.map((door) => (
              <span role="columnheader" className="ops-journey-door" key={door.door}>
                {door.label}
                <small>since {formatDate(door.sinceMs)}</small>
                <WindowBadge window={door.window} />
              </span>
            ))}
          </div>
          {stageOrder.map((stage) => (
            <div className="ops-journey-row" role="row" key={stage} data-testid={`ops-arrivals-journey-${stage}`}>
              <span role="cell" className="ops-journey-stage">
                {stage}
              </span>
              {doors.map((door) => {
                const reading = door.stages.find((s) => s.stage === stage);
                return (
                  <span
                    role="cell"
                    className="ops-journey-cell"
                    key={door.door}
                    data-testid={`ops-arrivals-journey-${door.door}-${stage}`}
                  >
                    {/* A stage this door never reported is a dash, not a zero. */}
                    {reading ? (
                      <>
                        <span className="ops-journey-fill" aria-hidden>
                          {reading.fillPct > 0 ? <i style={{ width: `${reading.fillPct}%` }} /> : null}
                        </span>
                        <b>{reading.count}</b>
                      </>
                    ) : (
                      <b className="ops-journey-none">—</b>
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Figure({ window, testId, children }: { window: string; testId: string; children: React.ReactNode }) {
  return (
    <span className="ops-arrivals-figure" data-testid={testId}>
      <span>{children}</span>
      <WindowBadge window={window} />
    </span>
  );
}

function WindowBadge({ window }: { window: string }) {
  return <small className="ops-window-badge">{window.toUpperCase()}</small>;
}

function DoorTable({ name, door, view }: { name: string; door: "mcp" | "http"; view: ArrivalOperatorView }) {
  const evidence = view.doors[door];
  return (
    <section className="ops-arrivals-door" data-testid={`ops-arrivals-door-${door}`}>
      <h3>{name}</h3>
      <p className="ops-arrivals-door-since">
        observed since {formatDate(evidence.sinceMs)} <WindowBadge window={evidence.window} />
      </p>
      <div className="ops-arrivals-table" role="table" aria-label={`${name} raw arrivals`}>
        <div className="ops-arrivals-table-head" role="row">
          <span role="columnheader">stage / instrument</span>
          <span role="columnheader">outsider</span>
          <span role="columnheader">ours</span>
          <span role="columnheader">unknown</span>
        </div>
        {evidence.rows.map((row) => <DoorRow key={row.stage} door={door} row={row} window={evidence.window} />)}
      </div>
    </section>
  );
}

function DoorRow({ door, row, window }: { door: "mcp" | "http"; row: ArrivalOperatorDoorRow; window: string }) {
  return (
    <div className="ops-arrivals-table-row" role="row" data-testid={`ops-arrivals-row-${door}-${row.stage}`}>
      <span role="cell">
        <strong>{row.stage}</strong>
        <small>{row.unit} · {row.instrumentation}</small>
      </span>
      {(["outsider", "ours", "unknown"] as const).map((actor) => (
        <Figure key={actor} window={window} testId={`ops-arrivals-figure-${door}-${row.stage}-${actor}`}>
          {row[actor]}
        </Figure>
      ))}
    </div>
  );
}

function formatDate(atMs: number | null): string {
  return atMs === null || !Number.isFinite(atMs) ? "date unknown" : new Date(atMs).toISOString().slice(0, 10);
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
