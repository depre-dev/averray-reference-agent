// The ops board — one read-only screen, laid out by priority.
//
//   meta line      what you are looking at, and when it last refreshed
//   stale banner   only when the data is untrustworthy (hatched, overrides all)
//   VERDICT        the one oversized element · TRUST panel beside it
//   SOLVENCY       pools vs floors      │  FLOW  funnel + welded payout evidence
//   PILLARS        the 8 probes, grouped, with their details
//   footer         incidents · LLM spend · "refresh is the only control"
//
// Size follows priority, not chronology: the verdict is the only thing sized to
// be read across a room, the money owns the middle band, the probe details sit
// under it, and the least urgent number on the board — LLM spend — is one line
// in the footer rather than the tall column it used to be.
//
// There are no controls here beyond Refresh. Commands and discussion live in
// Buzz (docs/OPS_ONLY_PIVOT.md).

import { opsSuggestions } from "../../lib/monitor/ops-suggestions.js";
import type { MonitorBoard } from "../../lib/monitor/board-cache.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { formatAgo, incidentRows } from "../../lib/monitor/ops-model.js";
import { economicsLine } from "../../lib/monitor/ops-spec.js";
import { opsVerdict, staleAfterMs, trustRows } from "../../lib/monitor/ops-spec.js";
import { FlowPanel } from "./FlowPanel.js";
import { PillarStrip } from "./PillarStrip.js";
import { SolvencyPanel } from "./SolvencyPanel.js";
import { BankLane } from "./BankLane.js";

export interface OpsBoardProps {
  health: ProductHealth;
  /** The monitor snapshot — only its clock and LLM usage are read. */
  board?: MonitorBoard | undefined;
  /** SSE transport state. A stream we cannot trust invalidates the screen. */
  streamStatus?: string;
  streamDegraded?: boolean;
  onRefresh?: (() => void) | undefined;
  /** Injected clock so every age label is deterministic to test. */
  nowMs?: number;
}

export function OpsBoard({
  health,
  board,
  streamStatus = "open",
  streamDegraded = false,
  onRefresh,
  nowMs = Date.now(),
}: OpsBoardProps) {
  const verdict = opsVerdict({ health, streamDegraded, nowMs });
  const trust = trustRows({ health, streamDegraded, streamStatus, streamAt: board?.at, nowMs });
  const ageMs = health.at == null ? null : Math.max(0, nowMs - health.at);
  const dataStale = ageMs != null && ageMs > staleAfterMs(health);
  // "Untrusted" is broader than "disconnected": a stream that is nominally open
  // but has not delivered a check in minutes is equally unsafe to read calmly.
  const untrusted = streamDegraded || dataStale;

  return (
    <div className="ops-board" data-testid="ops-board" data-untrusted={untrusted ? "yes" : "no"}>
      <div className="ops-meta">
        <span>{metaLine(health)}</span>
        <span>
          {health.at == null
            ? "no check yet"
            : `${untrusted ? "last successful refresh" : "last refresh"} ${formatAgo(health.at, nowMs)}`}
          {onRefresh ? (
            <>
              {" · "}
              <button type="button" className="ops-refresh" onClick={onRefresh}>
                refresh
              </button>
            </>
          ) : null}
        </span>
      </div>

      {/* The banner must claim exactly the fault that exists. A dead stream and
          stale data are different failures and can occur separately: with the
          stream down but the last check a couple of minutes old, "every value
          below is STALE" contradicted the trust panel's own "4m ago — fresh"
          two lines to the right. Frozen is not the same as wrong. */}
      {untrusted ? (
        <div className="ops-stale" role="alert" data-testid="ops-stale-banner">
          <strong>{streamDegraded ? "STREAM DISCONNECTED" : "DATA STALE"}</strong>
          <span>{staleBannerDetail({ health, nowMs, streamDegraded, dataStale })}</span>
          <span className="ops-stale-right">{streamDegraded ? `reconnecting · ${streamStatus}` : "poll failing"}</span>
        </div>
      ) : null}

      {/* Everything below dims while untrusted: stale data must LOOK stale, not
          merely be labelled stale somewhere above it. */}
      <div className="ops-content" data-dim={untrusted ? "yes" : "no"}>
        <div className="ops-verdict-row">
          <div className="ops-verdict">
            <div className="ops-verdict-kicker" data-tone={verdict.kickerTone}>
              {verdict.kicker}
            </div>
            <h1 className="ops-verdict-line" data-tone={verdict.verdictTone} data-testid="ops-verdict">
              {verdict.verdict}
            </h1>
            <p className="ops-verdict-sub" data-tone={verdict.subTone}>
              {verdict.sub}
            </p>
          </div>

          <div className="ops-trust" data-testid="ops-trust">
            {trust.map((row) => (
              <div className="ops-trust-row" key={row.key}>
                <span className="ops-trust-key">{row.key}</span>
                <span className="ops-trust-val">
                  <i className="ops-dot ops-dot--sm" data-tone={row.tone} aria-hidden />
                  <span data-tone={row.tone}>{row.value}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="ops-money">
          <SolvencyPanel solvency={health.solvency} gas={health.gas} payout={health.flow?.payout} />
          <FlowPanel flow={health.flow} externalFunnel={health.externalFunnel} lifecycle={health.lifecycle} nowMs={nowMs} />
        </div>

        {/* The treasury's own money path, under the one that pays workers.
            Renders nothing at all when no feed is configured. */}
        <BankLane bank={health.bank} />

        <PillarStrip probes={health.probes} history={health.history} />

        {/* Only the per-job economics keeps a row of its own. Gas and payout
            runway now sit under the pools they describe, and the dispute clock
            in the flow panel — each fact beside its subject rather than in a
            strip of prose at the bottom that nobody could read. */}
        {(() => {
          const e = economicsLine({ payout: health.flow?.payout, gas: health.gas });
          return e ? (
            <div className="ops-economics" data-tone={e.tone} title={e.title}>
              {e.text}
            </div>
          ) : null;
        })()}

        {/* ── NEXT ────────────────────────────────────────────────────────
            The board says WHAT is wrong in eleven places and never once said
            what to DO. `opsSuggestions` has derived probe-cited, pre-drafted
            remediations for eight incident types since 2026-07; until now it
            was imported by NOTHING — it was wired to the co-pilot board the
            ops-only pivot replaced, and the content simply stopped reaching a
            person. The fourth instance in one day of this system discarding
            words it had already written.

            TEXT ONLY. Each suggestion carries a `task` the operator could
            approve, and this board is read-only by design — "refresh is the
            only control" is one line below. Rendering the button here would
            break that promise; the sentence is the whole value anyway.

            NOTHING WHEN THERE IS NOTHING. An all-clear board shows no NEXT
            strip rather than a reassuring empty box. */}
        {(() => {
          const next = opsSuggestions(health).slice(0, 3);
          if (next.length === 0) return null;
          return (
            <div className="ops-next" data-testid="ops-next">
              <span className="ops-next-key">NEXT</span>
              <ul>
                {next.map((s) => (
                  <li key={s.id} data-tone={s.tone} data-testid={`ops-next-${s.id}`}>
                    {s.text}
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        <div className="ops-foot">
          <span>INCIDENTS — {incidentSummary(health, nowMs)}</span>
          <span>{llmSummary(board)}</span>
          <span>refresh is the only control · everything else is read-only</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Say which thing is actually broken.
 *
 * Three distinct cases, and collapsing them into one sentence produced a banner
 * that argued with the trust panel beside it:
 *   · never checked  — nothing is confirmed, and nothing is stale either
 *   · stream down, reading still recent — FROZEN, not wrong. It was true when
 *     it was taken and it will not move until the stream returns
 *   · genuinely old   — stale, and may no longer describe the product
 */
function staleBannerDetail(input: {
  health: ProductHealth;
  nowMs: number;
  streamDegraded: boolean;
  dataStale: boolean;
}): string {
  const { health, nowMs, streamDegraded, dataStale } = input;
  if (health.at == null) return "no successful check yet — nothing below is confirmed";
  const age = formatAgo(health.at, nowMs);
  if (dataStale) return `last update ${age} — every value below is STALE and may be wrong`;
  if (streamDegraded) {
    return `last update ${age} — values below are FROZEN at that reading and will not update until the stream returns`;
  }
  return `last update ${age}`;
}

function metaLine(health: ProductHealth): string {
  const net = health.network && health.network !== "unknown" ? health.network.toUpperCase() : "NETWORK UNKNOWN";
  const chain = typeof health.chainId === "number" ? `CHAIN ${health.chainId}` : "CHAIN UNKNOWN";
  return `HERMES · AVERRAY ${net} · ${chain} · READ-ONLY — COMMANDS LIVE IN BUZZ`;
}

/** Ongoing incidents lead; an empty durable log says so rather than "all clear". */
function incidentSummary(health: ProductHealth, nowMs: number): string {
  const rows = incidentRows(health.history, nowMs);
  if (rows.length === 0) return "none recorded in this window";
  const ongoing = rows.filter((r) => r.ongoing);
  if (ongoing.length > 0) {
    const lead = ongoing[0]!;
    return `${ongoing.length} ongoing · ${lead.probe} ${lead.severity} for ${lead.durationLabel}`;
  }
  const lead = rows[0]!;
  return `${rows.length} in window · latest ${lead.probe} ${lead.severity}, ${lead.durationLabel}`;
}

/**
 * The least urgent number on the board, in one line.
 *
 * `monthlyTotalComplete: false` means shared plans are deliberately excluded
 * from the figure, so the line says so — a total that quietly omits some of its
 * inputs is a wrong number, however small.
 */
function llmSummary(board: MonitorBoard | undefined): string {
  const billing = board?.llmUsage?.billing;
  if (!billing) return "LLM SPEND — not recorded";
  const total = billing.monthlyTotalUsd;
  if (total == null) return "LLM SPEND — cost not recorded by any provider";
  const excluded = (billing.subscriptions ?? []).filter((s) => s.configured && !s.dedicated).length;
  const tail = billing.monthlyTotalComplete
    ? "complete"
    : excluded > 0
      ? `${excluded} shared plan${excluded === 1 ? "" : "s"} excluded from total`
      : "partial — some costs unrecorded";
  return `LLM SPEND ≈ $${total.toFixed(2)} this month · ${tail}`;
}
