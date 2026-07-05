// Incidents — the durable episode log. Each red/degraded stretch with its probe,
// severity tone, duration, and ongoing marker, newest first. Distinguishes three
// honest states: no store yet (awaiting), store present but quiet (calm), and
// real episodes.

import type { HealthHistory } from "../../lib/monitor/product-health.js";
import { probeLabel } from "../../lib/monitor/product-health.js";
import { incidentRows } from "../../lib/monitor/ops-model.js";
import { OpsZone } from "./OpsZone.js";

export interface IncidentsZoneProps {
  history: HealthHistory | undefined;
  nowMs: number;
}

export function IncidentsZone({ history, nowMs }: IncidentsZoneProps) {
  const hasStore = history != null && Array.isArray(history.incidents);
  const rows = incidentRows(history, nowMs);
  return (
    <OpsZone className="z-incidents" icon="timeline" title="Incidents" testId="ops-zone-incidents">
      {!hasStore ? (
        <p className="ops-await" data-testid="ops-incidents-awaiting">
          durable incident store — coming; episodes persist here across reloads
        </p>
      ) : rows.length === 0 ? (
        <p className="ops-await ops-await--calm" data-testid="ops-incidents-calm">
          no incidents recorded in the window
        </p>
      ) : (
        <ul className="ops-incidents" data-testid="ops-incidents">
          {rows.map((inc) => (
            <li key={inc.id} className={`ops-incident ops-incident--${inc.severity}`}>
              <span className="ops-dot" aria-hidden />
              <span className="ops-incident-probe">{probeLabel(inc.probe)}</span>
              <span className="ops-incident-note">{inc.note ?? inc.severity}</span>
              <span className="ops-incident-dur">
                {inc.ongoing ? `ongoing · ${inc.durationLabel}` : inc.durationLabel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </OpsZone>
  );
}
