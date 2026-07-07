import type {
  LlmUsageAggregate,
  LlmUsageBilling,
  LlmUsageModelRollup,
  LlmUsageRecent,
  LlmUsageWindow,
  SubscriptionBilling,
} from "../lib/monitor/board-cache.js";
import { formatCompactNumber, formatNumber, formatRelativeTime } from "../lib/monitor/format.js";
import { UtilCard } from "./UtilCard.js";

/**
 * LLM usage card — the design-faithful surface for the Utilities panel. Binds
 * ONLY to real LlmUsageAggregate: per-(agent, model) rows, an "All models"
 * total, the in-flight line, EVERY expected agent (active or idle — none
 * hidden), real cost when recorded, and a real daily-tokens chart. Truth-boundary:
 *   - Latency renders "?" — LlmUsageModelRollup has no latency field.
 *   - Cost shows only when costStatus is "recorded" (never fabricated); the Cost
 *     column appears only when at least one source reports it.
 *   - The time chart is REAL daily byDay tokens when ≥2 days exist; otherwise an
 *     honest "awaiting per-minute stream" frame (that source isn't wired yet).
 *   - When nothing is recorded, the honest message replaces the table.
 */
export function UsagePanel({ usage }: { usage?: LlmUsageAggregate }) {
  const recorded = usage?.status === "recorded";
  const latestDay = usage?.byDay?.[0];
  // Every (agent, model) that actually reported counters.
  const models = usage?.byModel?.length ? usage.byModel : latestDay?.byModel ?? [];
  // Every expected agent that has NOT reported — shown explicitly, never collapsed,
  // so the full agent roster (claude · test-writer · security · docs · codex · hermes)
  // is always accounted for.
  const idleSources = (usage?.sourceStatus ?? []).filter((entry) => entry.status === "not_reported");
  const activeCalls = usage?.activeCalls ?? [];
  const emptyMessage = usage?.message
    ?? "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.";
  const hasTable = recorded && models.length > 0;
  // Cost split by billing model (metered $ vs flat Ollama subscription + burn windows).
  const billing = usage?.billing;
  // Cost column: when billing is present every row has a meaningful cell (metered $,
  // "flat" for subscription, or "?"), so show it. Otherwise fall back to the old
  // "only when something recorded" rule so we never paint a bare column of "?".
  const showCost = !!usage && (
    !!billing || usage.costStatus === "recorded" || models.some((m) => m.costStatus === "recorded")
  );
  // Real daily-tokens series (oldest→newest, last 14 days) — a chart, not a guess.
  const chartDays = (usage?.byDay ?? []).slice().sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
  const hasChart = recorded && chartDays.length >= 2;
  // Live per-minute per-model series — shown only when there's real recent activity.
  const recent = usage?.recent ?? null;
  const hasRecent = !!recent && recent.series.some((s) => s.points.some((p) => p > 0));

  return (
    <UtilCard title="LLM usage" hint="per model · all agents" fill ariaLabel="LLM usage">
      {hasTable && billing ? <CostSummary billing={billing} /> : null}
      {hasTable ? (
        <div className={`hm-usage-table${showCost ? " hm-usage-table--cost" : ""}`}>
          <div className="hm-usage-row hm-usage-row--head">
            <span className="hm-usage-c-model">Model</span>
            <span className="hm-usage-c-num">Tokens</span>
            <span className="hm-usage-c-num">Calls</span>
            {showCost ? <span className="hm-usage-c-num">Cost</span> : null}
            <span className="hm-usage-c-num">Latency</span>
          </div>
          <div className="hm-usage-row hm-usage-row--total">
            <span className="hm-usage-c-model">All models</span>
            <span className="hm-usage-c-num">{formatCompactNumber(usage!.totalTokens)}</span>
            <span className="hm-usage-c-num">{formatNumber(usage!.runs)}</span>
            {showCost ? (
              <span className="hm-usage-c-num" title="Recorded metered cost (Claude API, all time). Ollama runs on a flat subscription — see Cost this month above.">
                {formatCost(usage!.costUsd, usage!.costStatus)}
              </span>
            ) : null}
            <span className="hm-usage-c-num hm-usage-c-na" title="latency not reported">?</span>
          </div>
          {models.map((entry) => (
            <div className="hm-usage-row" key={`${entry.agent}:${entry.model}`}>
              <span className="hm-usage-c-model">
                <span className="hm-usage-jewel" style={{ background: agentJewel(entry.agent) }} aria-hidden />
                <span className="hm-usage-model">{entry.model}</span>
                <span className="hm-usage-owner">{entry.agent}</span>
              </span>
              <span className="hm-usage-c-num">{formatCompactNumber(entry.totalTokens)}</span>
              <span className="hm-usage-c-num">{formatNumber(entry.runs)}</span>
              {showCost ? <RowCost entry={entry} /> : null}
              <span className="hm-usage-c-num hm-usage-c-na" title="latency not reported">?</span>
            </div>
          ))}
          {/* in/out split + last-active live below the table, per active source */}
          <div className="hm-usage-splits">
            {models.map((entry) => {
              // Only draw the split bar when there's a real in+out denominator —
              // a cache-only row (totalTokens from cacheTokens, in+out === 0)
              // would otherwise paint a fabricated 100% bar.
              const flow = entry.inputTokens + entry.outputTokens;
              const inPct = flow > 0 ? Math.round((entry.inputTokens / flow) * 100) : 0;
              return (
                <div className="hm-usage-split" key={`${entry.agent}:${entry.model}:split`}>
                  {flow > 0 ? (
                    <div
                      className="hm-usage-bar"
                      role="img"
                      aria-label={`${formatCompactNumber(entry.inputTokens)} in, ${formatCompactNumber(entry.outputTokens)} out`}
                    >
                      <span className="hm-usage-bar-in" style={{ width: `${inPct}%` }} />
                      <span className="hm-usage-bar-out" style={{ width: `${100 - inPct}%` }} />
                    </div>
                  ) : null}
                  <small>{formatCompactNumber(entry.inputTokens)} in · {formatCompactNumber(entry.outputTokens)} out · last {formatRelativeTime(entry.lastActiveAt)}</small>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="hm-usage-empty">
          <strong>usage not reported</strong>
          <span>{emptyMessage}</span>
        </p>
      )}

      {/* Subscription burn — one block per active flat-plan provider (Ollama,
          Codex), usage against its real reset windows. Tokens/calls stand in for
          the plan's metered unit; never a fabricated per-token dollar figure. */}
      {billing?.subscriptions
        .filter((sub) => sub.active && sub.windows)
        .map((sub) => <SubscriptionBurn key={sub.provider} subscription={sub} />)}

      {/* What's running now (in-flight) — always glanceable. */}
      <div className="hm-usage-active">
        <span>What's running now</span>
        <strong>
          {activeCalls.length > 0
            ? activeCalls.map((call) => `${call.agent} · ${call.model}`).join(" · ")
            : "No in-flight LLM calls"}
        </strong>
      </div>

      {/* Idle agents — the rest of the roster, shown explicitly (not collapsed),
          each with its honest reason. So every agent is accounted for. */}
      {idleSources.length > 0 ? (
        <div className="hm-usage-idle">
          <span className="hm-usage-idle-head">Idle agents · {idleSources.length}</span>
          <ul className="hm-usage-idle-list">
            {idleSources.map((entry) => (
              <li key={entry.agent}>
                <span className="hm-usage-jewel hm-usage-jewel--idle" style={{ background: agentJewel(entry.agent) }} aria-hidden />
                <strong>{entry.agent}</strong>
                <span>{entry.reason ?? `${entry.agent} usage counters have not arrived.`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Time chart — live per-minute per-model lines when there's recent activity,
          else the real daily byDay bars, else an honest idle frame. */}
      {hasRecent && recent ? (
        <RecentLinesChart recent={recent} jewel={agentJewel} />
      ) : hasChart ? (
        <DailyTokensChart days={chartDays} />
      ) : hasTable ? (
        <div className="hm-usage-chart" role="img" aria-label="Usage over time — no recent activity">
          <div className="hm-usage-chart-head">
            <span className="hm-usage-chart-label">Usage over time · per minute</span>
            <span className="hm-usage-chart-chip">idle</span>
          </div>
          <svg className="hm-usage-chart-frame" viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden>
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1="4" x2="296" y1={8 + g * 94} y2={8 + g * 94} stroke="var(--h4-line-2)" strokeWidth="1" />
            ))}
            {["-60m", "-45m", "-30m", "-15m", "now"].map((t, i) => (
              <text
                key={t}
                x={4 + (i / 4) * 292}
                y="116"
                fill="var(--h4-faint)"
                fontSize="8"
                fontFamily="var(--font-mono)"
                textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              >
                {t}
              </text>
            ))}
          </svg>
          <span className="hm-usage-chart-note">no token usage in the last hour</span>
        </div>
      ) : null}
    </UtilCard>
  );
}

/** Live per-model lines — real per-minute token sums over the recent window. */
function RecentLinesChart({ recent, jewel }: { recent: LlmUsageRecent; jewel: (agent: string) => string }) {
  const padL = 4, padR = 4, padT = 8, padB = 18;
  const w = 300, h = 120;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = Math.max(1, recent.windowMinutes);
  const max = Math.max(1, ...recent.series.flatMap((s) => s.points));
  const xAt = (i: number) => padL + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + (1 - v / max) * plotH;
  const linePath = (points: number[]) => points.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");
  const ticks = [`-${n}m`, `-${Math.round(n * 0.75)}m`, `-${Math.round(n / 2)}m`, `-${Math.round(n / 4)}m`, "now"];
  return (
    <div className="hm-usage-chart" role="img" aria-label={`Live tokens per minute, last ${n} minutes, per model`}>
      <div className="hm-usage-chart-head">
        <span className="hm-usage-chart-label">Recent usage · tokens/min · per model</span>
        <span className="hm-usage-chart-chip hm-usage-chart-chip--live">live · {n}m</span>
      </div>
      <svg className="hm-usage-chart-frame" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={padL} x2={w - padR} y1={padT + g * plotH} y2={padT + g * plotH} stroke="var(--h4-line-2)" strokeWidth="1" />
        ))}
        {recent.series.map((s) => (
          <path
            key={`${s.agent}:${s.model}`}
            d={linePath(s.points)}
            fill="none"
            stroke={jewel(s.agent)}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.75"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {ticks.map((t, i) => (
          <text
            key={t}
            x={padL + (i / 4) * plotW}
            y={h - 5}
            fill="var(--h4-faint)"
            fontSize="8"
            fontFamily="var(--font-mono)"
            textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
          >
            {t}
          </text>
        ))}
      </svg>
      <div className="hm-usage-chart-legend">
        {recent.series.map((s) => (
          <span className="hm-usage-legend-item" key={`${s.agent}:${s.model}`}>
            <span className="hm-usage-jewel" style={{ background: jewel(s.agent) }} aria-hidden />
            <span>{s.model}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Real daily-tokens bars from byDay (totalTokens per day). */
function DailyTokensChart({ days }: { days: { day: string; totalTokens: number }[] }) {
  const padL = 4, padR = 4, padT = 8, padB = 18;
  const w = 300, h = 120;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const max = Math.max(1, ...days.map((d) => d.totalTokens));
  const slot = plotW / days.length;
  const barW = Math.min(28, slot * 0.62);
  const tickIdx = days.length <= 4
    ? days.map((_, i) => i)
    : [0, Math.round((days.length - 1) / 2), days.length - 1];
  return (
    <div className="hm-usage-chart" role="img" aria-label={`Daily tokens, last ${days.length} days`}>
      <div className="hm-usage-chart-head">
        <span className="hm-usage-chart-label">Daily tokens · last {days.length} days</span>
        <span className="hm-usage-chart-chip hm-usage-chart-chip--live">daily</span>
      </div>
      <svg className="hm-usage-chart-frame" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        {[0.5].map((g) => (
          <line key={g} x1={padL} x2={w - padR} y1={padT + g * plotH} y2={padT + g * plotH} stroke="var(--h4-line-2)" strokeWidth="1" />
        ))}
        {days.map((d, i) => {
          const bh = (d.totalTokens / max) * plotH;
          const x = padL + i * slot + (slot - barW) / 2;
          const y = padT + (plotH - bh);
          return <rect key={d.day} x={x} y={y} width={barW} height={Math.max(0, bh)} rx="1.5" fill="var(--h4-tel)" opacity="0.72" />;
        })}
        {tickIdx.map((i) => (
          <text
            key={days[i]!.day}
            x={padL + i * slot + slot / 2}
            y={h - 5}
            fill="var(--h4-faint)"
            fontSize="8"
            fontFamily="var(--font-mono)"
            textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
          >
            {days[i]!.day.slice(5)}
          </text>
        ))}
      </svg>
      <span className="hm-usage-chart-note hm-usage-chart-note--live">{formatCompactNumber(days.reduce((s, d) => s + d.totalTokens, 0))} tokens over {days.length} days</span>
    </div>
  );
}

/**
 * Cost-this-month headline. The total counts only what this app actually spends:
 * dedicated flat plans (Ollama, used only inside the monitor) + metered Claude $.
 * Shared plans (Codex draws from your ChatGPT plan, used beyond this app too) are
 * listed separately as context and NOT summed — folding a shared subscription
 * into the total would overstate what the app costs.
 */
function CostSummary({ billing }: { billing: LlmUsageBilling }) {
  const dedicated = billing.subscriptions.filter((sub) => sub.dedicated);
  const shared = billing.subscriptions.filter((sub) => !sub.dedicated);
  const anyDedicatedCost = dedicated.some((sub) => sub.configured) || billing.metered.monthCostUsd != null;
  const meteredAmount = billing.metered.monthCostUsd != null ? formatUsd(billing.metered.monthCostUsd) : "$0";
  const totalText = billing.monthlyTotalUsd != null
    ? `${anyDedicatedCost ? "≈ " : ""}${formatUsd(billing.monthlyTotalUsd)}${billing.monthlyTotalComplete ? "" : " +"}`
    : "—";
  return (
    <div className="hm-usage-cost" role="group" aria-label="Cost this month">
      <div className="hm-usage-cost-head">
        <span className="hm-usage-cost-label">Cost this month</span>
        <span className="hm-usage-cost-total" title={billing.monthlyTotalComplete ? undefined : "A dedicated plan has no price set — set OLLAMA_PLAN. Shared plans are intentionally excluded."}>{totalText}</span>
      </div>
      <div className="hm-usage-cost-rows">
        {dedicated.map((sub) => <CostRow key={sub.provider} sub={sub} />)}
        <div className="hm-usage-cost-row">
          <span className="hm-usage-jewel" style={{ background: "var(--h4-ag-claude)" }} aria-hidden />
          <span className="hm-usage-cost-name">Metered · Claude API</span>
          <span className="hm-usage-cost-amt">{meteredAmount}</span>
        </div>
      </div>
      {shared.length > 0 ? (
        <div className="hm-usage-cost-shared">
          <span className="hm-usage-cost-shared-head">Shared · used beyond this monitor · not in the total</span>
          {shared.map((sub) => <CostRow key={sub.provider} sub={sub} />)}
        </div>
      ) : null}
    </div>
  );
}

/** One subscription row in the cost summary — jewel, plan line, flat price. */
function CostRow({ sub }: { sub: SubscriptionBilling }) {
  return (
    <div className="hm-usage-cost-row">
      <span className="hm-usage-jewel" style={{ background: providerJewel(sub.provider) }} aria-hidden />
      <span className="hm-usage-cost-name">{planLine(sub)} · flat</span>
      <span className={`hm-usage-cost-amt${sub.configured ? "" : " hm-usage-c-na"}`}>
        {sub.configured ? `${formatPlanUsd(sub.monthlyUsd ?? 0)}/mo` : "plan not set"}
      </span>
    </div>
  );
}

/**
 * Per-row cost cell, billing-aware. Subscription (Ollama, Codex) rows show a
 * muted "flat" tag instead of a misleading "?" — their cost lives in the flat
 * plan, not per call. Metered rows show the real recorded dollars (or "?" if a
 * metered provider didn't emit cost). Unknown rows stay "?".
 */
function RowCost({ entry }: { entry: LlmUsageModelRollup }) {
  if (billingClassOf(entry.agent, entry.model) === "subscription") {
    return (
      <span
        className="hm-usage-c-num hm-usage-c-flat"
        title="Included in a flat subscription plan — billed by the plan, not per call."
      >
        flat
      </span>
    );
  }
  if (entry.costStatus === "recorded") {
    return <span className="hm-usage-c-num">{formatCost(entry.costUsd, entry.costStatus)}</span>;
  }
  return <span className="hm-usage-c-num hm-usage-c-na" title="cost not reported">?</span>;
}

/**
 * Subscription burn — how much of a plan's allocation you've used in its real
 * reset windows (5h session · 7d week · this month). Tokens/calls are a proxy
 * for the plan's real metered unit (GPU-time / rolling-window usage), flagged as
 * such — never dressed up as dollars. Rendered once per active subscription.
 */
function SubscriptionBurn({ subscription }: { subscription: SubscriptionBilling }) {
  const windows = subscription.windows;
  if (!windows) return null;
  const planName = subscription.planLabel ? `${subscription.planLabel} plan` : subscription.label;
  const cells: LlmUsageWindow[] = [windows.session5h, windows.week7d, windows.month];
  return (
    <div className="hm-usage-burn" role="group" aria-label={`${subscription.label} subscription burn`}>
      <div className="hm-usage-burn-head">
        <span className="hm-usage-burn-title">{subscription.label} burn · {planName}</span>
        <span className="hm-usage-burn-chip" title="Tokens/calls are a proxy for the plan's real metered unit — not dollars.">proxy</span>
      </div>
      <div className="hm-usage-burn-windows">
        {cells.map((win) => (
          <div className="hm-usage-burn-win" key={win.label}>
            <span className="hm-usage-burn-win-label">{win.label}</span>
            <strong className="hm-usage-burn-win-tok">{formatCompactNumber(win.tokens)}</strong>
            <small className="hm-usage-burn-win-calls">{formatNumber(win.calls)} calls</small>
          </div>
        ))}
      </div>
      <small className="hm-usage-burn-note">{subscription.note}</small>
    </div>
  );
}

/** "Ollama Pro", "Codex Pro 5×", or just the label when the plan isn't set. */
function planLine(sub: SubscriptionBilling): string {
  return sub.planLabel ? `${sub.label} ${sub.planLabel}` : sub.label;
}

/** Provider jewel — Ollama rides the hermes token, Codex its own. */
function providerJewel(provider: "ollama" | "codex"): string {
  return provider === "codex" ? "var(--h4-ag-codex)" : "var(--h4-ag-hermes)";
}

/**
 * Billing model for an (agent, model) — mirrors the backend llmBillingClass so a
 * row's cost cell matches how the aggregate classed it. Flat-rate subscriptions
 * (the codex agent, or Ollama via the hermes agent / `:cloud` / ollama-tagged
 * models) show "flat"; the Claude SDK agents are metered; else unknown.
 */
function billingClassOf(agent: string, model: string): "subscription" | "metered" | "unknown" {
  const a = agent.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  if (a === "codex" || a === "hermes" || m.endsWith(":cloud") || m.includes("ollama")) return "subscription";
  if (a === "claude" || a === "test-writer" || a === "security" || a === "docs") return "metered";
  return "unknown";
}

/** Format a known dollar amount (assumes a real number, unlike formatCost). */
function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** Plan price — drops the ".00" on whole-dollar tiers so "$20/mo" reads clean. */
function formatPlanUsd(usd: number): string {
  if (usd === 0) return "$0";
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

function formatCost(usd: number | null | undefined, status: string): string {
  if (status !== "recorded" || usd == null) return "?";
  if (usd === 0) return "$0";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/**
 * Map an agent to its --h4 jewel token. Unknown agents fall back to the system
 * jewel — never a fabricated identity or hardcoded hex.
 */
function agentJewel(agent: string): string {
  const a = agent.toLowerCase();
  if (a.includes("hermes")) return "var(--h4-ag-hermes)";
  if (a.includes("codex")) return "var(--h4-ag-codex)";
  if (a.includes("test")) return "var(--h4-ag-test)";
  if (a.includes("claude")) return "var(--h4-ag-claude)";
  if (a.includes("operator") || a === "op") return "var(--h4-ag-op)";
  return "var(--h4-ag-system)";
}
