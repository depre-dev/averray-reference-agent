import { useState } from "react";
import type { LlmUsageAggregate } from "../lib/monitor/board-cache.js";
import { formatCompactNumber, formatNumber, formatRelativeTime } from "../lib/monitor/format.js";
import { UtilCard } from "./UtilCard.js";

/**
 * LLM usage card — the redesigned, design-faithful surface for the Utilities
 * panel. Binds ONLY to real LlmUsageAggregate: per-(agent, model) rows, an
 * "All models" total, the in-flight line, and idle sources with their honest
 * reasons one click away. Truth-boundary:
 *   - Latency renders "?" — LlmUsageModelRollup has no latency field.
 *   - Cost is never shown while costStatus is "not_recorded".
 *   - The recent-usage chart is an explicit awaiting-data frame, never the
 *     design's synthetic "demo shape" series (no real per-minute stream exists).
 *   - When nothing is recorded, the honest message replaces the table — no
 *     zero-filled fake rows.
 */
export function UsagePanel({ usage }: { usage?: LlmUsageAggregate }) {
  const [showIdle, setShowIdle] = useState(false);
  const recorded = usage?.status === "recorded";
  const latestDay = usage?.byDay?.[0];
  // Every (agent, model) that actually reported counters.
  const models = usage?.byModel?.length ? usage.byModel : latestDay?.byModel ?? [];
  // Idle sources collapse into ONE line; their honest reasons stay reachable.
  const idleSources = (usage?.sourceStatus ?? []).filter((entry) => entry.status === "not_reported");
  const activeCalls = usage?.activeCalls ?? [];
  const emptyMessage = usage?.message
    ?? "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.";
  const hasTable = recorded && models.length > 0;

  return (
    <UtilCard title="LLM usage" hint="per model · last 60 min" fill ariaLabel="LLM usage">
      {hasTable ? (
        <div className="hm-usage-table">
          <div className="hm-usage-row hm-usage-row--head">
            <span className="hm-usage-c-model">Model</span>
            <span className="hm-usage-c-num">Tokens</span>
            <span className="hm-usage-c-num">Calls</span>
            <span className="hm-usage-c-num">Latency</span>
          </div>
          <div className="hm-usage-row hm-usage-row--total">
            <span className="hm-usage-c-model">All models</span>
            <span className="hm-usage-c-num">{formatCompactNumber(usage!.totalTokens)}</span>
            <span className="hm-usage-c-num">{formatNumber(usage!.runs)}</span>
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

      {/* Idle sources — one muted line; honest reasons one click away. */}
      {idleSources.length > 0 ? (
        <div className="hm-usage-idle">
          <button
            type="button"
            className="hm-usage-idle-toggle"
            aria-expanded={showIdle}
            onClick={() => setShowIdle((value) => !value)}
          >
            <span aria-hidden>{showIdle ? "▾" : "▸"}</span>
            {idleSources.length} source{idleSources.length === 1 ? "" : "s"} idle: {idleSources.map((entry) => entry.agent).join(" · ")}
          </button>
          {showIdle ? (
            <ul className="hm-usage-idle-list">
              {idleSources.map((entry) => (
                <li key={entry.agent}>
                  <strong>{entry.agent}</strong>
                  <span>{entry.reason ?? `${entry.agent} usage counters have not arrived.`}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Recent-usage chart slot — honest awaiting-data frame, never synthetic
          data. Keeps the design's visual slot; a real per-minute stream renders
          here when it lands. */}
      {hasTable ? (
        <div className="hm-usage-chart" role="img" aria-label="Recent per-model usage — awaiting data stream">
          <div className="hm-usage-chart-head">
            <span className="hm-usage-chart-label">Recent usage · tokens/min · per model</span>
            <span className="hm-usage-chart-chip">not wired</span>
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
          <span className="hm-usage-chart-note">awaiting per-model usage stream</span>
        </div>
      ) : null}
    </UtilCard>
  );
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
