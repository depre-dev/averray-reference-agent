// The four pillars — the "why is it wrong, specifically" band — plus the
// durable incident log beside them.
//
// Every probe the monitor runs, grouped by the operational domain it belongs
// to, each with its one-line detail verbatim from the probe AND its last few
// checks as a strip — the server has always sent the per-check history, and
// until now the desktop drew none of it. "Flapping for an hour" and "went
// amber one check ago" are different situations that used to render the same.
//
// Awaiting-data probes draw warm grey and are counted separately in the
// roll-up. They are a telemetry gap, not a degradation — folding them into the
// amber count is how a board acquires a permanently-lit warning.
//
// The INCIDENTS column is the same priority answered in time: which probe
// broke, when, for how long. It renders the durable log's newest episodes and
// distinguishes an absent log (older build — says "not reported") from an
// empty one (watched, nothing recorded) — absent is never a clean record.

import type { ProductHealthProbe, HealthHistory } from "../../lib/monitor/product-health.js";
import {
  formatAgo,
  formatDuration,
  groupProbesByPillar,
  probeOpsTone,
  recentIncidents,
  trendSpanLabel,
  worstOpsTone,
  type OpsTone,
} from "../../lib/monitor/ops-model.js";
import { LineSpark, OpsSpark } from "./OpsSparks.js";

export interface PillarStripProps {
  probes: ProductHealthProbe[];
  history: HealthHistory | undefined;
  /** Injected clock — incident ages and durations must be deterministic to test. */
  nowMs?: number;
}

export function PillarStrip({ probes, history, nowMs = Date.now() }: PillarStripProps) {
  const groups = groupProbesByPillar(probes);
  if (groups.length === 0) {
    return (
      <section className="ops-pillars" data-testid="ops-pillars">
        <p className="ops-awaiting">no probes reported — the heartbeat has not run</p>
      </section>
    );
  }

  return (
    <section className="ops-pillars" aria-label="Probes by pillar" data-testid="ops-pillars">
      {groups.map((group) => {
        const tones = group.probes.map(probeOpsTone);
        const worst = worstOpsTone(tones);
        return (
          <div className="ops-pillar" key={group.pillar} data-testid={`ops-pillar-${group.pillar}`}>
            <div className="ops-pillar-head">
              <i className="ops-dot" data-tone={worst} aria-hidden />
              <span className="ops-pillar-name">{group.label.toUpperCase()}</span>
              <span className="ops-pillar-rollup">{rollup(tones)}</span>
            </div>
            <div className="ops-pillar-probes">
              {group.probes.map((probe) => (
                <div className="ops-probe" key={probe.name}>
                  <i className="ops-dot ops-dot--sm" data-tone={probeOpsTone(probe)} aria-hidden />
                  <span className="ops-probe-id">{probe.name}</span>
                  <span className="ops-probe-detail" data-tone={probeOpsTone(probe)}>
                    {probe.detail}
                  </span>
                  {/* The probe's own recent checks, oldest → newest. Severity is
                      encoded twice — tone AND cell height — because amber vs
                      coral is exactly the pair colour-blind vision loses. */}
                  {probe.sparkline?.length ? <OpsSpark series={probe.sparkline} bins={8} /> : null}
                </div>
              ))}
            </div>
            {group.pillar === "availability" ? <AvailabilityTrend history={history} /> : null}
          </div>
        );
      })}
      <IncidentsColumn history={history} nowMs={nowMs} />
    </section>
  );
}

/** "3/3 ok" · "2 ok · 1 awaiting" — awaiting is always named, never absorbed. */
function rollup(tones: OpsTone[]): string {
  const count = (t: OpsTone) => tones.filter((x) => x === t).length;
  const ok = count("ok");
  const degraded = count("degraded");
  const red = count("red");
  const awaiting = count("awaiting");
  if (degraded === 0 && red === 0 && awaiting === 0) return `${ok}/${tones.length} ok`;
  return [
    `${ok} ok`,
    degraded > 0 ? `${degraded} degraded` : null,
    red > 0 ? `${red} red` : null,
    awaiting > 0 ? `${awaiting} awaiting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Uptime, labelled with the span it was actually measured over.
 *
 * "uptime 100.0%" is a claim about a WINDOW, and the history buffer lives in
 * memory — so a deploy empties it and a minute later that figure rested on one
 * check while the board called it 24h. It even rendered beside "awaiting
 * history" on the same line, the two halves contradicting each other.
 *
 * Nothing was wrong with the number; the span was. So the span is stated
 * whenever it falls short of the window, and the percentage is withheld
 * entirely below a couple of samples, where it carries no information at all
 * (one check that passed is "100%", which is true and useless).
 */
function uptimeText(history: HealthHistory | undefined): string {
  const pct = history?.uptimePct24h;
  if (typeof pct !== "number") return "uptime accruing";

  const samples = history?.uptimeSamples;
  if (typeof samples === "number" && samples < 2) return "uptime — too few checks";

  const span = history?.uptimeSpanMs;
  const window = history?.uptimeWindowMs;
  // No span reported (older snapshot) → say the coverage is unknown rather than
  // silently implying the full window.
  if (typeof span !== "number" || typeof window !== "number" || window <= 0) {
    return `uptime ${pct.toFixed(1)}% · span unknown`;
  }
  // Within ~5% of the window is the window, allowing for check jitter.
  if (span >= window * 0.95) return `uptime ${pct.toFixed(1)}%`;
  return `uptime ${pct.toFixed(1)}% over ${formatDuration(span)}`;
}

/**
 * The one trend that earns space on this board: latency + uptime. Both stay
 * honestly absent until the ring buffer has enough samples — a line drawn
 * through two points is a fabricated trend, so it reads "awaiting history"
 * instead of drawing a flat zero.
 *
 * The caption carries the MEASURED span (`trendSpanLabel`), not a hard-coded
 * "24h": the same buffer that makes the uptime figure state its span makes
 * this label state its own.
 */
function AvailabilityTrend({ history }: { history: HealthHistory | undefined }) {
  const series = history?.latencySeriesMs ?? [];
  const samples = series.filter((n): n is number => typeof n === "number");
  const uptimeLabel = uptimeText(history);
  const spanLabel = trendSpanLabel(history);

  if (samples.length < 2) {
    return (
      <p className="ops-pillar-trend" data-tone="awaiting" data-testid="ops-trend-awaiting">
        ◔ latency — awaiting history · {uptimeLabel}
      </p>
    );
  }
  return (
    <p className="ops-pillar-trend" data-testid="ops-trend">
      <LineSpark values={series} tone="ok" width={96} height={20} ariaLabel={`API latency, ${spanLabel}`} />
      <span>
        latency {spanLabel} · {Math.round(samples[samples.length - 1]!)} ms now · {uptimeLabel}
      </span>
    </p>
  );
}

/**
 * The durable log, beside the probes it explains.
 *
 * The board carried up to 200 incident records and rendered ONE line of them —
 * a count in the footer. Which probe, when, how long: that is the diagnosis
 * data an operator scans for after the verdict, and it was fetched, stored and
 * never drawn. A LIST, deliberately not a timeline: a timeline's empty stretches
 * would claim "observed and healthy" over hours the monitor may not have been
 * watching, and no field in the payload backs that claim.
 */
function IncidentsColumn({ history, nowMs }: { history: HealthHistory | undefined; nowMs: number }) {
  const view = recentIncidents(history, nowMs, 3);
  // Head dot: worst severity among ONGOING episodes only. Ended episodes are
  // history — a column glowing amber for last week teaches the eye to skip it.
  const headTone: OpsTone =
    view == null ? "awaiting" : worstOpsTone(view.rows.filter((r) => r.ongoing).map((r) => r.severity));

  return (
    <div className="ops-pillar ops-pillar--incidents" data-testid="ops-incidents">
      <div className="ops-pillar-head">
        <i className="ops-dot" data-tone={headTone} aria-hidden />
        <span className="ops-pillar-name">INCIDENTS</span>
        <span className="ops-pillar-rollup">durable log</span>
      </div>
      {view == null ? (
        <p className="ops-incident-absent" data-testid="ops-incidents-absent">
          incident log not reported by this build
        </p>
      ) : view.rows.length === 0 ? (
        <p className="ops-incident-absent" data-testid="ops-incidents-empty">
          no episodes in this window
        </p>
      ) : (
        <>
          <div className="ops-incident-rows">
            {view.rows.map((r) => (
              <div
                className="ops-incident"
                key={r.id}
                data-tone={r.severity}
                data-ongoing={r.ongoing ? "yes" : "no"}
                data-testid={`ops-incident-${r.id}`}
                title={r.note}
              >
                <i className="ops-dot ops-dot--sm" data-tone={r.severity} aria-hidden />
                <span className="ops-incident-probe">{r.probe}</span>
                <span className="ops-incident-when" data-tone={r.ongoing ? r.severity : "awaiting"}>
                  {r.ongoing
                    ? `ONGOING · ${r.durationLabel}`
                    : `${r.durationLabel} · ended ${formatAgo(r.endedAt ?? r.startedAt, nowMs)}`}
                </span>
              </div>
            ))}
          </div>
          {view.more > 0 ? (
            <p className="ops-incident-more" data-testid="ops-incidents-more">
              +{view.more} more in the window
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
