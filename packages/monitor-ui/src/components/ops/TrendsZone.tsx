// Trends — the rolling-history zone. Uptime (a status strip + 24h %), API latency
// (SVG line), and signer USDC balance (SVG line). All fed by the server-side
// history store; until that store has data the zone shows an honest accruing
// state rather than a flat fake line.
//
// Each metric also carries a leading-indicator anomaly flag: when the latest
// sample deviates from the metric's OWN recent baseline (latency spiking, balance
// draining) beyond a robust threshold, a chip annotates that trend — a heads-up
// before a fixed floor would trip.

import type { HealthHistory } from "../../lib/monitor/product-health.js";
import { detectAnomalies, anomalyPhrase, type MetricAnomaly } from "../../lib/monitor/ops-anomaly.js";
import { OpsZone } from "./OpsZone.js";
import { OpsSpark, LineSpark } from "./OpsSparks.js";

export interface TrendsZoneProps {
  history: HealthHistory | undefined;
}

function hasSeries(values: (number | null)[] | undefined): boolean {
  return Array.isArray(values) && values.filter((v) => typeof v === "number").length >= 2;
}

function AnomalyChip({ a }: { a: MetricAnomaly | undefined }) {
  if (!a) return null;
  return (
    <span
      className={`ops-anomaly ops-anomaly--${a.severity}`}
      data-testid={`ops-anomaly-${a.metric}`}
      title={`${a.label}: ${a.current} vs ~${a.baseline} baseline · robust z ${a.z}`}
    >
      {anomalyPhrase(a)}
    </span>
  );
}

export function TrendsZone({ history }: TrendsZoneProps) {
  const uptime = history?.uptimeSeries ?? [];
  const latency = history?.latencySeriesMs;
  const balance = history?.balanceSeries;
  const anyData = uptime.length > 0 || hasSeries(latency) || hasSeries(balance);
  const anomalies = detectAnomalies(history);
  const anomalyOf = (metric: MetricAnomaly["metric"]) => anomalies.find((a) => a.metric === metric);

  return (
    <OpsZone className="z-trends" icon="chart" title="Trends" testId="ops-zone-trends">
      {!anyData ? (
        <p className="ops-await" data-testid="ops-trends-awaiting">
          history accruing — 24h uptime, latency, and balance trends fill in as the store records checks
        </p>
      ) : (
        <div className="ops-trends">
          <div className="ops-trend">
            <div className="ops-trend-head">
              <span>Uptime 24h</span>
              <span className="ops-trend-val">
                {typeof history?.uptimePct24h === "number" ? `${history.uptimePct24h.toFixed(1)}%` : "—"}
              </span>
            </div>
            {uptime.length > 0 ? (
              <OpsSpark series={uptime} bins={48} />
            ) : (
              <p className="ops-await ops-await--inline">accruing</p>
            )}
          </div>

          <div className="ops-trend">
            <div className="ops-trend-head">
              <span>API latency</span>
              <span className="ops-trend-val">{lastNum(latency)}</span>
            </div>
            <AnomalyChip a={anomalyOf("latency")} />
            {hasSeries(latency) ? (
              <LineSpark values={latency!} tone="tel" ariaLabel="API latency trend" />
            ) : (
              <p className="ops-await ops-await--inline">accruing</p>
            )}
          </div>

          <div className="ops-trend">
            <div className="ops-trend-head">
              <span>Signer USDC</span>
              <span className="ops-trend-val">{lastNum(balance, "")}</span>
            </div>
            <AnomalyChip a={anomalyOf("balance")} />
            {hasSeries(balance) ? (
              <LineSpark values={balance!} tone="ok" ariaLabel="Signer USDC balance trend" />
            ) : (
              <p className="ops-await ops-await--inline">accruing</p>
            )}
          </div>
        </div>
      )}
    </OpsZone>
  );
}

function lastNum(values: (number | null)[] | undefined, suffix = " ms"): string {
  if (!values) return "—";
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === "number") return `${v}${suffix}`;
  }
  return "—";
}
