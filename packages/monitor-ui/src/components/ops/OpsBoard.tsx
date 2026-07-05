// OpsBoard — the full-canvas operations surface. Replaces the delivery kanban
// when the board is switched to Ops. Composes: a status sub-header, the soft
// incident banner, and the six zones (grouped probe grid, solvency & runway,
// money-path funnel, trends, incidents, dependencies & deploy). Every zone owns
// its truth-boundary: real data, honest awaiting-data, or a calm empty state.
//
// Pure/presentational: it takes a ProductHealth snapshot and a `nowMs` clock, so
// the whole surface is deterministic to test against the ops fixtures.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { overallSummary, overallToneClass } from "../../lib/monitor/product-health.js";
import { OpsZone } from "./OpsZone.js";
import { ProbeGrid } from "./ProbeGrid.js";
import { SolvencyZone } from "./SolvencyZone.js";
import { MoneyPathZone } from "./MoneyPathZone.js";
import { TrendsZone } from "./TrendsZone.js";
import { IncidentsZone } from "./IncidentsZone.js";
import { DepsDeployZone } from "./DepsDeployZone.js";
import { OpsSoftBanner } from "./OpsSoftBanner.js";

export interface OpsBoardProps {
  health: ProductHealth;
  /** Injected clock so incident durations + "checked Ns ago" are deterministic. */
  nowMs?: number;
}

export function OpsBoard({ health, nowMs = Date.now() }: OpsBoardProps) {
  if (!health.enabled) {
    return (
      <OpsEmpty
        title="Monitoring is off"
        detail="Set PRODUCT_HEALTH_ENABLED to start probing the live product."
      />
    );
  }
  if (health.checks === 0) {
    return <OpsEmpty title="Awaiting first check" detail="The heartbeat runs every couple of minutes." />;
  }

  const overall = overallSummary(health);
  const toneClass = overallToneClass(overall.tone);

  return (
    <div className="ops-board" data-testid="ops-board">
      <div className="ops-subhead">
        <span className={`ops-status ops-status--${toneClass}`}>
          <span className="ops-dot" aria-hidden />
          {overall.label}
        </span>
        {typeof health.chainId === "number" ? (
          <span className="ops-meta">chain {health.chainId}</span>
        ) : null}
        {health.network && health.network !== "unknown" ? (
          <span className={`ops-net ops-net--${health.network}`}>{health.network}</span>
        ) : null}
        <span className="ops-meta">{health.checks.toLocaleString()} checks</span>
        <span className="ops-meta ops-subhead-right">checked {formatAgo(health.at, nowMs)}</span>
      </div>

      <OpsSoftBanner health={health} />

      <div className="ops-grid">
        <OpsZone className="z-probes" icon="pulse" title="Health" meta={<span className="ops-zone-sub">by pillar</span>}>
          <ProbeGrid probes={health.probes} />
        </OpsZone>
        <SolvencyZone solvency={health.solvency} />
        <MoneyPathZone flow={health.flow} />
        <TrendsZone history={health.history} />
        <IncidentsZone history={health.history} nowMs={nowMs} />
        <DepsDeployZone health={health} />
      </div>

      <p className="ops-foot">Ops · watching the live product · grey is awaiting data, never fake-green</p>
    </div>
  );
}

function OpsEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="ops-board ops-board--empty" data-testid="ops-board-empty">
      <div className="ops-empty">
        <span className="ops-empty-title">{title}</span>
        <span className="ops-empty-detail">{detail}</span>
      </div>
    </div>
  );
}

function formatAgo(at: number | null, nowMs: number): string {
  if (at == null) return "—";
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
