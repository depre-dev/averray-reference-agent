// The four pillars — the "why is it wrong, specifically" band.
//
// Every probe the monitor runs, grouped by the operational domain it belongs
// to, each with its one-line detail verbatim from the probe. This is the third
// question the board answers, so it sits below the verdict and the money and
// gets one compact row rather than the wide sparse table it used to be.
//
// Awaiting-data probes draw warm grey and are counted separately in the
// roll-up. They are a telemetry gap, not a degradation — folding them into the
// amber count is how a board acquires a permanently-lit warning.

import type { ProductHealthProbe, HealthHistory } from "../../lib/monitor/product-health.js";
import { formatDuration, groupProbesByPillar, probeOpsTone, type OpsTone } from "../../lib/monitor/ops-model.js";
import { LineSpark } from "./OpsSparks.js";

export interface PillarStripProps {
  probes: ProductHealthProbe[];
  history: HealthHistory | undefined;
}

const TONE_RANK: Record<OpsTone, number> = { red: 3, degraded: 2, awaiting: 1, ok: 0 };

export function PillarStrip({ probes, history }: PillarStripProps) {
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
        const worst = tones.reduce<OpsTone>((acc, t) => (TONE_RANK[t] > TONE_RANK[acc] ? t : acc), "ok");
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
                </div>
              ))}
            </div>
            {group.pillar === "availability" ? <AvailabilityTrend history={history} /> : null}
          </div>
        );
      })}
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
 * The one trend that earns space on this board: 24h latency + uptime. Both stay
 * honestly absent until the ring buffer has enough samples — a line drawn
 * through two points is a fabricated trend, so it reads "awaiting history"
 * instead of drawing a flat zero.
 */
function AvailabilityTrend({ history }: { history: HealthHistory | undefined }) {
  const series = history?.latencySeriesMs ?? [];
  const samples = series.filter((n): n is number => typeof n === "number");
  const uptimeLabel = uptimeText(history);

  if (samples.length < 2) {
    return (
      <p className="ops-pillar-trend" data-tone="awaiting" data-testid="ops-trend-awaiting">
        ◔ latency 24h — awaiting history · {uptimeLabel}
      </p>
    );
  }
  return (
    <p className="ops-pillar-trend" data-testid="ops-trend">
      <LineSpark values={series} tone="ok" width={96} height={20} ariaLabel="API latency, last 24 hours" />
      <span>
        latency 24h · {Math.round(samples[samples.length - 1]!)} ms now · {uptimeLabel}
      </span>
    </p>
  );
}
