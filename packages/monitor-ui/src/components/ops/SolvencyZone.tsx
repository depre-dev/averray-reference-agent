// Solvency & runway — the money-headroom zone. One meter row per pool (signer
// gas/USDC, reward bank, agent core, treasury reserve, escrow), a status tone
// vs its floor, and a runway note. When the backend hasn't wired the balances
// yet, the whole zone shows an honest awaiting state instead of empty gauges.

import type { SolvencySnapshot } from "../../lib/monitor/product-health.js";
import { solvencyRows } from "../../lib/monitor/ops-model.js";
import { OpsZone } from "./OpsZone.js";

export interface SolvencyZoneProps {
  solvency: SolvencySnapshot | undefined;
}

export function SolvencyZone({ solvency }: SolvencyZoneProps) {
  const rows = solvency ? solvencyRows(solvency.pools) : [];
  return (
    <OpsZone className="z-solvency" icon="wallet" title="Solvency & runway" testId="ops-zone-solvency">
      {rows.length === 0 ? (
        <p className="ops-await" data-testid="ops-solvency-awaiting">
          awaiting /health balances — pools light up when the backend exposes them
        </p>
      ) : (
        <>
          <div className="ops-gauges">
            {rows.map((row) => {
              const tone = row.amount == null ? "awaiting" : row.informational ? "tel" : row.status;
              return (
                <div key={row.key} className={`ops-gauge ops-gauge--${tone}`} data-testid={`ops-pool-${row.key}`}>
                  <div className="ops-gauge-head">
                    <span className="ops-gauge-name">{row.label}</span>
                    <span className="ops-gauge-val">
                      {row.amountLabel}
                      {row.floorLabel ? <span className="ops-gauge-floor"> · {row.floorLabel}</span> : null}
                    </span>
                  </div>
                  {row.fill == null ? null : (
                    <div className="ops-meter">
                      <i style={{ width: `${Math.round(row.fill * 100)}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {solvency?.runwayNote ? (
            <p className="ops-runway" data-testid="ops-runway">
              <span className="ops-runway-label">Runway</span>
              {solvency.runwayNote}
            </p>
          ) : (
            <p className="ops-await ops-await--inline">runway — pending settlement data</p>
          )}
        </>
      )}
    </OpsZone>
  );
}
