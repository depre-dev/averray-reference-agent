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

import { OPS_GLOSS } from "../../lib/monitor/ops-gloss.js";
import type { GasSpendView, PayoutEvidence, SolvencySnapshot } from "../../lib/monitor/product-health.js";
import { splitPools, type PoolView } from "../../lib/monitor/ops-spec.js";
import { gasPoolNote, gasUnreadableNote, payoutRunwayNote } from "../../lib/monitor/ops-spec.js";
import { worstOpsTone, type OpsTone } from "../../lib/monitor/ops-model.js";

export interface SolvencyPanelProps {
  solvency: SolvencySnapshot | undefined;
  /** Gas attribution, for the signer pool's footnote. */
  gas?: GasSpendView | { unreadable: true; reason: string } | undefined;
  /** Payout evidence, for the reward bank's payouts-remaining footnote. */
  payout?: PayoutEvidence | undefined;
}

/**
 * The signer pool's footnote, or the reason there isn't one.
 *
 * An unreadable gas read is a SENTENCE, not an absence — a missing footnote and
 * a failed read look identical on screen, and only one of them is actionable.
 */
function gasNoteFor(
  gas: GasSpendView | { unreadable: true; reason: string } | undefined,
): { text: string; tone: OpsTone } | null {
  if (!gas) return null;
  if ("unreadable" in gas) return gasUnreadableNote(gas.reason);
  return gasPoolNote(gas);
}

/**
 * What each pool's sub-fact is ABOUT, named before it is read.
 *
 * Deliberately keyed by pool rather than derived from the note text: a key that
 * guessed from the words would silently mislabel a note that changed wording,
 * and the two notes here answer questions the reader picked the pool to ask.
 * A pool with no entry gets no key and renders exactly as it did before.
 */
const POOL_NOTE_KEY: Readonly<Record<string, string>> = {
  signer_gas: "BURN",
  reward_bank: "RUNWAY",
};

export function SolvencyPanel({ solvency, gas, payout }: SolvencyPanelProps) {
  const pools = solvency?.pools ?? [];
  const { floored, unfloored } = splitPools(pools);
  // The panel's edge rail — the worst tone among its own rows, the same
  // roll-up rule as a pillar's head dot. Peripheral state, no new claim.
  const rail = worstOpsTone([...floored, ...unfloored].map((v) => v.tone));

  return (
    <section
      className="ops-solvency"
      aria-label="Solvency — pools versus floors"
      data-testid="ops-solvency"
      data-rail={pools.length === 0 ? "awaiting" : rail}
    >
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">SOLVENCY — POOLS VS FLOORS</h2>
        <span className="ops-panel-note">absolute balances · fixed scales · floor = tick</span>
      </header>

      {pools.length === 0 ? (
        <p className="ops-awaiting" data-testid="ops-solvency-awaiting">
          awaiting balances — the product /health has not reported pools yet
        </p>
      ) : null}

      {floored.map((view) => {
        // Each pool's footnote answers what its meter cannot: the signer's is
        // what is draining it, the reward bank's is how many more payouts it
        // funds. Balance, floor and margin are on the meter and never repeated.
        const note =
          view.pool.key === "signer_gas"
            ? gasNoteFor(gas)
            : view.pool.key === "reward_bank"
              ? payoutRunwayNote({ pool: view.pool, payout, runwayNote: solvency?.runwayNote })
              : null;
        // The key names the question before the eye starts reading the answer.
        // Two pools' sub-facts answer two different questions and used to look
        // like one continuous grey paragraph running down the panel.
        const noteKey = POOL_NOTE_KEY[view.pool.key];
        return (
          <div key={view.pool.key}>
            <FlooredPool view={view} />
            {note ? (
              <p
                className={`ops-pool-note${noteKey ? " ops-pool-note--keyed" : ""}`}
                data-tone={note.tone}
                data-testid={`ops-pool-note-${view.pool.key}`}
              >
                {noteKey ? (
                  <span
                    className="ops-pool-note-key"
                    title={noteKey === "BURN" ? OPS_GLOSS.burn : noteKey === "RUNWAY" ? OPS_GLOSS.runway : undefined}
                  >
                    {noteKey}
                  </span>
                ) : null}
                <span className="ops-pool-note-val">{note.text}</span>
              </p>
            ) : null}
          </div>
        );
      })}

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
 * Both encodings of a pool's address, on ONE line, directly under its balance.
 *
 * They belong beside the number — an address in a separate strip means reading
 * one while looking at the other. The reason they can be here is arithmetic:
 * 42 hex characters plus 48 SS58 characters plus a label is ~100 monospace
 * glyphs, which at 9px is ~540px inside a ~620px pool row. Two lines did not
 * fit the board's height budget; one does, at half the cost.
 *
 * .ops-pool is a three-column grid, so this spans 1/-1 and must be rendered
 * LAST — anything before the amount pushes it onto its own row.
 *
 * Absent entirely for a pool whose figure did not come from a balance read.
 */
function PoolAddress({ view }: { view: PoolView }) {
  const { address, addressLabel, addressSs58 } = view.pool;
  if (!address) return null;
  return (
    <span className="ops-pool-addr" data-testid={`ops-pool-addr-${view.pool.key}`}>
      {/* Which encoding is which. Two 40-odd-character strings separated by a
          dot told the reader nothing about which wallet each one belongs in,
          and they are not interchangeable — the hex is what an EVM wallet and
          a block explorer take, the SS58 is what a Substrate wallet takes.
          Sending to the wrong form is the class of mistake this board exists
          to prevent, so the encoding is named rather than inferred. */}
      <span className="ops-pool-addr-key">EVM</span>
      <span className="ops-pool-addr-hex">{address}</span>
      <span className="ops-pool-addr-sep">·</span>
      {/* The key rides with the value it names. The absent case already says
          "SS58 unavailable" in words, and a key in front of it read as the
          stutter it was: "SS58 SS58 unavailable". */}
      {addressSs58 ? (
        <>
          <span className="ops-pool-addr-key">SS58</span>
          <span className="ops-pool-addr-hex ops-pool-addr-hex--ss58">{addressSs58}</span>
        </>
      ) : (
        <span className="ops-pool-addr-none">SS58 unavailable</span>
      )}
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
        <span className="ops-pool-margin" data-tone={view.marginTone} title={OPS_GLOSS.margin}>
          {view.margin}
        </span>
      </div>

      <div className="ops-pool-meter">
        <div
          className="ops-meter"
          role="meter"
          aria-label={`${view.pool.label} balance against its floor`}
          aria-valuenow={view.pool.amount ?? undefined}
          aria-valuemin={0}
          aria-valuetext={`${view.amountLabel} ${view.unit}, ${view.margin}`}
          title={OPS_GLOSS.floor}
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
      <PoolAddress view={view} />
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
      </span>
      <span className="ops-pool-amount ops-pool-amount--quiet">
        {view.amountLabel}
        <span className="ops-pool-unit">{view.unit}</span>
      </span>
      <PoolAddress view={view} />
    </div>
  );
}
