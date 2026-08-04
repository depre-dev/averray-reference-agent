// BANK — the treasury's position at the venue, and the requests moving it.
//
// A second money path, next to the one the FLOW panel watches. That one pays
// workers; this one parks the treasury's own USDC at Hydration and brings it
// home. It has its own instruments and its own ways of lying, so it gets its
// own strip rather than being folded into SOLVENCY.
//
// ── THE LINES ARE DECIDED SERVER-SIDE ─────────────────────────────────────
//
// Every string here arrives already rendered, beside the data that produced
// it. This component chooses layout and tone and nothing else. A board that
// re-derived these would be a second opinion on money, and two opinions is how
// an operator learns to trust neither — the same rule that keeps the ops
// verdict in one place.
//
// ── ABSENT IS NOT BROKEN, AND NOT AN EMPTY LANE ───────────────────────────
//
// No `bank` block at all means no feed was ever configured. That renders
// NOTHING: a lane nobody wired must not occupy the board with four "awaiting"
// tiles nor complain about its own absence. Only `unavailable` — a configured
// feed that failed — is worth a line.

import type { BankBlock } from "../../lib/monitor/product-health.js";

export interface BankLaneProps {
  bank: BankBlock | undefined;
}

export function BankLane({ bank }: BankLaneProps) {
  if (!bank) return null; // never wired — say nothing at all
  if (!bank.lane) {
    return (
      <p className="ops-bank-absent" data-tone="awaiting" data-testid="ops-bank-absent">
        BANK — {bank.unavailable ?? "lane unavailable"}
      </p>
    );
  }

  const { lane } = bank;
  return (
    <section className="ops-bank" data-tone={lane.tone} aria-label="Bank — venue position" data-testid="ops-bank">
      <div className="ops-bank-head">
        <h2 className="ops-bank-title">BANK — HYDRATION USDC</h2>
        {/* The alarm, hoisted so it is legible before any row is read. An
            overdue request is the one state here where doing nothing costs
            money, exactly like the dispute clock in FLOW. */}
        {lane.overdueRequestId ? (
          <span className="ops-bank-alarm" data-tone="red" data-testid="ops-bank-alarm">
            ⏳ {lane.overdueRequestId} OVERDUE
          </span>
        ) : null}
      </div>

      {/* WHAT these readings are about, above every number rather than beside
          one. On 2026-08-04 this lane showed four fresh, correctly-sourced,
          green tiles describing a wrapper retired that morning; a reader who
          took in the float and stopped had still read the wrong thing. */}
      {lane.subject ? (
        <p className="ops-bank-subject" data-tone={lane.subject.tone} data-testid="ops-bank-subject">
          {lane.subject.text}
        </p>
      ) : null}

      <dl className="ops-bank-rows">
        {/* POSITION carries a status word rather than only a number, because
            "unverified" is a real state here: a zero from a read path that has
            never seen funds is not evidence of an empty position. */}
        <div className="ops-bank-row" data-testid="ops-bank-position">
          <dt>POSITION</dt>
          <dd data-tone={positionTone(lane.position?.status)}>
            {lane.position
              ? lane.position.status === "unverified"
                ? `UNVERIFIED — ${lane.position.detail}`
                : `${lane.position.raw} raw · ${lane.position.detail}`
              : "not reported"}
          </dd>
        </div>
        <Row label="FLOAT" line={lane.float} testId="ops-bank-float" />
        <Row label="POSTAGE" line={lane.postage} testId="ops-bank-postage" />
        <Row label="REQUESTS" line={lane.requests} testId="ops-bank-requests" />
      </dl>
    </section>
  );
}

function Row({ label, line, testId }: { label: string; line: { text: string; tone: string }; testId: string }) {
  return (
    <div className="ops-bank-row" data-testid={testId}>
      <dt>{label}</dt>
      <dd data-tone={line.tone}>{line.text}</dd>
    </div>
  );
}

/**
 * `unverified` is warm grey, never coral.
 *
 * It means the instrument cannot vouch for itself — not that the money is
 * gone. Paging on a blind instrument is the false red that teaches an operator
 * to ignore the real one, and this board has removed that mistake twice
 * already.
 */
function positionTone(status: string | undefined): string {
  if (status === "funded") return "ok";
  if (status === "empty") return "ok";
  return "awaiting";
}
