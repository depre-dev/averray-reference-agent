// The phone board — the same product as the desktop ops board, opposite medium.
//
//   status bar     what app this is, and that it is read-only
//   stale band     hatched, only when the reading is not confirmable
//   VERDICT        a solid filled field — the only filled surface in the product
//   trust strip    desktop's 4-row panel, welded under the verdict as one line
//   ── then ONE of ──
//   alert landing  the breach, then the funnel + its on-chain proof
//   check-in       floored meters, then the funnel + its on-chain proof
//   ── fold ──
//   probes         4 one-line rollups; a detail line only when not ok
//
// Two reasons to open this: an unprompted check-in, or landing from a Buzz
// alert. The check-in has to be answerable by shape and colour alone, before a
// word is read. The alert landing has to answer what the notification could not
// — how bad, since when, and whether it is still true.
//
// It is read-only, like every Hermes surface. No approve, no dismiss, no swipe
// action. An earlier phone board offered Approve on a card that could not say
// what it was approving; removing it was the fix, not softening it.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { formatAgo, formatAmount } from "../../lib/monitor/ops-model.js";
import { flowFunnel, payoutRunwayNote, payoutView, splitPools } from "../../lib/monitor/ops-spec.js";
import {
  breachCard,
  isUntrusted,
  phoneTrust,
  phoneVerdict,
  pillarRollups,
  type BreachCard,
} from "../../lib/monitor/phone-spec.js";
import { disputeClockLine, lifecycleNote } from "../../lib/monitor/ops-spec.js";

export interface MobileBoardProps {
  health?: ProductHealth;
  streamStatus?: string;
  streamDegraded?: boolean;
  nowMs?: number;
}

export function MobileBoard({
  health,
  streamStatus = "open",
  streamDegraded = false,
  nowMs = Date.now(),
}: MobileBoardProps) {
  if (!health) {
    return (
      <div className="hm-ph" data-testid="mobile-board">
        <PhoneStatusBar />
        <div className="hm-ph-empty" data-testid="mobile-loading">
          <strong>{streamDegraded ? "Health unknown" : "Loading health…"}</strong>
          <span>
            {streamDegraded
              ? "The live stream is down. Nothing on this screen is confirmed."
              : "Polling the live product heartbeat."}
          </span>
        </div>
      </div>
    );
  }

  const verdict = phoneVerdict({ health, streamDegraded, nowMs });
  const trust = phoneTrust({ health, streamDegraded, streamStatus, nowMs });
  const untrusted = isUntrusted({ health, streamDegraded, nowMs });
  const breach = breachCard({ health, streamDegraded, nowMs });

  return (
    <div className="hm-ph" data-testid="mobile-board" data-untrusted={untrusted ? "yes" : "no"}>
      <PhoneStatusBar />

      {/* Deliberately NOT the desktop's 72% dim. This screen gets read outdoors,
          and dimming every value is illegible in sunlight — so untrusted data
          keeps full contrast and is fenced by a hatched band, a re-captioned
          verdict, and explicit as-of times instead. */}
      {untrusted ? (
        <div className="hm-ph-stale" role="alert" data-testid="mobile-stale">
          <strong>{streamDegraded ? "STREAM DOWN" : "DATA STALE"}</strong>
          <span>
            {health.at == null
              ? "no confirmed reading yet"
              : `everything below is as of ${new Date(health.at).toISOString().slice(11, 19)}Z — ${formatAgo(health.at, nowMs).replace(" ago", "")} old`}
          </span>
        </div>
      ) : null}

      <div className="hm-ph-verdict" data-tone={verdict.tone} data-testid="mobile-verdict">
        <div className="hm-ph-verdict-head">
          <i aria-hidden />
          <span>{verdict.kicker}</span>
        </div>
        <h1 data-compact={verdict.compact ? "yes" : "no"}>{verdict.headline}</h1>
        {verdict.sub ? <p>{verdict.sub}</p> : null}
      </div>

      <div className="hm-ph-trust" data-tone={trust.tone} data-testid="mobile-trust">
        <i aria-hidden />
        <span>{trust.line}</span>
      </div>

      <div className="hm-ph-body">
        {breach ? <BreachPanel breach={breach} /> : <SolvencyPanel health={health} />}
        <FlowPanel health={health} emphasise={Boolean(breach)} nowMs={nowMs} />
      </div>

      <p className="hm-ph-scroll" aria-hidden>
        ▾ SCROLL FOR PROBES · INCIDENTS
      </p>

      <div className="hm-ph-below">
        <div className="hm-ph-sec">
          <h2>PROBES — 4 PILLARS</h2>
          <span>detail only when not ok</span>
        </div>
        {pillarRollups(health).map((row) => (
          <div className="hm-ph-pillar" key={row.name} data-testid={`mobile-pillar-${row.name}`}>
            <div>
              <i className="hm-ph-dot" data-tone={row.tone} aria-hidden />
              <strong>{row.name}</strong>
              <span>{row.rollup}</span>
            </div>
            {row.detail ? (
              <p data-tone={row.detailTone}>{row.detail}</p>
            ) : null}
          </div>
        ))}
        <div className="hm-ph-foot">
          <span>INCIDENTS — {incidentLine(health, untrusted)}</span>
          <span>{buildLine(health)}</span>
        </div>
      </div>
    </div>
  );
}

function PhoneStatusBar() {
  return (
    <div className="hm-ph-bar">
      <span>HERMES</span>
      <span>READ-ONLY — COMMANDS IN BUZZ</span>
    </div>
  );
}

/**
 * The alert landing's lead. Answers the three things the push notification
 * already knowing "what" leaves open.
 */
function BreachPanel({ breach }: { breach: BreachCard }) {
  return (
    <section className="hm-ph-card hm-ph-card--red" data-testid="mobile-breach">
      <header>{breach.label.toUpperCase()} — THE BREACH</header>
      <div className="hm-ph-breach">
        <div className="hm-ph-breach-top">
          <strong>{breach.amount}</strong>
          <span className="hm-ph-unit">{breach.unit}</span>
          <span className="hm-ph-short">
            {breach.short}
            <br />
            {breach.floorLabel}
          </span>
        </div>

        {/* Same meter grammar as the desktop: fixed floor-anchored scale, floor
            as a tick. Below the floor the fill sits visibly LEFT of the tick. */}
        <div className="hm-ph-meter">
          <i className="fill" data-tone="red" style={{ width: `${breach.meter.fillPct}%` }} />
          <i className="floor" style={{ left: `${breach.meter.floorPct}%` }} />
        </div>
        <div className="hm-ph-scale">
          <span style={{ left: `${breach.meter.floorPct}%` }}>floor {breach.meter.floorLabel}</span>
          <span className="at-end">{breach.meter.scaleLabel}</span>
        </div>

        <dl className="hm-ph-facts">
          <dt>SINCE</dt>
          <dd>{breach.since}</dd>
          <dt>STILL TRUE?</dt>
          <dd data-tone={breach.stillTrueTone}>{breach.stillTrue}</dd>
          <dt>IF IT EMPTIES</dt>
          <dd>{breach.consequence}</dd>
          {/* The only ACTIONABLE thing on this screen. An alert that tells you
              the signer is dry and makes you go find the address elsewhere has
              stopped short of the point. Both encodings, because the wallet on
              this phone may speak either — and converting one by hand is where
              a wrong character costs real money.

              Only ever present for a pool that IS a wallet; see TOP_UP_POOLS. */}
          {breach.topUp ? (
            <>
              <dt>TOP UP</dt>
              <dd className="hm-ph-topup" data-testid="mobile-breach-topup">
                <span className="hm-ph-addr">{breach.topUp.evm}</span>
                <span className="hm-ph-addr-tag">EVM</span>
                {breach.topUp.ss58 ? (
                  <>
                    <span className="hm-ph-addr">{breach.topUp.ss58}</span>
                    <span className="hm-ph-addr-tag">SS58 · same account</span>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

/** Check-in: the three floored meters, then every unfloored pool on ONE line. */
function SolvencyPanel({ health }: { health: ProductHealth }) {
  const { floored, unfloored } = splitPools(health.solvency?.pools ?? []);
  if (floored.length === 0 && unfloored.length === 0) {
    return <p className="hm-ph-awaiting">awaiting balances — /health has not reported pools yet</p>;
  }
  return (
    <section data-testid="mobile-solvency">
      <div className="hm-ph-sec">
        <h2>SOLVENCY — FLOORS</h2>
        <span>absolute · floor = tick</span>
      </div>

      {floored.map((view) => (
        <div className="hm-ph-pool" key={view.pool.key} data-testid={`mobile-pool-${view.pool.key}`}>
          <div className="hm-ph-pool-top">
            <strong>{view.pool.label.toUpperCase()}</strong>
            <span className="hm-ph-margin">{view.margin}</span>
            <span className="hm-ph-amount" data-tone={view.tone}>
              {view.amountLabel} <em>{view.unit}</em>
            </span>
          </div>
          <div className="hm-ph-meter hm-ph-meter--sm">
            <i className="fill" data-tone={view.tone} style={{ width: `${view.meter!.fillPct}%` }} />
            <i className="floor" style={{ left: `${view.meter!.floorPct}%` }} />
          </div>
          {/* What the balance BUYS, not just what it is.
              "12.89 USDC" is a level; "≈ 90 more payouts · signer gas ~3d to
              floor" is a countdown, and a countdown is the one thing worth
              waking up for. It was desktop-only, which is the wrong way round:
              the desk is where you can already work it out. */}
          {view.pool.key === "reward_bank"
            ? (() => {
                const runway = payoutRunwayNote({
                  pool: view.pool,
                  payout: health.flow?.payout,
                  runwayNote: health.solvency?.runwayNote,
                });
                return runway ? (
                  <p className="hm-ph-pool-note" data-tone={runway.tone} data-testid="mobile-runway">
                    <b>RUNWAY</b> {runway.text}
                  </p>
                ) : null;
              })()
            : null}
          {/* Under the balance, same as the desktop. STACKED rather than on one
              line: 100 monospace glyphs do not fit 390px, and this board scrolls
              — height is cheap here in a way it is not on the fixed desktop, so
              the addresses can be legible instead of clever. */}
          {/* Which encoding is which — and this matters MORE here than on the
              desktop. The phone is where the address gets long-pressed and
              pasted into a wallet, and the two forms are not interchangeable:
              the hex is for an EVM wallet, the SS58 for a Substrate one. Two
              unlabelled 40-character strings is the setup for pasting the
              wrong one while standing somewhere with a phone in one hand. */}
          {view.pool.address ? (
            <div className="hm-ph-pool-addr" data-testid={`mobile-pool-addr-${view.pool.key}`}>
              <span>
                <b>EVM</b> {view.pool.address}
              </span>
              {view.pool.addressSs58 ? (
                <span>
                  <b>SS58</b> {view.pool.addressSs58}
                </span>
              ) : (
                <em>SS58 unavailable</em>
              )}
              {view.pool.addressLabel ? <em>{view.pool.addressLabel}</em> : null}
            </div>
          ) : null}
        </div>
      ))}

      {/* On desktop "a meter needs a scale" means these pools get no BAR. On a
          phone the same rule costs them their rows: one grey line, because
          vertical space here is the scarcest thing on the board. */}
      {unfloored.length > 0 ? (
        <p className="hm-ph-unfloored" data-testid="mobile-unfloored">
          no floor, no meter —{" "}
          {unfloored
            .map((v) => `${v.pool.label.toLowerCase()} ${v.amountLabel}${v.pool.note ? " (intentional)" : ""}`)
            .join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The funnel and its on-chain proof, in ONE bordered card.
 *
 * They are never split — not across the fold and not across the two screens.
 * The whole point of the evidence row is that it can contradict the funnel, and
 * a contradiction the operator has to scroll between is one they will miss.
 */
function FlowPanel({ health, emphasise, nowMs }: { health: ProductHealth; emphasise: boolean; nowMs: number }) {
  const funnel = flowFunnel(health.flow);
  const evidence = payoutView(health.flow?.payout);
  const timing = lifecycleNote(health.lifecycle);
  const clock = disputeClockLine(health.externalFunnel, nowMs);
  return (
    <section
      className={`hm-ph-card${evidence.emphasised || emphasise ? " hm-ph-card--red" : ""}`}
      data-testid="mobile-flow"
    >
      <header>FLOW · 24 H + ON-CHAIN PROOF</header>
      <div className="hm-ph-funnel">
        <span className="hm-ph-funnel-counts">
          {funnel.claimed} → {funnel.submitted} → <b>{funnel.settled}</b> settled
        </span>
        {funnel.backlog !== "0" && funnel.backlog !== "—" ? (
          <span data-tone={funnel.backlogTone}>backlog {funnel.backlog}</span>
        ) : null}
        <span className="hm-ph-quiet">
          stuck {funnel.stuck} · failed {funnel.failed}
        </span>
        {/* Same facts as the desktop flow panel: how long the funnel above
            actually takes, split by who posted the work, plus the dispute clock
            when a bond is counting down. The phone is where this is read when
            away from the desk, so it must not be desktop-only. */}
        {timing ? (
          <span className="hm-ph-quiet" data-tone={timing.tone} data-testid="mobile-lifecycle">
            {timing.text}
          </span>
        ) : null}
        {clock ? (
          <span data-tone={clock.tone} data-testid="mobile-dispute-clock">
            ⏳ {clock.text}
          </span>
        ) : null}
      </div>
      <div className="hm-ph-proof" data-testid="mobile-evidence">
        <div>
          <i className="hm-ph-sq" data-tone={evidence.tone} aria-hidden />
          <strong data-tone={evidence.tone}>{evidence.status}</strong>
          <span className="hm-ph-quiet">{evidence.line1}</span>
        </div>
        <p>{evidence.delta}</p>
        {/* Whether to believe the line above. The phone is where a SHORTFALL is
            read at 2am, away from any way to check it — which makes this the
            surface that needs it most, not least. */}
        <p className="hm-ph-fit" data-tone={evidence.fit.tone} data-testid="mobile-evidence-fit">
          {evidence.fit.text}
        </p>
      </div>
    </section>
  );
}

function incidentLine(health: ProductHealth, untrusted: boolean): string {
  if (untrusted) return "log frozen while the stream is down";
  const list = health.history?.incidents ?? [];
  if (list.length === 0) return "none recorded";
  const ongoing = list.filter((i) => i.endedAt == null);
  return ongoing.length > 0 ? `${ongoing.length} ongoing` : `${list.length} in window`;
}

function buildLine(health: ProductHealth): string {
  const self = health.self;
  if (!self) return "build unknown";
  const sha = self.runningSha ? self.runningSha.slice(0, 8) : "sha ?";
  return self.status === "current"
    ? `build ${sha} · current`
    : self.status === "behind"
      ? `build ${sha} · ${self.behindBy ?? "?"} behind`
      : `build ${sha} · unknown`;
}

// Kept for the existing money-card test surface; both are now derived from the
// shared ops-spec pool split rather than a phone-local meter rule.
export { formatAmount };
