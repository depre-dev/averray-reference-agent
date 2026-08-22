// The ops board — one read-only screen, laid out by priority.
//
//   meta line      what you are looking at, and when it last refreshed
//   stale banner   only when the data is untrustworthy (hatched, overrides all)
//   VERDICT        the one oversized element · TRUST panel beside it
//   WORKER MONEY   SOLVENCY │ FLOW + proof, closed by per-job economics
//   BANK           venue position │ deposit pool, separate instruments
//   PILLARS        the 8 probes, grouped, with their details
//   NEXT           what to do; the fault line below which nothing is red
//   OUTSIDE        both public arrival doors, condensed but not combined
//   footer         incidents · LLM spend · read-only boundary
//
// Size follows priority, not chronology: the verdict is the only thing sized to
// be read across a room, the money owns the middle band, the probe details sit
// under it, and the least urgent number on the board — LLM spend — is one line
// in the footer rather than the tall column it used to be.
//
// There are no operational controls here beyond Refresh. The arrivals window
// selector changes only the read projection; commands and discussion live in
// Buzz (docs/OPS_ONLY_PIVOT.md).

import { opsSuggestions } from "../../lib/monitor/ops-suggestions.js";
import type { MonitorBoard } from "../../lib/monitor/board-cache.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";
import type { AdminDemandFeed, AdminDemandWindow } from "../../lib/monitor/admin-demand.js";
import { formatAgo, incidentRows, probeOpsTone } from "../../lib/monitor/ops-model.js";
import { boardKpis, economicsLine } from "../../lib/monitor/ops-spec.js";
import { outsiderPresence, type OutsiderBand } from "../../lib/monitor/arrivals-view.js";
import { opsVerdict, staleAfterMs, trustRows } from "../../lib/monitor/ops-spec.js";
import { FlowPanel } from "./FlowPanel.js";
import { PillarStrip } from "./PillarStrip.js";
import { SolvencyPanel } from "./SolvencyPanel.js";
import { BankLane } from "./BankLane.js";
import { ArrivalsPanel } from "./ArrivalsPanel.js";
import { AdminDemandPanel } from "./AdminDemandPanel.js";
import { DepositPoolTile } from "./DepositPoolTile.js";

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
  adminDemand?: AdminDemandFeed;
  adminDemandWindow?: AdminDemandWindow;
  adminDemandLoading?: boolean;
  adminDemandError?: unknown;
  onAdminDemandWindowChange?: (window: AdminDemandWindow) => void;
}

export function OpsBoard({
  health,
  board,
  streamStatus = "open",
  streamDegraded = false,
  onRefresh,
  nowMs = Date.now(),
  adminDemand,
  adminDemandWindow = "48h",
  adminDemandLoading = false,
  adminDemandError,
  onAdminDemandWindowChange = () => undefined,
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
        {/* The brand row. The mark and name are chrome; the string beside them
            is the same network / chain / read-only line the board always
            carried, unchanged. */}
        <span className="ops-brand">
          <span className="ops-brand-mark" aria-hidden>A</span>
          <span>
            <span className="ops-brand-name">Hermes</span>
            <span className="ops-brand-sub">Averray ops</span>
          </span>
        </span>
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
        {/* The slab's own wash follows the verdict it carries — a coral
            headline over a sage-tinted ground is a mixed signal at exactly
            the distance this element exists to be read from. It is the SAME
            tone the headline already uses; nothing new is decided here. */}
        <div className="ops-verdict-row" data-verdict={verdict.verdictTone}>
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
            {/* The census, as marks: one cell per probe, severity carried by
                BOTH colour and height (amber and coral are near-identical to
                deutan vision, so colour alone must never be the split). The
                words above stay the record; this row is the same fact made
                legible from across a room. Absent probes draw nothing —
                an empty strip would read as "no probes are red". */}
            {health.probes.length > 0 ? (
              <div
                className="ops-census"
                data-testid="ops-census"
                role="img"
                aria-label={`probe census: ${verdict.sub}`}
              >
                {health.probes.map((p) => (
                  <i
                    key={p.name}
                    data-tone={probeOpsTone(p)}
                    title={`${p.name} — ${p.status}`}
                  />
                ))}
              </div>
            ) : null}
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

        {/* ── KPI STRIP ────────────────────────────────────────────────
            The four figures an operator checks first, sized to be read
            before any panel is. Every one is quoted from the view-model
            the panel below renders (`boardKpis`), so the strip is a
            second READING and never a second opinion — and an
            unreported figure is a dash with its reason, not a zero. */}
        <div className="ops-kpis" data-testid="ops-kpis">
          {boardKpis(health, health.gas).map((kpi) => (
            <div className="ops-kpi" key={kpi.key} data-testid={`ops-kpi-${kpi.key}`}>
              <span className="ops-kpi-lbl">{kpi.label}</span>
              <span className="ops-kpi-val">
                {kpi.value}
                {kpi.unit ? <span className="ops-kpi-unit">{kpi.unit}</span> : null}
              </span>
              <span className="ops-kpi-sub" data-tone={kpi.tone}>
                {kpi.sub}
              </span>
            </div>
          ))}
        </div>

        {/* ── OUTSIDE ──────────────────────────────────────────────────
            Someone who is not us is at the door, and how far in they got.

            THE FAULT LINE STILL HOLDS. The full ARRIVALS panel stays below
            everything that can page an operator — demand is a business
            outcome and must never be recast as a money fault. What sits here
            is a PRESENCE line, and it is deliberately built out of the
            board's neutral ink rather than its status palette: it cannot be
            mistaken for a probe, because nothing on it is ever sage or coral.

            It earns the position because it is the one thing on this board
            nobody else reports. Every panel above answers "is our money
            safe"; this answers "is anyone out there", and an outsider who
            reached `submitted` while the operator was looking at gas is the
            single most consequential thing that can happen on a quiet day. */}
        <OutsidePresence arrivals={health.arrivals} nowMs={nowMs} />

        <div className="ops-money">
          <SolvencyPanel solvency={health.solvency} gas={health.gas} payout={health.flow?.payout} />
          <FlowPanel flow={health.flow} externalFunnel={health.externalFunnel} lifecycle={health.lifecycle} nowMs={nowMs} />

          {/* Per-job economics closes the worker-payment band because it
              describes that path. It keeps its own line and tone and refuses
              to become either a funnel count or a probe. */}
          {(() => {
            const e = economicsLine({ payout: health.flow?.payout, gas: health.gas });
            return e ? (
              <div className="ops-economics" data-tone={e.tone} title={e.title}>
                {e.text}
              </div>
            ) : null;
          })()}
        </div>

        {/* One frame asserts one treasury subject, never one instrument: venue
            and pool keep separate tones, absence rules and figures, and no
            total is allowed to span their unlike windows. */}
        <section
          className="ops-bank-group"
          aria-labelledby="ops-bank-group-title"
          data-testid="ops-bank-group"
        >
          <h2 id="ops-bank-group-title">BANK</h2>
          {/* The venue renders nothing when it was never wired; the pool stays
              explicit because its unavailable state is itself a reading. */}
          <BankLane bank={health.bank} />
          <DepositPoolTile pool={health.depositPool} />
        </section>

        <PillarStrip probes={health.probes} history={health.history} nowMs={nowMs} />

        {/* ── NEXT ────────────────────────────────────────────────────────
            The board says WHAT is wrong in eleven places and never once said
            what to DO. `opsSuggestions` has derived probe-cited, pre-drafted
            remediations for eight incident types since 2026-07; until now it
            was imported by NOTHING — it was wired to the co-pilot board the
            ops-only pivot replaced, and the content simply stopped reaching a
            person. The fourth instance in one day of this system discarding
            words it had already written.

            TEXT ONLY. Each suggestion carries a `task` the operator could
            approve, and this board is read-only by design. Rendering the button here would
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

        {/* The fault line is structural: demand belongs after everything that
            can page the operator. Both independent doors remain visible, and
            moving them refuses to recast a business outcome as a money fault. */}
        <ArrivalsPanel arrivals={health.arrivals} />
        <AdminDemandPanel
          feed={adminDemand}
          window={adminDemandWindow}
          isLoading={adminDemandLoading}
          error={adminDemandError}
          onWindowChange={onAdminDemandWindowChange}
        />

        <div className="ops-foot">
          <span>INCIDENTS — {incidentSummary(health, nowMs)}</span>
          <span>{llmSummary(board)}</span>
          <span>refresh is the only operational control · window selects a read</span>
        </div>
      </div>
    </div>
  );
}

const PRESENCE_COPY: Record<OutsiderBand, { verb: string; note: string }> = {
  worked: { verb: "worked", note: "an outsider claimed or submitted — this is demand" },
  engaged: { verb: "looked around", note: "reached us and got as far as identifying" },
  knocked: { verb: "knocked", note: "reached the door and went no further" },
};

/**
 * OUTSIDE — the presence line.
 *
 * Renders nothing at all when the producer sends no registry: this strip is
 * an addition, and a board that predates it must not grow a permanent "not
 * reported" bar across its top band. The ARRIVALS panel below says so in its
 * own words, which is the right place for that sentence.
 */
function OutsidePresence({ arrivals, nowMs }: { arrivals: ProductHealth["arrivals"]; nowMs: number }) {
  const presence = outsiderPresence(arrivals, nowMs);
  if (!presence || presence.band == null) return null;
  const copy = PRESENCE_COPY[presence.band];

  return (
    <div className="ops-outside" data-band={presence.band} data-live={presence.live ? "yes" : "no"} data-testid="ops-outside">
      <span className="ops-outside-key">OUTSIDE</span>
      {/* The pulse marks RECENT, not healthy — it is ink, like everything
          else on this line, and it stops when the activity stops. */}
      <i className="ops-outside-pulse" aria-hidden />
      <span className="ops-outside-lead">
        deepest: someone <b>{copy.verb}</b>
      </span>
      {/* The counts are the registry's whole observation window, not today.
          "1 worked" with no window stated reads as this morning, and the
          registry has never meant that. */}
      <span className="ops-outside-counts">
        {(["worked", "engaged", "knocked"] as const)
          .filter((b) => presence.counts[b] > 0)
          .map((b) => `${presence.counts[b]} ${PRESENCE_COPY[b].verb}`)
          .join(" · ")}
        <small>
          {presence.observingSinceMs == null
            ? " since observing began"
            : ` since ${new Date(presence.observingSinceMs).toISOString().slice(0, 10)}`}
        </small>
      </span>
      {/* Aged against the PRODUCER's clock, the same one the roster below
          uses — two clocks put two ages for one event on one screen. */}
      <span className="ops-outside-when">
        {presence.lastSeenMs == null
          ? "no activity time reported"
          : `last ${formatAgo(presence.lastSeenMs, presence.asOfMs)}`}
      </span>
      <span className="ops-outside-note">{copy.note}</span>
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
  // Absent is not empty: a build that reports no log at all must not read as a
  // clean record. The INCIDENTS column makes the same distinction.
  if (!health.history?.incidents) return "durable log not reported by this build";
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
