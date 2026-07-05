// Money-path flow — the settlement funnel: claimed → submitted → settled, with
// stuck (amber) and failed-24h (coral) as the page-worthy drop-off tails. Until
// the backend exposes settlement counts, the funnel shows its shape under an
// honest awaiting veil rather than fabricated zeros.

import type { MoneyPathSnapshot } from "../../lib/monitor/product-health.js";
import { funnelSteps, hasFlowData } from "../../lib/monitor/ops-model.js";
import { OpsZone } from "./OpsZone.js";

export interface MoneyPathZoneProps {
  flow: MoneyPathSnapshot | undefined;
}

export function MoneyPathZone({ flow }: MoneyPathZoneProps) {
  const steps = funnelSteps(flow);
  const live = hasFlowData(flow);
  return (
    <OpsZone
      className="z-flow"
      icon="flow"
      title="Money-path flow"
      testId="ops-zone-flow"
      meta={live ? null : <span className="ops-await ops-await--tag">awaiting settlement counts</span>}
    >
      <div className={`ops-funnel${live ? "" : " is-awaiting"}`} data-testid="ops-funnel">
        {steps.map((step) => (
          <div key={step.key} className={`ops-fstep ops-fstep--${step.tone}`} data-testid={`ops-fstep-${step.key}`}>
            <div className="ops-fstep-n">{step.value == null ? "—" : step.value}</div>
            <div className="ops-fstep-l">{step.label}</div>
          </div>
        ))}
      </div>
      <p className="ops-zone-note">
        {live
          ? "Stuck and execution-failures page; the tail is where money gets trapped."
          : "Lights up the moment the product /health exposes settlement counts."}
      </p>
    </OpsZone>
  );
}
