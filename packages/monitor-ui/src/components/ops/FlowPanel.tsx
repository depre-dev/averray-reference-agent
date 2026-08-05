// FLOW — the money path, and the independent proof underneath it.
//
// The funnel (claimed → submitted → settled) is the product's own ledger. The
// evidence row below it is the CHAIN. They are welded together on purpose:
// when they disagree, the board shows both numbers and names the gap, instead
// of averaging them into one reassuring figure.
//
// That disagreement is the whole reason the evidence row exists. A funnel can
// read a clean 9 → 9 → 9 while only 7 of those payouts ever landed on-chain,
// and nothing else on this board can see the difference.

import { OPS_GLOSS } from "../../lib/monitor/ops-gloss.js";
import {
  EVIDENCE_KEY,
  flowFunnel,
  payoutView,
  type FunnelView,
} from "../../lib/monitor/ops-spec.js";
import type { MoneyPathSnapshot } from "../../lib/monitor/product-health.js";
import {
  crossCheckLine,
  disputeClockLine,
  lifecycleNote,
  payoutProvenanceLine,
  settledByHourReason,
  settledByHourView,
  volumeMixNote,
} from "../../lib/monitor/ops-spec.js";
import type { ExternalFunnelView, LifecycleView } from "../../lib/monitor/product-health.js";

export interface FlowPanelProps {
  flow: MoneyPathSnapshot | undefined;
  /** External funnel counts — drives the dispute clock. */
  externalFunnel?: ExternalFunnelView | undefined;
  /** Job durations + demand mix, shown under the funnel they describe. */
  lifecycle?: LifecycleView | undefined;
  nowMs?: number;
}

export function FlowPanel({ flow, externalFunnel, lifecycle, nowMs }: FlowPanelProps) {
  // The one clock on this board where doing nothing costs money. Rendered only
  // while it is running; absence is correct, not a missing feature.
  const clock = disputeClockLine(externalFunnel, nowMs ?? Date.now());
  // How long the funnel above actually takes, split by who posted the work.
  const timing = lifecycleNote(lifecycle);
  // Reconciled against the LEDGER's settled count, not against itself — the
  // split is read from the chain and the total from the product, and where
  // they disagree that gap is the information.
  const mix = volumeMixNote({ lifecycle, settledCount: flow?.settled24h ?? null });
  const funnel = flowFunnel(flow);
  const evidence = payoutView(flow?.payout);
  const provenance = payoutProvenanceLine(flow?.payout);
  const cross = crossCheckLine(flow?.payout, nowMs ?? Date.now());

  return (
    <section className="ops-flow" aria-label="Flow — money path over 24 hours" data-testid="ops-flow">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">FLOW — MONEY PATH · 24 H</h2>
        <span className="ops-chip" data-tone={funnel.stuck !== "0" && funnel.stuck !== "—" ? "degraded" : "awaiting"}>
          stuck {funnel.stuck}
        </span>
        <span className="ops-chip" data-tone={funnel.failed !== "0" && funnel.failed !== "—" ? "red" : "awaiting"}>
          failed {funnel.failed}
        </span>
        <span className="ops-panel-note" data-tone={evidence.emphasised ? "degraded" : "awaiting"}>
          {evidence.emphasised
            ? "funnel reads clean — evidence below disagrees"
            : "gaps between stages are the signal"}
        </span>
      </header>

      {/* Who posted the work, beside the count of it. "18 settled" is honest
          and unexplained, and volume Averray posted to itself reads as demand
          to anyone who does not already know better — including a future
          reader of a screenshot. */}
      {mix ? (
        <p
          className="ops-volume-mix"
          data-tone={mix.tone}
          data-testid="ops-volume-mix"
          title={mix.text.includes("beyond the ledger window") ? OPS_GLOSS.beyondWindow : undefined}
        >
          {mix.text}
        </p>
      ) : null}

      {timing ? (
        <p className="ops-lifecycle" data-tone={timing.tone} data-testid="ops-lifecycle" title={OPS_GLOSS.selfPosted}>
          {timing.text}
        </p>
      ) : null}

      {clock ? (
        <p className="ops-dispute-clock" data-tone={clock.tone} data-testid="ops-dispute-clock">
          ⏳ {clock.text}
        </p>
      ) : null}

      <Funnel funnel={funnel} />

      <SettledByHour payout={flow?.payout} />

      <div className="ops-evidence" data-emphasis={evidence.emphasised ? "on" : "off"} data-testid="ops-evidence">
        <div className="ops-evidence-head">
          <h3>PAYOUT EVIDENCE — INDEPENDENT ON-CHAIN PROOF</h3>
          <span>↑ corroborates the funnel above</span>
        </div>

        <div className="ops-evidence-body">
          <span className="ops-evidence-status" data-tone={evidence.tone} data-testid="ops-evidence-status">
            {evidence.status}
          </span>
          <div className="ops-evidence-lines">
            <div>{evidence.line1}</div>
            <div>{evidence.line2}</div>
            {/* Whether the two counts above cover the same period. Always
                present — this board once showed SHORTFALL −2 with no window
                information at all, which is an accusation without the one
                fact that decides whether to believe it. */}
            <div
              className="ops-evidence-fit"
              data-tone={evidence.fit.tone}
              data-testid="ops-evidence-fit"
              title={OPS_GLOSS.windowFit}
            >
              {evidence.fit.text}
            </div>
          </div>
          <div className="ops-evidence-delta" data-tone={evidence.tone}>
            {evidence.delta}
          </div>
        </div>

        {/* Where this proof came from, and whether anyone else can see the
            same thing. "Independent" has meant "whatever RPC we were pointed
            at" — proof without provenance is one endpoint's opinion. */}
        {provenance || cross ? (
          <div className="ops-evidence-provenance" data-testid="ops-evidence-provenance">
            {provenance ? <span className="ops-evidence-source">{provenance}</span> : null}
            {cross ? (
              <span data-tone={cross.tone} data-testid="ops-evidence-crosscheck">
                {cross.text}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Permanent key. "we cannot see" and "we can see, and it is short" are
            different facts, and the operator should never have to remember
            which colour meant which. */}
        <div className="ops-evidence-key">
          {EVIDENCE_KEY.map((entry) => (
            <span key={entry.text}>
              <i data-tone={entry.tone} aria-hidden />
              {entry.text}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Throughput by hour — and whose number it is.
 *
 * Titled "CONFIRMED ON-CHAIN BY HOUR", never "settled": these bars are built
 * from the settlement LOGS, the same independent read as the evidence block
 * below. A row drawn from the funnel's own count would agree with the funnel
 * by construction and could never show the thing worth looking at.
 *
 * When it cannot be sliced — no measured block time, no block range read — it
 * says why in a sentence. It never draws a flat row of zeroes, which looks
 * exactly like a day on which nothing paid out.
 */
function SettledByHour({ payout }: { payout: MoneyPathSnapshot["payout"] | undefined }) {
  const view = settledByHourView(payout);
  if (!view) {
    const reason = settledByHourReason(payout);
    if (!reason) return null; // older payload: say nothing rather than invent a fault
    return (
      <p className="ops-byhour-absent" data-testid="ops-byhour-absent">
        hourly throughput unavailable — {reason}
      </p>
    );
  }
  return (
    <div className="ops-byhour" data-testid="ops-byhour">
      <div className="ops-byhour-head">
        <span className="ops-byhour-title">CONFIRMED ON-CHAIN BY HOUR</span>
        <span className="ops-byhour-caption">{view.caption}</span>
        {view.gapNote ? (
          <span className="ops-byhour-gap" data-tone="degraded" data-testid="ops-byhour-gap">
            {view.gapNote}
          </span>
        ) : null}
      </div>
      <div className="ops-byhour-bars" role="img" aria-label={`Confirmed payouts by hour. ${view.caption}`}>
        {view.bars.map((bar) => (
          <i
            key={bar.hoursAgo}
            className="ops-byhour-bar"
            data-covered={bar.covered ? "yes" : "no"}
            style={{ height: `${bar.heightPct}%` }}
            title={bar.title}
          />
        ))}
      </div>
      <div className="ops-byhour-axis" aria-hidden>
        <span>−{view.bars.length}h</span>
        <span>now</span>
      </div>
    </div>
  );
}

function Funnel({ funnel }: { funnel: FunnelView }) {
  return (
    <div className="ops-funnel">
      <Stage label="CLAIMED" value={funnel.claimed} />
      <Gap label={`in-flight ${funnel.inflight} · normal WIP`} tone="awaiting" title={OPS_GLOSS.inflight} />
      <Stage label="SUBMITTED" value={funnel.submitted} />
      <Gap label={`backlog ${funnel.backlog} · real payout backlog`} tone={funnel.backlogTone} title={OPS_GLOSS.backlog} />
      <Stage label="SETTLED" value={funnel.settled} />
    </div>
  );
}

function Stage({ label, value }: { label: string; value: string }) {
  return (
    <div className="ops-funnel-stage">
      <span className="ops-funnel-label">{label}</span>
      {/* "—" not "0": an unreported count is not a count of nothing. */}
      <span className="ops-funnel-value" data-tone={value === "—" ? "awaiting" : "ok"}>
        {value}
      </span>
    </div>
  );
}

function Gap({ label, tone, title }: { label: string; tone: string; title?: string }) {
  return (
    <div className="ops-funnel-gap" title={title}>
      <span className="ops-funnel-arrow" aria-hidden>
        <i />▸
      </span>
      <span className="ops-funnel-gap-label" data-tone={tone}>
        {label}
      </span>
    </div>
  );
}
