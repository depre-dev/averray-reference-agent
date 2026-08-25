import { useMemo, useState } from "react";

import type { MonitorBoard } from "../../lib/monitor/board-cache.js";
import {
  feedStateCopy,
  moneyDisplay,
  signedMoneyDisplay,
  type MonitorReadIdentity,
  type OvernightEvent,
  type OvernightLedgerPayload,
  type OvernightWindow,
  type RemoteFeedReading,
  type RemoteFeedState,
  type TopupDestinationsPayload,
} from "../../lib/monitor/overnight-ledger.js";
import {
  deriveOpsActionItems,
  disputeClockLine,
  flowFunnel,
  lifecycleNote,
  payoutView,
  readIdentityView,
  statusVitalViews,
  type OpsActionItem,
  type StatusVitalView,
  volumeMixNote,
} from "../../lib/monitor/ops-spec.js";
import { phoneVerdict } from "../../lib/monitor/phone-spec.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";

export type MobileOpsScreen = "status" | "money" | "work" | "events";
type MobileDestination = MobileOpsScreen | "more";
type EventFilter = "all" | "ok" | "warn" | "fault";

export interface MobileBoardProps {
  health?: ProductHealth;
  board?: MonitorBoard;
  streamStatus?: string;
  streamDegraded?: boolean;
  nowMs?: number;
  overnightLedger?: RemoteFeedReading<OvernightLedgerPayload>;
  topupDestinations?: RemoteFeedReading<TopupDestinationsPayload>;
  readIdentity?: RemoteFeedReading<MonitorReadIdentity>;
  overnightWindow?: OvernightWindow;
  onOvernightWindowChange?: (window: OvernightWindow) => void;
  initialScreen?: MobileOpsScreen;
  initialMoreOpen?: boolean;
}

const DEFAULT_LEDGER: RemoteFeedReading<OvernightLedgerPayload> = {
  state: "unavailable",
  reason: "feed unavailable — overnight ledger read not supplied",
};
const DEFAULT_TOPUPS: RemoteFeedReading<TopupDestinationsPayload> = {
  state: "unavailable",
  reason: "feed unavailable — top-up destination read not supplied",
};
const DEFAULT_READ_IDENTITY: RemoteFeedReading<MonitorReadIdentity> = {
  state: "unavailable",
  reason: "read identity unavailable — feed not supplied",
};

export function MobileBoard({
  health,
  board,
  streamStatus = "open",
  streamDegraded = false,
  nowMs = Date.now(),
  overnightLedger = DEFAULT_LEDGER,
  topupDestinations = DEFAULT_TOPUPS,
  readIdentity = DEFAULT_READ_IDENTITY,
  overnightWindow = "24h",
  onOvernightWindowChange = () => undefined,
  initialScreen = "status",
  initialMoreOpen = false,
}: MobileBoardProps) {
  const [screen, setScreen] = useState<MobileOpsScreen>(initialScreen);
  const [moreOpen, setMoreOpen] = useState(initialMoreOpen);

  const navigate = (destination: MobileDestination) => {
    if (destination === "more") {
      setMoreOpen(true);
      return;
    }
    setScreen(destination);
    setMoreOpen(false);
  };

  return (
    <div className="hm-mobile-board" data-testid="mobile-board" data-screen={moreOpen ? "more" : screen}>
      {moreOpen ? (
        <MoreSheet
          health={health}
          ledger={overnightLedger}
          readIdentity={readIdentity}
          window={overnightWindow}
          onClose={() => setMoreOpen(false)}
        />
      ) : (
        <>
          <MobileHeader screen={screen} window={overnightWindow} onWindowChange={onOvernightWindowChange} />
          <main className="hm-mobile-main">
            {screen === "status" ? (
              <StatusScreen
                health={health}
                ledger={overnightLedger}
                streamStatus={streamStatus}
                streamDegraded={streamDegraded}
                nowMs={nowMs}
              />
            ) : null}
            {screen === "money" ? (
              <MoneyScreen ledger={overnightLedger} topups={topupDestinations} window={overnightWindow} />
            ) : null}
            {screen === "work" ? (
              <WorkScreen health={health} ledger={overnightLedger} window={overnightWindow} nowMs={nowMs} />
            ) : null}
            {screen === "events" ? <EventsScreen ledger={overnightLedger} window={overnightWindow} /> : null}
          </main>
        </>
      )}
      <BottomNavigation active={moreOpen ? "more" : screen} onNavigate={navigate} />
      <span className="hm-mobile-board-clock" aria-hidden>{board?.at ? `snapshot ${board.at}` : "live monitor read"}</span>
    </div>
  );
}

function MobileHeader({
  screen,
  window,
  onWindowChange,
}: {
  screen: MobileOpsScreen;
  window: OvernightWindow;
  onWindowChange: (window: OvernightWindow) => void;
}) {
  return (
    <header className="hm-mobile-header">
      <span className="hm-mobile-brand"><i aria-hidden />HERMES OPS</span>
      <strong>{screen}</strong>
      <WindowSelector value={window} onChange={onWindowChange} />
    </header>
  );
}

function WindowSelector({ value, onChange }: { value: OvernightWindow; onChange: (window: OvernightWindow) => void }) {
  return (
    <div className="hm-mobile-window" role="group" aria-label="Shared board window">
      {(["12h", "24h", "48h"] as const).map((window) => (
        <button
          type="button"
          key={window}
          aria-pressed={window === value}
          onClick={() => onChange(window)}
        >
          {window}
        </button>
      ))}
    </div>
  );
}

function StatusScreen({
  health,
  ledger,
  streamStatus,
  streamDegraded,
  nowMs,
}: {
  health?: ProductHealth;
  ledger: RemoteFeedReading<OvernightLedgerPayload>;
  streamStatus: string;
  streamDegraded: boolean;
  nowMs: number;
}) {
  const vitals = statusVitalViews({ health, ledger });
  const verdict = health ? phoneVerdict({ health, streamDegraded, nowMs }) : null;
  const verdictState: RemoteFeedState = !health ? "loading" : streamDegraded ? "unavailable" : "live";
  const partial = vitals.some((vital) => vital.state !== "live");
  const actionReading: RemoteFeedReading<OpsActionItem[]> = !health
    ? { state: "loading", reason: "action derivation loading — waiting for product health" } as const
    : ledger.state !== "live"
      ? { state: ledger.state, reason: ledger.reason }
      : {
          state: "live" as const,
          data: deriveOpsActionItems({
            verdict: { reason: verdict!.reason },
            health,
            ledger: ledger.data,
          }),
        };

  return (
    <div className="hm-mobile-screen" data-testid="mobile-status-screen">
      {partial ? (
        <div className="hm-mobile-partial" data-testid="mobile-partial-view">
          <StateChip state="unavailable" label="PARTIAL VIEW" />
          <span>some readings are unavailable · no missing figure is drawn as zero</span>
        </div>
      ) : null}

      <section className="hm-mobile-panel hm-mobile-verdict" data-feed-state={verdictState}>
        <PanelHeading title="OPERATOR VERDICT" state={verdictState} />
        {verdict ? (
          <>
            <strong data-tone={verdict.tone}>{verdict.headline}</strong>
            <span>{verdict.kicker}</span>
            <p className="hm-mobile-verdict-reason">reason · {verdict.reason}</p>
            {streamDegraded ? <p>stream {streamStatus} — last observed verdict only</p> : null}
          </>
        ) : (
          <FeedState state="loading" reason="product health loading — waiting for the first read" />
        )}
      </section>

      <section className="hm-mobile-vitals" aria-label="Status vitals">
        {vitals.map((vital) => <VitalTile vital={vital} key={vital.key} />)}
      </section>

      <MobileDigest reading={ledger} />

      <MobileActions reading={actionReading} />
    </div>
  );
}

function VitalTile({ vital }: { vital: StatusVitalView }) {
  return (
    <article className="hm-mobile-vital" data-testid={`mobile-vital-${vital.key}`} data-feed-state={vital.state}>
      <span>{vital.label}</span>
      {vital.state === "live" ? (
        <strong>
          {vital.value}<small>{vital.unit}</small>
        </strong>
      ) : (
        <strong aria-label={`${vital.label} unavailable`}>—</strong>
      )}
      <p>{vital.detail}</p>
    </article>
  );
}

function MobileActions({ reading }: { reading: RemoteFeedReading<OpsActionItem[]> }) {
  return (
    <section className="hm-mobile-panel" data-testid="mobile-actions" data-feed-state={reading.state}>
      <PanelHeading title="ACT ON THIS" state={reading.state} />
      {reading.state !== "live" ? <ReadingState reading={reading} /> : reading.data.length === 0 ? (
        <p className="hm-mobile-actions-empty" data-testid="mobile-actions-empty">nothing needs you</p>
      ) : (
        <ol className="hm-mobile-actions-list">
          {reading.data.map((item) => (
            <li key={`${item.title}:${item.since}`} data-severity={item.severity}>
              <i aria-hidden /><span><strong>{item.title}</strong><small>{item.detail}</small></span>
              <time dateTime={item.since}>since {formatTime(item.since)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MobileDigest({ reading }: { reading: RemoteFeedReading<OvernightLedgerPayload> }) {
  return (
    <section className="hm-mobile-panel" data-testid="mobile-digest" data-feed-state={reading.state}>
      <PanelHeading title="OVERNIGHT DIGEST" state={reading.state} />
      {reading.state !== "live" ? <ReadingState reading={reading} /> : (
        <div className="hm-mobile-digest-lines">
          <p>
            <i aria-hidden>›</i>
            <span>
               Last {reading.data.window}: {reading.data.digest.settlementCount} settlements by {reading.data.digest.walletCount} {reading.data.digest.walletCount === 1 ? "wallet" : "wallets"}
              {" · "}{moneyDisplay(reading.data.digest.paid)} paid, {moneyDisplay(reading.data.digest.retained)} retained
              {" · "}bank {moneyDisplay(reading.data.digest.bankOpen)} → {moneyDisplay(reading.data.digest.bankClose)}.
            </span>
          </p>
          <p>
            <i aria-hidden>›</i>
            <span>
              Ladder: {reading.data.digest.graduatedCount} graduated · {reading.data.digest.waiverWindowsExhausted} waiver windows exhausted
              {" · "}{reading.data.digest.firstExternalPostings} first external postings.
            </span>
          </p>
          <p>
            <i aria-hidden>›</i>
            <span>
              {reading.data.digest.stuckClaimCount} claims stuck · {reading.data.digest.deployCount} deploys
              {" · "}ledger {reading.data.digest.ledgerMatchState} (Δ {signedMoneyDisplay(reading.data.digest.ledgerDelta)}).
            </span>
          </p>
        </div>
      )}
    </section>
  );
}

function MoneyScreen({
  ledger,
  topups,
  window,
}: {
  ledger: RemoteFeedReading<OvernightLedgerPayload>;
  topups: RemoteFeedReading<TopupDestinationsPayload>;
  window: OvernightWindow;
}) {
  return (
    <div className="hm-mobile-screen" data-testid="mobile-money-screen">
      <section className="hm-mobile-panel" data-testid="mobile-money-movement" data-feed-state={ledger.state}>
        <PanelHeading title={`MONEY MOVEMENT — ${window.toUpperCase()}`} state={ledger.state} />
        {ledger.state !== "live" ? <ReadingState reading={ledger} /> : <MobileMoneyMovement ledger={ledger.data} />}
      </section>

      <section className="hm-mobile-panel" data-testid="mobile-solvency" data-feed-state={ledger.state}>
        <PanelHeading title="SOLVENCY" state={ledger.state} />
        {ledger.state !== "live" ? <ReadingState reading={ledger} /> : <MobileRewardBank ledger={ledger.data} window={window} />}
        <div className="hm-mobile-topups">
          <MobileTopup account="signerGas" reading={topups} />
          <MobileTopup account="rewardBank" reading={topups} />
        </div>
      </section>
    </div>
  );
}

function MobileMoneyMovement({ ledger }: { ledger: OvernightLedgerPayload }) {
  const value = ledger.reconciliation;
  const rows = [
    ["opening", "OPENING LIQUID", moneyDisplay(value.openingLiquid), "window-open reward bank"],
    ["payouts", "PAYOUTS OUT", value.payoutsOut.netUsdc.display == null ? "—" : `−${moneyDisplay(value.payoutsOut.netUsdc)}`, `${value.payoutsOut.count} settlements · ${value.payoutsOut.walletCount} ${value.payoutsOut.walletCount === 1 ? "wallet" : "wallets"}`],
    ["retention", "RETENTION + FEES IN", signedMoneyDisplay(value.retentionFeesIn), "worker retention + poster protocol fees"],
    ["reserved", "RESERVED Δ", signedMoneyDisplay(value.reservedDelta), "locked behind minted or claimed jobs"],
    ["closing", "CLOSING LIQUID", moneyDisplay(value.closingLiquid), "window-close reward bank"],
  ] as const;
  return (
    <div className="hm-mobile-money-ledger">
      {rows.map(([key, label, amount, note]) => (
        <div key={key} data-row={key}>
          <i aria-hidden />
          <span><strong>{label}</strong><small>{note}</small></span>
          <b data-testid={key === "closing" ? "mobile-closing-liquid" : undefined}>{amount}</b>
        </div>
      ))}
      <div className="hm-mobile-match" data-match={value.match.toLowerCase()}>
        <span><strong>{value.match}</strong>{value.match === "CONFIRMED" ? "ledger matches chain proof" : "ledger does not match chain proof"}</span>
        <small>Δ {signedMoneyDisplay(value.delta)} · {value.proofTiedCount} proofs tied</small>
      </div>
    </div>
  );
}

function MobileRewardBank({ ledger, window }: { ledger: OvernightLedgerPayload; window: OvernightWindow }) {
  const split = ledger.rewardBankSplit;
  const liquid = Number(split.liquid.display ?? 0);
  const reserved = Number(split.reserved.display ?? 0);
  const total = Math.max(0, liquid + reserved);
  const liquidPct = total > 0 ? (liquid / total) * 100 : 0;
  const reservedPct = total > 0 ? (reserved / total) * 100 : 0;
  return (
    <div className="hm-mobile-reward-bank">
      <div>
        <span><strong>REWARD BANK</strong><small>liquid-only runway</small></span>
        <b><span data-testid="mobile-runway">{formatRunway(split.runwayDays)}</span> d</b>
      </div>
      <div className="hm-mobile-split" role="meter" aria-label="Reward bank liquid and reserved split" aria-valuenow={total}>
        <i data-part="liquid" style={{ width: `${liquidPct}%` }} />
        <i data-part="reserved" style={{ width: `${reservedPct}%` }} />
      </div>
      <p>
        <span><i data-part="liquid" />liquid <b>{moneyDisplay(split.liquid)}</b></span>
        <span><i data-part="reserved" />reserved <b>{moneyDisplay(split.reserved)}</b></span>
      </p>
      <small>liquid {signedMoneyDisplay(split.liquidDelta)} · reserved {signedMoneyDisplay(split.reservedDelta)} · {window}</small>
    </div>
  );
}

function MobileTopup({
  account,
  reading,
}: {
  account: "signerGas" | "rewardBank";
  reading: RemoteFeedReading<TopupDestinationsPayload>;
}) {
  const destination = reading.state === "live" ? reading.data.topupDestinations[account] : undefined;
  return (
    <div className="hm-mobile-topup" data-testid={`mobile-topup-${account}`} data-feed-state={reading.state}>
      <strong>{account === "signerGas" ? "SIGNER GAS TOP-UP" : "REWARD BANK TOP-UP"}</strong>
      {!destination ? <ReadingState reading={reading} compact /> : (
        <>
          <div><b>SS58</b><code>{destination.ss58Address}</code><CopyButton value={destination.ss58Address} /></div>
          <p>
            send {destination.asset} · {destination.network}
            {destination.exchangeNetworkLabel ? ` · exchange network “${destination.exchangeNetworkLabel}”` : ""}
          </p>
          <p>EVM routing is account-specific; this published destination is SS58.</p>
          {destination.landsInEoa ? <p>lands in EOA · run <code>{destination.followUpCommand ?? "configured follow-up"}</code></p> : null}
        </>
      )}
    </div>
  );
}

function WorkScreen({
  health,
  ledger,
  window,
  nowMs,
}: {
  health?: ProductHealth;
  ledger: RemoteFeedReading<OvernightLedgerPayload>;
  window: OvernightWindow;
  nowMs: number;
}) {
  const funnel = flowFunnel(health?.flow);
  const evidence = payoutView(health?.flow?.payout);
  const timing = lifecycleNote(health?.lifecycle);
  const mix = volumeMixNote({
    lifecycle: health?.lifecycle,
    settledCount: health?.flow?.paidSettled24h ?? null,
    zeroPayCount: health?.flow?.zeroPaySettled24h ?? null,
  });
  const clock = disputeClockLine(health?.externalFunnel, nowMs);
  const funnelAvailable = Boolean(health?.flow) && window === "24h";
  return (
    <div className="hm-mobile-screen" data-testid="mobile-work-screen">
      <section className="hm-mobile-panel" data-feed-state={funnelAvailable ? "live" : "unavailable"}>
        <PanelHeading title={`MONEY PATH — ${window.toUpperCase()}`} state={funnelAvailable ? "live" : "unavailable"} />
        {!funnelAvailable ? (
          <FeedState
            state="unavailable"
            reason={window === "24h" ? "money path unavailable — product health has no flow reading" : `money path unavailable — product health publishes 24h only, not ${window}`}
          />
        ) : (
          <div className="hm-mobile-funnel">
            {(["claimed", "submitted", "settled"] as const).map((key) => (
              <span key={key}><small>{key}</small><strong>{funnel[key]}</strong></span>
            ))}
            <p>in-flight {funnel.inflight} · backlog {funnel.backlog} · stuck {funnel.stuck}</p>
            {mix ? <p data-tone={mix.tone}>{mix.text}</p> : null}
            {timing ? <p data-tone={timing.tone}>{timing.text}</p> : null}
            {clock ? <p data-tone={clock.tone}>⏳ {clock.text}</p> : null}
            <div className="hm-mobile-proof" data-testid="mobile-evidence">
              <p><strong data-tone={evidence.tone}>{evidence.status}</strong><span>{evidence.line1}</span></p>
              <small>{evidence.delta}</small>
              <small data-tone={evidence.fit.tone} data-testid="mobile-evidence-fit">{evidence.fit.text}</small>
            </div>
          </div>
        )}
      </section>
      <MobileWorkers reading={ledger} />
    </div>
  );
}

function MobileWorkers({ reading }: { reading: RemoteFeedReading<OvernightLedgerPayload> }) {
  return (
    <section className="hm-mobile-panel hm-mobile-workers" data-testid="mobile-workers" data-feed-state={reading.state}>
      <PanelHeading title={reading.state === "live" ? `WORKERS — ${reading.data.window.toUpperCase()}` : "WORKERS"} state={reading.state} />
      {reading.state !== "live" ? <ReadingState reading={reading} /> : reading.data.workers.items.length === 0 ? (
        <p className="hm-mobile-empty">no worker activity recorded in this window · feed is live</p>
      ) : reading.data.workers.items.map((worker) => (
        <article key={worker.wallet} className="hm-mobile-worker" data-testid="mobile-worker-row">
          <header><strong>{shortIdentifier(worker.wallet)}</strong><b>{moneyDisplay(worker.netEarned)} <small>NET</small></b></header>
          <p>{sessionSpan(worker.sessionStart, worker.sessionEnd, worker.sessionHours)} · gross {moneyDisplay(worker.grossEarned)} → net {moneyDisplay(worker.netEarned)}</p>
          <div role="table" aria-label={`Worker ${shortIdentifier(worker.wallet)}`}>
            <WorkerFact label="CLAIMS" value={String(worker.claims)} />
            <WorkerFact label="APPR" value={String(worker.approved)} />
            <WorkerFact label="REJ" value={String(worker.rejected)} />
            <WorkerFact label="WAIVER" value={`${worker.waiverSlotsUsed}/${worker.waiverSlotsTotal}`} />
            <WorkerFact label="TIER" value={tierText(worker.reputationTier, worker.tierEvents)} />
            <WorkerFact label="RETENTION" value={moneyDisplay(worker.retentionPaid)} />
          </div>
          <footer><span>balance {moneyDisplay(worker.balanceNow)}</span><span>withdrawn {moneyDisplay(worker.withdrawnInWindow)}</span></footer>
        </article>
      ))}
    </section>
  );
}

function WorkerFact({ label, value }: { label: string; value: string }) {
  return (
    <span role="row"><b role="columnheader">{label}</b><small role="cell">{value}</small></span>
  );
}

function EventsScreen({ ledger, window }: { ledger: RemoteFeedReading<OvernightLedgerPayload>; window: OvernightWindow }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const events = useMemo(() => {
    if (ledger.state !== "live") return [];
    if (filter === "all") return ledger.data.events.items;
    return ledger.data.events.items.filter((event) => event.severity === filter);
  }, [filter, ledger]);

  return (
    <div className="hm-mobile-screen" data-testid="mobile-events-screen">
      <section className="hm-mobile-panel" data-feed-state={ledger.state}>
        <PanelHeading title={`EVENTS — ${window.toUpperCase()}`} state={ledger.state} />
        <div className="hm-mobile-event-filters" role="group" aria-label="Event severity">
          {(["all", "ok", "warn", "fault"] as const).map((value) => (
            <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>
          ))}
        </div>
        {ledger.state !== "live" ? <ReadingState reading={ledger} /> : events.length === 0 ? (
          <div className="hm-mobile-empty hm-mobile-events-empty" data-testid="mobile-events-empty">
            <strong>no events in this window.</strong>
            <span>the feed is live and reachable — nothing matching {filter} was recorded in the last {window}.</span>
            <StateChip state="live" label="LIVE · 0 ROWS" />
          </div>
        ) : (
          <div className="hm-mobile-events">
            {events.slice().reverse().map((event, index) => <MobileEvent event={event} key={`${event.timestamp}:${event.type}:${index}`} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function MobileEvent({ event }: { event: OvernightEvent }) {
  const tone = event.severity === "warn" ? "warn" : event.severity === "ok" ? "live" : "loading";
  const detail = event.type.replaceAll("_", " ");
  return (
    <article className="hm-mobile-event" data-severity={tone}>
      <i aria-hidden /><span><time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time><strong>{detail}</strong></span>
      {event.wallet ? <small>{shortIdentifier(event.wallet)}</small> : null}
    </article>
  );
}

function MoreSheet({
  health,
  ledger,
  readIdentity,
  window,
  onClose,
}: {
  health?: ProductHealth;
  ledger: RemoteFeedReading<OvernightLedgerPayload>;
  readIdentity: RemoteFeedReading<MonitorReadIdentity>;
  window: OvernightWindow;
  onClose: () => void;
}) {
  const [gate, setGate] = useState<DesktopGate | null>(null);
  const identity = readIdentityView(readIdentity);
  if (gate) return <DesktopGateCard gate={gate} onBack={() => setGate(null)} />;
  return (
    <main className="hm-mobile-more" data-testid="mobile-more-sheet">
      <header><span>MORE</span><button type="button" onClick={onClose}>close ×</button></header>
      <section className="hm-mobile-panel hm-mobile-read-identity" data-feed-state={identity.state}>
        <PanelHeading title="READ IDENTITY" state={identity.state} />
        {identity.state !== "live" ? <FeedState state={identity.state} reason={identity.detail} /> : (
          <>
            <p><span>READS AS</span><strong>{identity.wallet}</strong><small>{identity.source?.replaceAll("_", " ")}</small></p>
            <ul>
              {identity.scopes.map((scope) => <li key={scope.name}>{scope.name} <b>{scope.granted ? "✓" : "—"}</b></li>)}
            </ul>
            <p data-sufficient={identity.sufficient ? "yes" : "no"}>{identity.detail}</p>
          </>
        )}
        <p className="hm-mobile-window-readonly"><span>WINDOW · GOVERNS EVERY SCREEN</span><strong>{window.toUpperCase()}</strong></p>
      </section>
      <section className="hm-mobile-panel hm-mobile-more-list">
        <h2>ON MOBILE</h2>
        <MoreRow label="PROBE GRID" detail={health ? `${health.probes.length} probes · failing cells only on phone` : "unavailable — product health not loaded"} />
        <MoreRow label="ARRIVALS / DEMAND" detail={health?.arrivals ? "available from the shared product-health reading" : "unavailable — arrivals reading absent"} />
        <MoreRow label="LLM SPEND" detail="available on desktop · secondary planning surface" />
        <MoreRow label="RETENTION & WAIVERS" detail={ledger.state === "live" ? `${moneyDisplay(ledger.data.retention.charged)} charged · ${moneyDisplay(ledger.data.retention.waived)} waived` : feedStateCopy(ledger)} />
        <MoreRow label="DEPOSIT POOL" detail={health?.depositPool ? "available from the shared product-health reading" : "unavailable — deposit-pool reading absent"} />
      </section>
      <section className="hm-mobile-panel hm-mobile-more-list">
        <h2>DESKTOP ROUTES</h2>
        {DESKTOP_GATES.map((item) => (
          <button type="button" key={item.key} onClick={() => setGate(item)}>
            <span><strong>{item.label}</strong><small>{item.shortReason}</small></span><b>DESKTOP ›</b>
          </button>
        ))}
      </section>
      <small className="hm-mobile-breakpoints">mobile &lt; 768 · tablet ≤ 1079 · desktop board unchanged ≥ 1080</small>
    </main>
  );
}

function MoreRow({ label, detail }: { label: string; detail: string }) {
  return <div><span><strong>{label}</strong><small>{detail}</small></span><b>›</b></div>;
}

interface DesktopGate {
  key: "bank-lane" | "payout-evidence" | "probe-grid";
  label: string;
  reason: string;
  shortReason: string;
  hash: string;
}

const DESKTOP_GATES: DesktopGate[] = [
  {
    key: "bank-lane",
    label: "BANK-LANE DETAIL",
    shortReason: "wide multi-lane reconciliation",
    reason: "bank-lane reconciliation compares several lanes side by side; column count, not text size, is the constraint",
    hash: "#bank-lane",
  },
  {
    key: "payout-evidence",
    label: "PAYOUT EVIDENCE TABLE",
    shortReason: "full proof rows",
    reason: "proof hashes, amounts, and timestamps exceed a phone row before truncation destroys their purpose",
    hash: "#payout-evidence",
  },
  {
    key: "probe-grid",
    label: "PROBE GRID (FULL)",
    shortReason: "wide matrix",
    reason: "a phone can show failing probes, but not the full matrix shape without turning it into a different reading",
    hash: "#probes",
  },
];

function DesktopGateCard({ gate, onBack }: { gate: DesktopGate; onBack: () => void }) {
  const href = typeof window === "undefined" ? gate.hash : `${window.location.origin}${window.location.pathname}${gate.hash}`;
  return (
    <main className="hm-mobile-gate" data-testid={`mobile-gate-${gate.key}`}>
      <header><button type="button" onClick={onBack}>‹ back</button><span>{gate.label}</span></header>
      <section className="hm-mobile-panel">
        <i aria-hidden />
        <h1>this view is built for desktop</h1>
        <p>{gate.reason}. It is not squeezed or partially rendered here on purpose.</p>
        <CopyButton value={href} label="copy link for desktop" />
        <small>opens on the board at ≥ 1080px</small>
      </section>
    </main>
  );
}

function BottomNavigation({ active, onNavigate }: { active: MobileDestination; onNavigate: (destination: MobileDestination) => void }) {
  return (
    <nav className="hm-mobile-nav" aria-label="Mobile ops screens">
      {(["status", "money", "work", "events", "more"] as const).map((item) => (
        <button
          type="button"
          role={item === "more" ? undefined : "tab"}
          key={item}
          data-active={active === item ? "yes" : "no"}
          onClick={() => onNavigate(item)}
        >
          <i aria-hidden>{item === "more" ? "☰" : ""}</i><span>{item}</span>
        </button>
      ))}
    </nav>
  );
}

function PanelHeading({ title, state }: { title: string; state: RemoteFeedState }) {
  return <header className="hm-mobile-panel-head"><h2>{title}</h2><StateChip state={state} /></header>;
}

function ReadingState({ reading, compact = false }: { reading: RemoteFeedReading<unknown>; compact?: boolean }) {
  if (reading.state === "live") return null;
  return <FeedState state={reading.state} reason={reading.reason} compact={compact} />;
}

function FeedState({ state, reason, compact = false }: { state: Exclude<RemoteFeedState, "live">; reason: string; compact?: boolean }) {
  return (
    <p className={`hm-mobile-feed-state${compact ? " hm-mobile-feed-state--compact" : ""}`} role="status" data-feed-state={state}>
      <strong>{state.toUpperCase()}</strong><span>{reason}</span>
    </p>
  );
}

function StateChip({ state, label }: { state: RemoteFeedState; label?: string }) {
  return <span className="hm-mobile-state-chip" data-feed-state={state}>{label ?? state}</span>;
}

function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  return <button type="button" className="hm-mobile-copy" onClick={() => void copyText(value)}>{label}</button>;
}

function formatRunway(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function shortIdentifier(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function tierText(tier: string | null, events: Array<{ from?: string | null; to?: string | null }>): string {
  const latest = events.at(-1);
  if (latest?.from && latest.to) return `${latest.from} → ${latest.to}`;
  return tier ?? "—";
}

function sessionSpan(start: string | null, end: string | null, hours: number): string {
  if (!start || !end) return "session span unavailable";
  return `${formatTime(start)} → ${formatTime(end)} · ${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(11, 16);
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(value);
}
