// The grouped probe grid — the Ops board's health-at-a-glance zone. The 7 probes
// are grouped into the four operational pillars (availability / chain / solvency
// / flow); each probe shows a status dot, name, live detail, and a check strip.
// Awaiting-data probes read grey (telemetry), never a fake green or false amber.

import type { ProductHealthProbe } from "../../lib/monitor/product-health.js";
import { probeLabel } from "../../lib/monitor/product-health.js";
import { groupProbesByPillar, probeOpsTone } from "../../lib/monitor/ops-model.js";
import { OpsSpark } from "./OpsSparks.js";

export interface ProbeGridProps {
  probes: ProductHealthProbe[];
}

export function ProbeGrid({ probes }: ProbeGridProps) {
  const groups = groupProbesByPillar(probes);
  return (
    <div className="ops-probe-grid" data-testid="ops-probe-grid">
      {groups.map((group) => (
        <div key={group.pillar} className="ops-pillar">
          <div className="ops-pillar-label">{group.label}</div>
          {group.probes.map((probe) => {
            const tone = probeOpsTone(probe);
            return (
              <div
                key={probe.name}
                className={`ops-probe ops-probe--${tone}`}
                data-testid={`ops-probe-${probe.name}`}
              >
                <span className="ops-dot" aria-hidden />
                <span className="ops-probe-name">{probeLabel(probe.name)}</span>
                <span className="ops-probe-detail">{probe.detail}</span>
                <OpsSpark series={probe.sparkline} bins={14} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
