// Dependencies & deploy — the infra band. Dependency dots are derived only from
// probes we actually have signal for (Product API, Chain RPC, Capabilities);
// deps we don't yet probe (Redis, KMS, gateway) are named as faint "not probed"
// rather than shown as a fake green. Deploy shows the monitor's own probe count
// and whether the product /health has started emitting the structured blocks.

import type { ProductHealth, ProductHealthProbe } from "../../lib/monitor/product-health.js";
import { probeOpsTone } from "../../lib/monitor/ops-model.js";
import { OpsZone } from "./OpsZone.js";

export interface DepsDeployZoneProps {
  health: ProductHealth;
}

function toneOf(probes: ProductHealthProbe[], name: string): string {
  const probe = probes.find((p) => p.name === name);
  return probe ? probeOpsTone(probe) : "awaiting";
}

export function DepsDeployZone({ health }: DepsDeployZoneProps) {
  const deps: { label: string; tone: string }[] = [
    { label: "Product API", tone: toneOf(health.probes, "product_api") },
    { label: "Chain RPC", tone: toneOf(health.probes, "chain_height") },
    { label: "Capabilities", tone: toneOf(health.probes, "capabilities") },
  ];
  const structuredLive = health.solvency != null || health.flow != null;
  return (
    <OpsZone className="z-deps" icon="topology" title="Dependencies & deploy" testId="ops-zone-deps">
      <div className="ops-deps">
        {deps.map((dep) => (
          <span key={dep.label} className={`ops-dep ops-dep--${dep.tone}`}>
            <span className="ops-dot" aria-hidden />
            {dep.label}
          </span>
        ))}
      </div>
      <p className="ops-await ops-await--inline">not yet probed — Redis · KMS · gateway</p>

      <div className="ops-deploy">
        <div className="ops-deploy-row ops-deploy-row--ok">
          <span className="ops-dot" aria-hidden />
          <span className="ops-deploy-name">Monitor</span>
          <span className="ops-deploy-val">{health.probes.length} probes active</span>
        </div>
        <div className={`ops-deploy-row ops-deploy-row--${structuredLive ? "ok" : "awaiting"}`}>
          <span className="ops-dot" aria-hidden />
          <span className="ops-deploy-name">Product /health</span>
          <span className="ops-deploy-val">
            {structuredLive ? "structured blocks live" : "awaiting structured blocks"}
          </span>
        </div>
        {health.remediation && health.remediation.state !== "off" && (
          <div
            className={`ops-deploy-row ops-deploy-row--${remediationTone(health.remediation.state)}`}
            data-testid="ops-remediation"
          >
            <span className="ops-dot" aria-hidden />
            <span className="ops-deploy-name">RPC failover</span>
            <span className="ops-deploy-val">{health.remediation.detail}</span>
          </div>
        )}
      </div>
    </OpsZone>
  );
}

/** armed → sage · failover → amber · halted → coral (the row only renders when enabled). */
function remediationTone(state: "armed" | "failover" | "halted" | "off"): string {
  return state === "halted" ? "red" : state === "failover" ? "degraded" : "ok";
}
