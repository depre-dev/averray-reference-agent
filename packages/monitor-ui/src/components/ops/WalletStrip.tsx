import type { SolvencySnapshot } from "../../lib/monitor/product-health.js";

/**
 * WALLETS — where the money actually sits.
 *
 * These addresses used to live inside the solvency rows, under each balance.
 * That was wrong twice over.
 *
 * MECHANICALLY: the board is a fixed 100vh with no scroll, and .ops-money takes
 * whatever is left. Two extra lines per pool is twelve lines of hex, and at
 * 1440x900 — an ordinary laptop — it pushed `Escrow` half off the bottom and
 * `Protocol revenue` off entirely. Reference text displaced real balances.
 *
 * GRAMMATICALLY: the solvency panel answers "am I solvent". An address answers
 * "where do I send funds". Those are different questions asked at different
 * moments — one every glance, the other twice a month — and interleaving them
 * makes the frequent one harder to read.
 *
 * So the addresses get their own strip: full board width, one line per wallet,
 * both encodings side by side because at ~1400px they fit without truncation.
 * Five rows instead of twelve lines, and the meters get their space back.
 *
 * Only pools that carry an address appear. The reward bank has none — its
 * figure comes from the product's own /health rather than a balance read — and
 * the strip omitting it is the same honesty the row omitting it was.
 */
export function WalletStrip({ solvency }: { solvency: SolvencySnapshot | undefined }) {
  const wallets = (solvency?.pools ?? []).filter((pool) => pool.address);
  if (wallets.length === 0) return null;

  return (
    <section className="ops-wallets" aria-label="Wallets — where funds sit" data-testid="ops-wallets">
      <div className="ops-wallets-head">
        <h2>WALLETS</h2>
        <span className="ops-panel-note">
          where funds sit · EVM and SS58 are the SAME account, two encodings
        </span>
      </div>
      {wallets.map((pool) => (
        <div className="ops-wallet" key={pool.key} data-testid={`ops-wallet-${pool.key}`}>
          <span className="ops-wallet-label">{pool.addressLabel ?? pool.label}</span>
          <span className="ops-wallet-addr">{pool.address}</span>
          {/* Absent when the EVM address is malformed — no address beats a
              plausible one, since the only use for it is pasting into a wallet. */}
          <span className="ops-wallet-addr ops-wallet-addr--ss58">
            {pool.addressSs58 ?? <span className="ops-wallet-missing">SS58 unavailable</span>}
          </span>
          <span className="ops-wallet-pool">{pool.label}</span>
        </div>
      ))}
    </section>
  );
}
