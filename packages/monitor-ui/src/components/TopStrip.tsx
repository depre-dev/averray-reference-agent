// Hermes Handoff Monitor — TopStrip
//
// Header strip showing the brand mark, KPI counts per lane, LIVE
// indicator, and a manual refresh button.
//
// M3' renders against derived board state from fixtures. M5' wires it to
// live SSE data + the real refresh; M11' adds the degraded-mode variant
// (KPIs show `?` instead of `0` when the live stream is disconnected).
//
// Visual contract is the bundle's `hm-top` block in styles/monitor.css.

import type { AutomationHealth } from "../lib/monitor/board-cache.js";
import { ChainTicker, type ChainTickerProps } from "./ChainTicker.js";

export type TopStripProps = {

  /** Live indicator timestamp, e.g. "14:32:08". When undefined, dashes shown. */
  liveAt?: string;
  /** Deploy-health label shown in the rightmost KPI pill. Default "OK". */
  deployHealth?: "OK" | "DEGRADED" | "UNKNOWN";
  /** Optional quiet gauge for Slack-only automation capacity signals. */
  automationHealth?: AutomationHealth;
  /** Click handler for the refresh button (M5' wires the actual refresh). */
  onRefresh?: () => void;
  /** When provided (Ops surface), the KPI cluster shows pillar-status chips
      instead of the delivery lane counts — so the frame stays ops-relevant. */
  opsPillars?: Array<{ label: string; tone: "ok" | "degraded" | "red" | "awaiting" }>;
  /** When provided, renders the block-height ticker beside the Live clock
      (data from the product-health poll; absent → no chip at all). */
  chainTick?: ChainTickerProps;
};

export function TopStrip({ liveAt, deployHealth = "OK", automationHealth, onRefresh, opsPillars, chainTick }: TopStripProps) {
  return (
    <div className="hm-top" role="banner">
      <div className="hm-brand">
        <div className="hm-brand-mark" aria-hidden>
          A
        </div>
        <div>
          <div className="hm-brand-name">Hermes</div>
          <div className="hm-brand-sub">Handoff monitor · Averray</div>
        </div>
      </div>

      <div
        className="hm-kpis"
        role="status"
        aria-live="polite"
        aria-label="Ops pillar status"
      >
        {(opsPillars ?? []).map((pillar) => (
          <span key={pillar.label} className={`hm-kpi hm-kpi--ops ops-kpi--${pillar.tone}`}>
            <span className="dot" aria-hidden />
            {pillar.label}
          </span>
        ))}
      </div>

      <div className="hm-top-right">
        {chainTick ? <ChainTicker {...chainTick} /> : null}
        <span className="hm-deploy-pill" aria-label={liveAt ? `Live as of ${liveAt}` : "Live indicator"}>
          <span className="ledge" aria-hidden />
          Live · {liveAt ?? "—"}
        </span>
        <button
          type="button"
          className="hm-refresh"
          onClick={onRefresh}
          disabled={!onRefresh}
          aria-label="Refresh board"
        >
          ⟳ Refresh
        </button>
      </div>
    </div>
  );
}

function AutomationHealthPill({ health }: { health: AutomationHealth }) {
  const quietSignals = health.quietSignalCount === null ? null : Math.max(0, Math.floor(health.quietSignalCount ?? 0));
  const taskHealth = health.taskHealth;
  const sourceDegraded = health.sourceStatus === "degraded";
  const text = [
    `Self-heal ${countLabel(health.selfHealingOpen)} open`,
    `dispatch ${countLabel(health.dispatchUsedToday)}/${health.dispatchPerDayCap}`,
    taskHealth?.stuckTasks ? `stuck ${taskHealth.stuckTasks}` : "",
    quietSignals === null ? "quiet ?" : quietSignals > 0 ? `quiet ${quietSignals}` : "",
    sourceDegraded ? "source ?" : "",
  ].filter(Boolean).join(" · ");
  return (
    <details className="hm-automation-health">
      <summary className="hm-kpi hm-kpi--automation hm-automation-summary" aria-label={`Automation health: ${text}`}>
        <span className="dot" aria-hidden />
        {text}
      </summary>
      <div className="hm-automation-panel" role="group" aria-label="Automation diagnostics">
        <div className="hm-automation-row">
          <span>Task health</span>
          <strong>{taskHealthLine(taskHealth)}</strong>
        </div>
        <div className="hm-automation-row">
          <span>Runner</span>
          <strong>{runnerLine(taskHealth)}</strong>
        </div>
        <div className="hm-automation-row">
          <span>Routing memory</span>
          <strong>{routingLine(health.routing)}</strong>
        </div>
        <div className="hm-automation-row">
          <span>Budget</span>
          <strong>Dispatch {countLabel(health.dispatchUsedToday)} of {health.dispatchPerDayCap}</strong>
        </div>
        <div className="hm-automation-note">
          Retries stay bounded and respect dispatch policy, HALT, anomaly pause, and the human merge gate.
        </div>
      </div>
    </details>
  );
}

function countLabel(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function taskHealthLine(health: AutomationHealth["taskHealth"]): string {
  if (!health || health.status === "unknown") return "unknown";
  const parts = [
    `${health.runningTasks} running`,
    `${health.stuckTasks} stuck`,
    `${health.retryWaitingTasks} retry waiting`,
    `${health.escalatedTasks} escalated`,
  ];
  return `${statusLabel(health.status)} · ${parts.join(" · ")}`;
}

function runnerLine(health: AutomationHealth["taskHealth"]): string {
  const runner = health?.runner;
  if (!runner) return "unknown";
  const age = typeof runner.ageMs === "number" ? ` · ${Math.round(runner.ageMs / 1000)}s ago` : "";
  return `${statusLabel(runner.status)} · ${runner.reason}${age}`;
}

function routingLine(routing: AutomationHealth["routing"]): string {
  if (!routing || routing.status === "unknown") return "unknown";
  const top = routing.top
    ? ` · top ${routing.top.agent} on ${routing.top.surface} (${routing.top.score}, ${routing.top.samples} samples)`
    : "";
  return [
    statusLabel(routing.status),
    `${countLabel(routing.baselineSurfaces)} baseline`,
    `${countLabel(routing.insufficientSurfaces)} sparse`,
    `${countLabel(routing.decisionsToday)} decisions today`,
  ].join(" · ") + top;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function Kpi({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "default" | "action" | "zero";
}) {
  const cls =
    tone === "action"
      ? "hm-kpi hm-kpi--action"
      : tone === "zero"
        ? "hm-kpi hm-kpi--zero"
        : "hm-kpi";
  return (
    <span className={cls}>
      <span className="n">{count}</span> {label}
    </span>
  );
}
