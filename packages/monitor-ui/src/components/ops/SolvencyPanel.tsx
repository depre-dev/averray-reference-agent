// SOLVENCY — pools vs floors.
//
// Two lists, and the split between them is the point:
//
//   FLOORED   — a pool with a floor gets a meter, because a meter needs a scale
//               and the floor is the scale. Absolute balance on the right at
//               display size; the bar is just a shape for that number.
//   UNFLOORED — a pool with no floor gets NO BAR, only its balance and the
//               operator's reason for it being that way. A full bar over a
//               deliberately-empty reserve reads as "healthy and full"; that
//               shipped once, and the missing meter is the fix.
//
// Percentages never lead here. 5% of 2 TB is comfort; 20% of 20 GB is about to
// fail — so the absolute number is the status.

import type { SolvencySnapshot } from "../../lib/monitor/product-health.js";
import { splitPools, type PoolView } from "../../lib/monitor/ops-spec.js";

export interface SolvencyPanelProps {
  solvency: SolvencySnapshot | undefined;
}

export function SolvencyPanel({ solvency }: SolvencyPanelProps) {
  const pools = solvency?.pools ?? [];
  const { floored, unfloored } = splitPools(pools);

  return (
    <section className="ops-solvency" aria-label="Solvency — pools versus floors" data-testid="ops-solvency">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">SOLVENCY — POOLS VS FLOORS</h2>
        <span className="ops-panel-note">absolute balances · fixed scales · floor = tick</span>
      </header>

      {pools.length === 0 ? (
        <p className="ops-awaiting" data-testid="ops-solvency-awaiting">
          awaiting balances — the product /health has not reported pools yet
        </p>
      ) : null}

      {floored.map((view) => (
        <FlooredPool key={view.pool.key} view={view} />
      ))}

      {unfloored.length > 0 ? (
        <>
          <div className="ops-solvency-divider">
            <span>NO FLOOR — NO METER, BY DESIGN</span>
            <i aria-hidden />
          </div>
          {unfloored.map((view) => (
            <UnflooredPool key={view.pool.key} view={view} />
          ))}
        </>
      ) : null}
    </section>
  );
}

/**
 * The address a pool's number was read from.
 *
 * Shown in FULL, not truncated: the point of putting a wallet on the board is
 * that an operator can check which one it is, and a 6-character prefix does not
 * settle "is this the treasury multisig or the reserve". It renders quiet so it
 * informs without competing with the balance.
 *
 * Absent for any pool whose figure did not come from a balance read — the row
 * simply shows no address, rather than borrowing a plausible one and implying a
 * provenance the number does not have.
 */
function PoolAddress({ view }: { view: PoolView }) {
  const { address, addressLabel } = view.pool;
  if (!address) return null;
  return (
    <span className="ops-pool-addr" data-testid={`ops-pool-addr-${view.pool.key}`}>
      <span className="ops-pool-addr-hex">{address}</span>
      {addressLabel ? <span className="ops-pool-addr-label">{addressLabel}</span> : null}
    </span>
  );
}

function FlooredPool({ view }: { view: PoolView }) {
  const meter = view.meter;
  if (!meter) return null;
  // Keep the "0" origin label off the floor tick when they would collide.
  const showZero = meter.floorPct >= 18;
  const centreFloorLabel = meter.floorPct >= 15;

  return (
    <div className="ops-pool" data-tone={view.tone} data-testid={`ops-pool-${view.pool.key}`}>
      <div className="ops-pool-id">
        <span className="ops-pool-name">{view.pool.label}</span>
        <span className="ops-pool-margin" data-tone={view.marginTone}>
          {view.margin}
        </span>
      </div>
      <PoolAddress view={view} />

      <div className="ops-pool-meter">
        <div
          className="ops-meter"
          role="meter"
          aria-label={`${view.pool.label} balance against its floor`}
          aria-valuenow={view.pool.amount ?? undefined}
          aria-valuemin={0}
          aria-valuetext={`${view.amountLabel} ${view.unit}, ${view.margin}`}
        >
          <i className="ops-meter-fill" data-tone={view.tone} style={{ width: `${meter.fillPct}%` }} />
          <i className="ops-meter-floor" style={{ left: `${meter.floorPct}%` }} aria-hidden />
          {meter.overScale ? <i className="ops-meter-over" aria-hidden /> : null}
        </div>
        <div className="ops-meter-scale" aria-hidden>
          {showZero ? <span className="at-zero">0</span> : null}
          <span
            className="at-floor"
            style={{
              left: `${meter.floorPct}%`,
              transform: centreFloorLabel ? "translateX(-50%)" : "none",
            }}
          >
            floor {meter.floorLabel}
          </span>
          <span className="at-scale">{meter.overScale ? `≥${meter.scaleLabel}` : meter.scaleLabel}</span>
        </div>
      </div>

      <div className="ops-pool-amount" data-tone={view.tone}>
        {view.amountLabel}
        <span className="ops-pool-unit">{view.unit}</span>
      </div>
    </div>
  );
}

function UnflooredPool({ view }: { view: PoolView }) {
  return (
    <div className="ops-pool ops-pool--unfloored" data-testid={`ops-pool-${view.pool.key}`}>
      <span className="ops-pool-name">{view.pool.label}</span>
      {/* The operator's own declaration for why this pool has no floor. Without
          it, an empty pool is indistinguishable from a broken one — so when
          there is no note we say we do not know, rather than implying it's fine. */}
      <span className="ops-pool-note">
        {view.pool.note ?? (view.pool.informational ? "informational — not floored" : "no floor declared for this pool")}
        <PoolAddress view={view} />
      </span>
      <span className="ops-pool-amount ops-pool-amount--quiet">
        {view.amountLabel}
        <span className="ops-pool-unit">{view.unit}</span>
      </span>
    </div>
  );
}
