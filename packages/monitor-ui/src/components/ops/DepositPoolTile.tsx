// BANK — the shared deposit pool, reconstructed from the platform's read-only
// snapshot and rendered without a second arithmetic opinion.
//
// Two zero/absence rules are intentionally both stated here:
//   1. Real zero readings render as 0 and carry BORN EMPTY while depositorCount
//      is zero. On this surface zero is a measurement, never missing data.
//   2. A missing endpoint/profile renders UNAVAILABLE. It never gets defaulted
//      into zero. An incoherent payload is a separate, labeled FAULT and none of
//      its impossible figures render.

import type {
  DepositPoolAmount,
  DepositPoolBlock,
  DepositPoolFlow,
} from "../../lib/monitor/product-health.js";

import { formatPoolAmount } from "../../lib/monitor/ops-spec.js";

export function DepositPoolTile({ pool }: { pool: DepositPoolBlock | undefined }) {
  if (!pool || "unavailable" in pool) {
    const reason = pool && "unavailable" in pool
      ? pool.unavailable
      : "deposit pool snapshot is not supplied by this monitor build";
    return (
      <section className="ops-deposit-pool" data-tone="awaiting" data-testid="ops-deposit-pool">
        <Header />
        <p className="ops-deposit-pool-state" data-tone="awaiting">
          <strong>UNAVAILABLE</strong> — {reason}
        </p>
      </section>
    );
  }
  if ("fault" in pool) {
    return (
      <section className="ops-deposit-pool" data-tone="red" data-testid="ops-deposit-pool">
        <Header />
        <p className="ops-deposit-pool-state" data-tone="red">
          <strong>FAULT</strong> — {pool.fault}
        </p>
      </section>
    );
  }

  const snapshot = pool.snapshot;
  const bornEmpty = snapshot.flows?.depositorCount === 0;
  return (
    <section className="ops-deposit-pool" data-tone="ok" data-testid="ops-deposit-pool">
      <Header
        right={bornEmpty ? (
          <span className="ops-deposit-pool-born-empty" data-testid="ops-deposit-pool-born-empty">
            BORN EMPTY · ZEROES ARE MEASURED
          </span>
        ) : snapshot.block?.number !== undefined ? (
          <span>BLOCK {snapshot.block.number.toLocaleString("en-US")}</span>
        ) : undefined}
      />

      <dl className="ops-deposit-pool-grid">
        <Fact label="DEPOSITS" testId="ops-deposit-pool-deposits">
          {formatPoolAmount(snapshot.totalAssets, "USDC")}
        </Fact>
        <Fact label="BUFFER / DEPLOYED" testId="ops-deposit-pool-allocation">
          {formatPoolAmount(snapshot.buffer, "USDC")} buffer · {formatPoolAmount(snapshot.deployed, "USDC")} deployed
        </Fact>
        <Fact label="SHARE PRICE" testId="ops-deposit-pool-share-price">
          {formatPoolAmount(snapshot.sharePrice, "USDC/share")}
          <small>{snapshot.pricingModel ?? "pricing model not reported"}</small>
        </Fact>
        <Fact label="CAP" testId="ops-deposit-pool-cap">
          {formatBps(snapshot.caps?.utilizationBps)} utilized
          <small>
            {formatPoolAmount(snapshot.caps?.headroom, "USDC")} headroom
            {snapshot.caps?.totalAssetCap ? ` of ${formatPoolAmount(snapshot.caps.totalAssetCap, "USDC")}` : ""}
          </small>
        </Fact>
        <Fact label="DEPOSITORS" testId="ops-deposit-pool-depositors">
          {snapshot.flows?.depositorCount ?? "—"}
          <small>
            {formatPoolAmount(snapshot.flows?.pendingUnfulfilledRedemptionAssets, "USDC")} pending redemption
          </small>
        </Fact>
        <Fact label="YIELD" testId="ops-deposit-pool-yield">
          {snapshot.yieldStatus === "earning"
            ? "EARNING"
            : snapshot.yieldStatus === "not_yet_earning"
              ? "NOT YET EARNING"
              : "—"}
          {snapshot.yieldStatusText ? <small>{snapshot.yieldStatusText}</small> : null}
        </Fact>
      </dl>

      <div className="ops-deposit-pool-flows" data-tone={snapshot.flows?.status === "unavailable" ? "awaiting" : "ok"}>
        <div className="ops-deposit-pool-flow-head">
          <span>LAST FLOWS</span>
          <span data-testid="ops-deposit-pool-flow-window">{flowWindow(snapshot.flows?.window)}</span>
        </div>
        {snapshot.flows?.status === "unavailable" ? (
          <p>
            <strong>FLOWS UNAVAILABLE</strong>
            {snapshot.flows.lastError ? ` — ${snapshot.flows.lastError}` : ""}
          </p>
        ) : snapshot.flows?.recent?.length ? (
          <ul>
            {snapshot.flows.recent.slice(0, 6).map((flow, index) => (
              <li key={`${flow.transactionHash ?? flow.blockNumber ?? "flow"}-${flow.logIndex ?? index}`}>
                {flowLine(flow)}
              </li>
            ))}
          </ul>
        ) : (
          <p>no recent flows in the bounded window</p>
        )}
      </div>
    </section>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <div className="ops-deposit-pool-head">
      <h3>DEPOSIT POOL</h3>
      {right ? <span>{right}</span> : null}
    </div>
  );
}

function Fact({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}



function formatBps(bps: number | undefined): string {
  if (bps === undefined) return "—";
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}

function flowWindow(window: { fromBlock?: number; toBlock?: number; maxBlocks?: number } | undefined): string {
  if (window?.fromBlock === undefined || window.toBlock === undefined) return "bounded window not reported";
  return `blocks ${window.fromBlock.toLocaleString("en-US")}–${window.toBlock.toLocaleString("en-US")}` +
    (window.maxBlocks === undefined ? "" : ` · max ${window.maxBlocks.toLocaleString("en-US")}`);
}

function flowLine(flow: DepositPoolFlow): string {
  const label = ({
    deposit: "DEPOSIT",
    withdraw: "WITHDRAW",
    redeem_requested: "REDEEM REQUESTED",
    redeem_fulfilled: "REDEEM FULFILLED",
    operator_principal_contributed: "PRINCIPAL CONTRIBUTED",
    venue_loss_written_off: "LOSS WRITTEN OFF",
  } as Record<DepositPoolFlow["kind"], string>)[flow.kind];
  const assets = flow.assets ? ` · ${formatPoolAmount(flow.assets, "USDC")}` : "";
  const block = flow.blockNumber === undefined ? "" : ` · block ${flow.blockNumber.toLocaleString("en-US")}`;
  return `${label}${assets}${block}`;
}
