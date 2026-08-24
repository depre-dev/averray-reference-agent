import type {
  OvernightEvent,
  OvernightLedgerPayload,
  OvernightWindow,
  RemoteFeedReading,
  RewardBankSplit,
  TopupDestinationsPayload,
} from "../../lib/monitor/overnight-ledger.js";
import {
  feedStateCopy,
  moneyDisplay,
  signedMoneyDisplay,
} from "../../lib/monitor/overnight-ledger.js";

export interface LedgerPanelProps {
  reading: RemoteFeedReading<OvernightLedgerPayload>;
  window: OvernightWindow;
}

export function OvernightDigest({
  reading,
  window,
  onWindowChange,
}: LedgerPanelProps & { onWindowChange: (window: OvernightWindow) => void }) {
  return (
    <section className="ops-overnight-digest" data-testid="ops-overnight-digest" data-feed-state={reading.state}>
      <header className="ops-ledger-head">
        <span>
          <strong>OVERNIGHT DIGEST</strong>
          <small>template-generated · one window governs every ledger read</small>
        </span>
        <label className="ops-ledger-window">
          <span>window</span>
          <select
            aria-label="Overnight ledger window"
            value={window}
            onChange={(event) => onWindowChange(event.currentTarget.value as OvernightWindow)}
          >
            <option value="12h">12h</option>
            <option value="24h">24h</option>
            <option value="48h">48h</option>
          </select>
        </label>
      </header>
      {reading.state !== "live" ? <FeedState reading={reading} /> : <DigestLines ledger={reading.data} />}
    </section>
  );
}

function DigestLines({ ledger }: { ledger: OvernightLedgerPayload }) {
  const digest = ledger.digest;
  return (
    <div className="ops-digest-lines">
      <p>
        <i aria-hidden>›</i>
        <span>
          Last {ledger.window}: {digest.settlementCount} settlements by {digest.walletCount} wallets ({digest.newWalletCount} new)
          {" · "}{moneyDisplay(digest.paid)} paid, {moneyDisplay(digest.retained)} retained
          {" · "}bank {moneyDisplay(digest.bankOpen)} → {moneyDisplay(digest.bankClose)} ({moneyDisplay(digest.bankLocked)} locked)
          {" · "}{digest.stuckClaimCount} claims stuck · gas {signedMoneyDisplay(digest.gasDelta)} DOT.
        </span>
        <small>tpl:money</small>
      </p>
      <p>
        <i aria-hidden>›</i>
        <span>
          Ladder: {digest.graduatedCount} graduated · {digest.waiverWindowsExhausted} waiver windows exhausted
          {" · "}{digest.firstExternalPostings} first external postings · {digest.walletsInFreeWindow} wallets in free window.
        </span>
        <small>tpl:ladder</small>
      </p>
      <p>
        <i aria-hidden>›</i>
        <span>
          Capability: {digest.warningsOpen} warnings open, {digest.warningsClosed} closed · {digest.deployCount} deploys
          {" · "}ledger vs chain proof {digest.ledgerMatchState} (Δ {signedMoneyDisplay(digest.ledgerDelta)}).
        </span>
        <small>tpl:capability</small>
      </p>
    </div>
  );
}

export function MoneyMovementPanel({ reading, window }: LedgerPanelProps) {
  return (
    <section className="ops-money-movement" data-testid="ops-money-movement" data-feed-state={reading.state}>
      <PanelHead title={`MONEY MOVEMENT — ${window.toUpperCase()}`} state={reading.state} />
      {reading.state !== "live" ? <FeedState reading={reading} /> : <MoneyMovementLive ledger={reading.data} />}
    </section>
  );
}

function MoneyMovementLive({ ledger }: { ledger: OvernightLedgerPayload }) {
  const value = ledger.reconciliation;
  const rows = [
    { key: "opening", label: "OPENING LIQUID", amount: moneyDisplay(value.openingLiquid), note: "window-open reward-bank snapshot" },
    { key: "payouts", label: "PAYOUTS OUT", amount: value.payoutsOut.netUsdc.display == null ? "—" : `−${moneyDisplay(value.payoutsOut.netUsdc)}`, note: `${value.payoutsOut.count} settlements · ${value.payoutsOut.walletCount} wallets` },
    { key: "retention", label: "RETENTION + FEES IN", amount: signedMoneyDisplay(value.retentionFeesIn), note: "worker retention + poster protocol fees" },
    { key: "reserved", label: "RESERVED Δ", amount: signedMoneyDisplay(value.reservedDelta), note: "locked behind minted or claimed jobs" },
    { key: "closing", label: "CLOSING LIQUID", amount: moneyDisplay(value.closingLiquid), note: "window-close reward-bank snapshot" },
  ];
  return (
    <div className="ops-money-ledger">
      {rows.map((row) => (
        <div className="ops-money-ledger-row" key={row.key} data-row={row.key}>
          <i aria-hidden />
          <span><strong>{row.label}</strong><small>{row.note}</small></span>
          <b>{row.amount}</b>
        </div>
      ))}
      <div className="ops-money-match" data-match={value.match.toLowerCase()}>
        <span>
          <strong>{value.match}</strong>
          {value.match === "CONFIRMED" ? "ledger matches chain proof" : "ledger does not match chain proof"}
          <a href="#payout-evidence">→ PAYOUT EVIDENCE · FLOW</a>
        </span>
        <small>
          Δ {signedMoneyDisplay(value.delta)} · {value.proofTiedCount} proofs tied
          {value.proofMissingCount > 0 ? ` · ${value.proofMissingCount} missing` : ""}
        </small>
      </div>
    </div>
  );
}

export function RetentionWaiversPanel({ reading, window }: LedgerPanelProps) {
  return (
    <section className="ops-retention" data-testid="ops-retention" data-feed-state={reading.state}>
      <PanelHead title={`RETENTION & WAIVERS — ${window.toUpperCase()}`} state={reading.state} />
      {reading.state !== "live" ? <FeedState reading={reading} /> : (() => {
        const value = reading.data.retention;
        const budget = Number(value.subsidyDailyBudget.display ?? 0);
        const spend = Number(value.subsidySpend.display ?? 0);
        const usedPct = budget > 0 ? Math.min(100, (spend / budget) * 100) : 0;
        return (
          <div className="ops-retention-body">
            <div className="ops-retention-pair">
              <span><small>CHARGED</small><strong>{moneyDisplay(value.charged)}</strong><i>{value.chargedSettlementCount} settlements retained</i></span>
              <span><small>WAIVED</small><strong>{moneyDisplay(value.waived)}</strong><i>{value.waivedSettlementCount} settlements in free window</i></span>
            </div>
            <p><b>WAIVER SLOTS CONSUMED</b><span>{value.waiverSlotsConsumed} / {value.waiverSlotsTotal} slots · {value.walletsInFreeWindow} wallets in free window</span></p>
            <div className="ops-retention-budget">
              <span><b>SUBSIDY SPEND</b><small>{moneyDisplay(value.subsidySpend)} / {moneyDisplay(value.subsidyDailyBudget)} daily budget</small></span>
              <i><b style={{ width: `${usedPct}%` }} /></i>
            </div>
            <p className="ops-retention-revenue"><b>→ PROTOCOL REVENUE Δ</b><span>{signedMoneyDisplay(value.protocolRevenueDelta)}</span></p>
          </div>
        );
      })()}
    </section>
  );
}

export function EventsLane({ reading, window }: LedgerPanelProps) {
  return (
    <section className="ops-ledger-events" data-testid="ops-ledger-events" data-feed-state={reading.state}>
      <PanelHead title={`EVENTS — ${window.toUpperCase()}`} state={reading.state} />
      {reading.state !== "live" ? <FeedState reading={reading} /> : (
        <div className="ops-event-list">
          {reading.data.events.items.length === 0 ? (
            <p className="ops-ledger-empty">no lifecycle event recorded in this window</p>
          ) : reading.data.events.items.slice().reverse().map((event, index) => (
            <EventRow event={event} key={`${event.timestamp}:${event.type}:${index}`} />
          ))}
          {reading.data.events.hasOlder ? (
            <p className="ops-events-older">{reading.data.events.totalCount - reading.data.events.returnedCount} older events in window</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function EventRow({ event }: { event: OvernightEvent }) {
  const payload = event.payload;
  const suffix = event.wallet ? ` · ${shortIdentifier(event.wallet)}` : "";
  const detail = event.type === "wallet_graduated"
    ? `wallet graduated${typeof payload.to === "string" ? ` → ${payload.to}` : ""}${suffix}`
    : event.type === "waiver_window_exhausted"
      ? `waiver window exhausted${suffix}`
      : event.type === "first_external_posting"
        ? `first external posting${suffix}`
        : event.type === "capability_warning_opened"
          ? `capability warning opened${typeof payload.code === "string" ? ` · ${payload.code}` : ""}`
          : event.type === "capability_warning_closed"
            ? `capability warning closed${typeof payload.code === "string" ? ` · ${payload.code}` : ""}`
            : event.type === "claim_stuck"
              ? `claim stuck${suffix}`
              : event.type === "reserved_locked"
                ? `reserved locked${suffix}`
                : event.type === "deploy"
                  ? `deploy${typeof payload.deployedSha === "string" ? ` · ${payload.deployedSha.slice(0, 8)}` : ""}`
                  : event.type.replaceAll("_", " ");
  return (
    <div className="ops-event-row" data-severity={event.severity}>
      <i aria-hidden />
      <span><time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time><b>{detail}</b></span>
    </div>
  );
}

export function WorkersTable({ reading }: { reading: RemoteFeedReading<OvernightLedgerPayload> }) {
  return (
    <section className="ops-workers" data-testid="ops-workers" data-feed-state={reading.state}>
      {reading.state !== "live" ? <FeedState reading={reading} /> : (
        <div className="ops-workers-scroll">
          <div className="ops-workers-table" role="table" aria-label={`Workers — ${reading.data.window}`}>
            <div className="ops-workers-row ops-workers-head" role="row" data-testid="ops-workers-head">
              {[
                "WALLET", "SESSION SPAN", "CLAIMS", "APPR", "REJ", "GROSS → NET", "RETENTION",
                "WAIVER", "TIER", "BALANCE", "WITHDRAWN",
              ].map((label) => <span role="columnheader" key={label}>{label}</span>)}
            </div>
            {reading.data.workers.items.length === 0 ? (
              <p className="ops-ledger-empty">no worker activity recorded in this window</p>
            ) : reading.data.workers.items.map((worker) => (
              <div className="ops-workers-row" role="row" key={worker.wallet} data-testid="ops-worker-row">
                <span role="cell" title={worker.wallet}>
                  {shortIdentifier(worker.wallet)}{worker.isFirstEverActivity ? <small className="ops-worker-new">NEW</small> : null}
                </span>
                <span role="cell">{sessionSpan(worker.sessionStart, worker.sessionEnd, worker.sessionHours)}</span>
                <span role="cell">{worker.claims}</span>
                <span role="cell">{worker.approved}</span>
                <span role="cell">{worker.rejected}</span>
                <span role="cell">{moneyDisplay(worker.grossEarned)} → {moneyDisplay(worker.netEarned)}</span>
                <span role="cell">{moneyDisplay(worker.retentionPaid)}{Number(worker.retentionWaived.raw ?? 0) > 0 ? ` · ${moneyDisplay(worker.retentionWaived)} waived` : ""}</span>
                <span role="cell">{worker.waiverSlotsUsed}/{worker.waiverSlotsTotal}</span>
                <span role="cell">{tierText(worker.reputationTier, worker.tierEvents)}</span>
                <span role="cell">{moneyDisplay(worker.balanceNow)}{worker.balanceNow.complete ? "" : " · partial"}</span>
                <span role="cell">{moneyDisplay(worker.withdrawnInWindow)}</span>
              </div>
            ))}
            {reading.data.workers.items.length > 0 ? <WorkerTotals ledger={reading.data} /> : null}
          </div>
        </div>
      )}
    </section>
  );
}

function WorkerTotals({ ledger }: { ledger: OvernightLedgerPayload }) {
  const totals = ledger.workers.totals;
  return (
    <div className="ops-workers-row ops-workers-total" role="row">
      <span role="cell">WINDOW TOTAL · {totals.walletCount} wallets</span>
      <span role="cell" />
      <span role="cell">{totals.claims}</span>
      <span role="cell">{totals.approved}</span>
      <span role="cell">{totals.rejected}</span>
      <span role="cell">{moneyDisplay(totals.grossEarned)} → {moneyDisplay(totals.netEarned)}</span>
      <span role="cell">{moneyDisplay(totals.retentionPaid)}</span>
      <span role="cell">—</span>
      <span role="cell">—</span>
      <span role="cell">{moneyDisplay(totals.balanceNow)}</span>
      <span role="cell">{moneyDisplay(totals.withdrawnInWindow)}</span>
    </div>
  );
}

export function RewardBankSplitRow({
  reading,
  window,
  showBar = true,
}: {
  reading: RemoteFeedReading<OvernightLedgerPayload>;
  window: OvernightWindow;
  showBar?: boolean;
}) {
  return (
    <div className="ops-reward-split" data-testid="ops-reward-bank-split" data-feed-state={reading.state}>
      {reading.state !== "live" ? <FeedState reading={reading} compact /> : <RewardSplit split={reading.data.rewardBankSplit} window={window} showBar={showBar} />}
    </div>
  );
}

function RewardSplit({ split, window, showBar }: { split: RewardBankSplit; window: OvernightWindow; showBar: boolean }) {
  const liquid = Number(split.liquid.display ?? 0);
  const reserved = Number(split.reserved.display ?? 0);
  const total = Math.max(0, liquid + reserved);
  const liquidPct = total > 0 ? (liquid / total) * 100 : 0;
  const reservedPct = total > 0 ? (reserved / total) * 100 : 0;
  return (
    <>
      {showBar ? (
        <div className="ops-reward-split-bar" role="meter" aria-label="Reward bank liquid and reserved split" aria-valuenow={total}>
          <i data-part="liquid" style={{ width: `${liquidPct}%` }} />
          <i data-part="reserved" style={{ width: `${reservedPct}%` }} />
        </div>
      ) : null}
      <div className="ops-reward-split-key">
        <span><i data-part="liquid" />liquid <b>{moneyDisplay(split.liquid)}</b></span>
        <span><i data-part="reserved" />reserved <b>{moneyDisplay(split.reserved)}</b></span>
        <span>runway <b>{formatRunway(split.runwayDays)}</b> d · liquid only</span>
      </div>
      <p className="ops-reward-delta">
        liquid {signedMoneyDisplay(split.liquidDelta)} · reserved {signedMoneyDisplay(split.reservedDelta)} · {window}
      </p>
    </>
  );
}

export function TopupBlock({
  account,
  reading,
}: {
  account: "signerGas" | "rewardBank";
  reading: RemoteFeedReading<TopupDestinationsPayload>;
}) {
  const destination = reading.state === "live" ? reading.data.topupDestinations[account] : undefined;
  return (
    <div className="ops-topup" data-testid={`ops-topup-${account}`} data-feed-state={reading.state}>
      <strong>TOP-UP</strong>
      {!destination ? <FeedState reading={reading} compact /> : (
        <>
          <div>
            <code>{destination.ss58Address}</code>
            <button type="button" onClick={() => void copyText(destination.ss58Address)}>copy</button>
          </div>
          <p>
            send {destination.asset} · {destination.network}
            {destination.exchangeNetworkLabel ? ` · exchange network “${destination.exchangeNetworkLabel}”` : ""}
          </p>
          {destination.landsInEoa ? (
            <p>lands in EOA — run <code>{destination.followUpCommand ?? "the configured follow-up"}</code> to move it into the bank</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function PanelHead({ title, state }: { title: string; state: RemoteFeedReading<unknown>["state"] }) {
  return (
    <header className="ops-ledger-panel-head">
      <h3>{title}</h3>
      <span data-feed-state={state}>{state}</span>
    </header>
  );
}

function FeedState({ reading, compact = false }: { reading: RemoteFeedReading<unknown>; compact?: boolean }) {
  return (
    <p className={`ops-ledger-state${compact ? " ops-ledger-state--compact" : ""}`} data-testid="ops-ledger-state" role="status">
      <strong>{reading.state.toUpperCase()}</strong>
      <span>{feedStateCopy(reading)}</span>
    </p>
  );
}

function tierText(tier: string | null, events: Array<{ from?: string | null; to?: string | null }>): string {
  const latest = events.at(-1);
  if (latest?.from && latest.to) return `${latest.from} → ${latest.to}`;
  return tier ?? "—";
}

function sessionSpan(start: string | null, end: string | null, hours: number): string {
  if (!start || !end) return "—";
  return `${formatTime(start)} → ${formatTime(end)} · ${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(11, 16);
}

function formatRunway(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function shortIdentifier(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(value);
}
