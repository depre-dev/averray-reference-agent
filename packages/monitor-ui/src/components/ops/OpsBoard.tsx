// OpsBoard — the operations surface that fills the board's lanes region when the
// board is switched to Ops (the top strip, hero banner, and co-pilot rail stay
// around it — see BoardView). Composes the six zones: grouped probe grid,
// solvency & runway, money-path funnel, trends, incidents, dependencies & deploy.
// Status/chain/checked context lives in the shared hero banner + top-strip chips,
// so this is purely the zone grid. Every zone owns its truth-boundary: real data,
// honest awaiting-data, or a calm empty state.
//
// Pure/presentational: it takes a ProductHealth snapshot and a `nowMs` clock, so
// the whole surface is deterministic to test against the ops fixtures.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { OpsZone } from "./OpsZone.js";
import { ProbeGrid } from "./ProbeGrid.js";
import { SolvencyZone } from "./SolvencyZone.js";
import { MoneyPathZone } from "./MoneyPathZone.js";
import { TrendsZone } from "./TrendsZone.js";
import { IncidentsZone } from "./IncidentsZone.js";
import { DepsDeployZone } from "./DepsDeployZone.js";

export interface OpsBoardProps {
  health: ProductHealth;
  /** Injected clock so incident durations are deterministic. */
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

  return (
    <div className="ops-board" data-testid="ops-board">
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
