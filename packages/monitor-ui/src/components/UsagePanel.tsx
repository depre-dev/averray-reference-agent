import type { LlmUsageAggregate, LlmUsageRecent } from "../lib/monitor/board-cache.js";
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
  // Cost column only when a real cost was recorded somewhere (never a column of "?").
  const showCost = !!usage && (usage.costStatus === "recorded" || models.some((m) => m.costStatus === "recorded"));
  // Real daily-tokens series (oldest→newest, last 14 days) — a chart, not a guess.
  const chartDays = (usage?.byDay ?? []).slice().sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
  const hasChart = recorded && chartDays.length >= 2;
  // Live per-minute per-model series — shown only when there's real recent activity.
  const recent = usage?.recent ?? null;
  const hasRecent = !!recent && recent.series.some((s) => s.points.some((p) => p > 0));

  return (
    <UtilCard title="LLM usage" hint="per model · all agents" fill ariaLabel="LLM usage">
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
            {showCost ? <span className="hm-usage-c-num">{formatCost(usage!.costUsd, usage!.costStatus)}</span> : null}
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
              {showCost ? (
                <span className={`hm-usage-c-num${entry.costStatus === "recorded" ? "" : " hm-usage-c-na"}`} title={entry.costStatus === "recorded" ? undefined : "cost not reported"}>
                  {formatCost(entry.costUsd, entry.costStatus)}
                </span>
              ) : null}
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
