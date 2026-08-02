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

import {
  EVIDENCE_KEY,
  flowFunnel,
  payoutView,
  type FunnelView,
} from "../../lib/monitor/ops-spec.js";
import type { MoneyPathSnapshot } from "../../lib/monitor/product-health.js";
import { disputeClockLine, lifecycleNote } from "../../lib/monitor/ops-spec.js";
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
  const funnel = flowFunnel(flow);
  const evidence = payoutView(flow?.payout);

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

      {timing ? (
        <p className="ops-lifecycle" data-tone={timing.tone} data-testid="ops-lifecycle">
          {timing.text}
        </p>
      ) : null}

      {clock ? (
        <p className="ops-dispute-clock" data-tone={clock.tone} data-testid="ops-dispute-clock">
          ⏳ {clock.text}
        </p>
      ) : null}

      <Funnel funnel={funnel} />

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
            <div className="ops-evidence-fit" data-tone={evidence.fit.tone} data-testid="ops-evidence-fit">
              {evidence.fit.text}
            </div>
          </div>
          <div className="ops-evidence-delta" data-tone={evidence.tone}>
            {evidence.delta}
          </div>
        </div>

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

function Funnel({ funnel }: { funnel: FunnelView }) {
  return (
    <div className="ops-funnel">
      <Stage label="CLAIMED" value={funnel.claimed} />
      <Gap label={`in-flight ${funnel.inflight} · normal WIP`} tone="awaiting" />
      <Stage label="SUBMITTED" value={funnel.submitted} />
      <Gap label={`backlog ${funnel.backlog} · real payout backlog`} tone={funnel.backlogTone} />
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

function Gap({ label, tone }: { label: string; tone: string }) {
  return (
    <div className="ops-funnel-gap">
      <span className="ops-funnel-arrow" aria-hidden>
        <i />▸
      </span>
      <span className="ops-funnel-gap-label" data-tone={tone}>
        {label}
      </span>
    </div>
  );
}
