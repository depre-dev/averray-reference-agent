// ARRIVALS — the operator verdict first, raw transport counters second.
//
// The backend owns identity joins, historical payout evidence, and windows.
// This component never recovers a verdict from the legacy call funnels: doing
// so would make canaries look like demand and compare unlike instrumentation.

import { formatAgo } from "../../lib/monitor/ops-model.js";
import {
  RECENCY_BANDS,
  doorLadders,
  recencyBand,
  weekPair,
} from "../../lib/monitor/arrivals-view.js";
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
        {/* Two halves of one answer: the verdict lines (records and windows,
            in words) and the wallet-journey ladders (the same instrumentation
            as marks). The ladders draw ONLY the wallet-unit rows — the
            pre-identity call counters stay un-charted in the DOORS drawer,
            where their unlike instruments are labelled. */}
        <div className="ops-arrivals-verdict-body">
          <dl className="ops-arrivals-verdict-lines">
            <VerdictLine label="furthest ever" testId="ops-arrivals-furthest-ever">
              <Figure window={outsiders.furthestEver?.window ?? "all-time"} testId="ops-arrivals-figure-furthest">
                {formatFurthest(outsiders.furthestEver)}
              </Figure>
            </VerdictLine>
            <VerdictLine label="last activity" testId="ops-arrivals-last-activity">
              <Figure window={outsiders.lastActivity?.window ?? "all-time"} testId="ops-arrivals-figure-last">
                {formatLastActivity(outsiders.lastActivity, generatedAtMs)}
              </Figure>
              <RecencyStrip atMs={outsiders.lastActivity?.atMs ?? null} generatedAtMs={generatedAtMs} />
            </VerdictLine>
            <VerdictLine label="this week" testId="ops-arrivals-this-week">
              <span className="ops-arrivals-pair">
                <Figure window={outsiders.week.window} testId="ops-arrivals-figure-week-identified">
                  {outsiders.week.identified} identified
                </Figure>
                <span aria-hidden>·</span>
                <Figure window={outsiders.week.window} testId="ops-arrivals-figure-week-worked">
                  {outsiders.week.worked} worked
                </Figure>
              </span>
              <WeekBars week={outsiders.week} />
            </VerdictLine>
            <VerdictLine label="posted work" testId="ops-arrivals-posted-work">
              <Figure window={outsiders.postedWork.window} testId="ops-arrivals-figure-posted">
                {formatPostedWork(outsiders.postedWork)}
              </Figure>
            </VerdictLine>
          </dl>
          <JourneyLadders view={operatorView} />
        </div>
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

function VerdictLine({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The wallet-journey ladders — one per door, never summed, never compared.
 *
 * Only rows the producer declared in the `agents` unit are drawn: distinct
 * SIWE wallets reaching AT LEAST each stage, which is monotonic by
 * construction and therefore honest as bars. Each door fills against its OWN
 * busiest stage, so a 1-wallet MCP door and a 160-wallet HTTP door are both
 * legible without the widths implying a comparison the windows cannot support.
 */
function JourneyLadders({ view }: { view: ArrivalOperatorView }) {
  const doors = doorLadders(view);
  return (
    <div className="ops-arrivals-journey" data-testid="ops-arrivals-journey">
      <div className="ops-arrivals-journey-head">
        <h4>WALLET JOURNEY</h4>
        <span>wallets reaching at least each stage · each door on its own scale · doors never sum</span>
      </div>
      <div className="ops-arrivals-journey-doors">
        {doors.map((door) => (
          <div className="ops-ladder" key={door.door} data-testid={`ops-arrivals-ladder-${door.door}`}>
            <div className="ops-ladder-head">
              <span className="ops-ladder-door">{door.label}</span>
              <span className="ops-ladder-since">since {formatDate(door.sinceMs)}</span>
              <WindowBadge window={door.window} />
            </div>
            {door.stages.length === 0 ? (
              <p className="ops-ladder-absent">no wallet-stage rows reported for this door</p>
            ) : (
              door.stages.map((s) => (
                <div
                  className="ops-ladder-row"
                  key={s.stage}
                  data-testid={`ops-arrivals-ladder-${door.door}-${s.stage}`}
                >
                  <span className="ops-ladder-stage">{s.stage}</span>
                  <span className="ops-ladder-track" aria-hidden>
                    {/* Zero draws NO fill — the min-width that keeps one wallet
                        visible must never invent one. */}
                    {s.fillPct > 0 ? <i style={{ width: `${s.fillPct}%` }} /> : null}
                  </span>
                  <span className="ops-ladder-count">{s.count}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Where in fixed time bands the last outsider activity sits. The bands are
 * rungs (1h / 24h / 7d), not a linear axis, and the clock is the snapshot's
 * own. No activity ever → nothing: an empty strip still looks like a reading.
 */
function RecencyStrip({ atMs, generatedAtMs }: { atMs: number | null; generatedAtMs: number }) {
  const band = recencyBand(atMs, generatedAtMs);
  if (!band) return null;
  return (
    <span
      className="ops-recency"
      role="img"
      aria-label={`last outsider activity falls in the ${band} band`}
      data-band={band}
      data-testid="ops-arrivals-recency"
    >
      {RECENCY_BANDS.map((b) => (
        <i key={b.key} data-active={b.key === band ? "yes" : "no"}>
          {b.label}
        </i>
      ))}
    </span>
  );
}

/**
 * The 7d identified/worked counts as two bars on ONE shared scale — beside
 * the words that carry the exact numbers. Not nested: nothing in the payload
 * proves worked ⊆ identified, so neither bar contains the other.
 */
function WeekBars({ week }: { week: { identified: number; worked: number } }) {
  const pair = weekPair(week);
  if (!pair) return null;
  return (
    <span className="ops-weekpair" data-testid="ops-arrivals-weekpair" aria-hidden>
      {/* A zero count gets no bar at all — the words beside carry the zero. */}
      {pair.identified.fillPct > 0 ? (
        <i data-kind="identified" title={`${pair.identified.count} identified (7d)`} style={{ width: `${pair.identified.fillPct}%` }} />
      ) : null}
      {pair.worked.fillPct > 0 ? (
        <i data-kind="worked" title={`${pair.worked.count} worked (7d)`} style={{ width: `${pair.worked.fillPct}%` }} />
      ) : null}
    </span>
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

function formatFurthest(reading: ArrivalOperatorView["outsiders"]["furthestEver"]): string {
  if (!reading) return "NO IDENTIFIED OUTSIDER YET";
  const payout = reading.payouts === undefined
    ? ""
    : ` · ${reading.payouts} payouts in ${reading.payoutWindow ?? "the measured burst"}`;
  return `${reading.stage.toUpperCase()}${payout} · ${formatDate(reading.atMs)} (${reading.door.toUpperCase()})`;
}

function formatLastActivity(
  reading: ArrivalOperatorView["outsiders"]["lastActivity"],
  generatedAtMs: number,
): string {
  if (!reading) return "NO IDENTIFIED OUTSIDER ACTIVITY YET";
  return `${formatAgo(reading.atMs, generatedAtMs)} · ${reading.stage} (${reading.door.toUpperCase()})`;
}

function formatPostedWork(reading: ArrivalOperatorView["outsiders"]["postedWork"]): string {
  if (reading.status === "never") return "NEVER — THE OPEN GATE";
  if (reading.status === "unknown") return "UNKNOWN — JOB CATALOGUE UNREADABLE";
  return `${reading.count ?? 0} POSTED · FIRST ${formatDate(reading.firstAtMs)}`;
}

function formatDate(atMs: number | null): string {
  return atMs === null || !Number.isFinite(atMs) ? "date unknown" : new Date(atMs).toISOString().slice(0, 10);
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
