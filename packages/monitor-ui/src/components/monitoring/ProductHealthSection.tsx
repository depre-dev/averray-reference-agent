// The product-health monitoring section — one card per probe (status pill +
// uptime sparkline + live detail). Truth-boundary: honest empty states for
// "monitoring off" and "no checks yet"; a degraded (unconfigured / unreachable)
// probe reads grey, never a fake green.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { probeLabel, probeTone } from "../../lib/monitor/product-health.js";
import { ProbeSparkline } from "./ProbeSparkline.js";

export interface ProductHealthSectionProps {
  health: ProductHealth;
}

const PILL_TEXT: Record<string, string> = { ok: "ok", degraded: "degraded", red: "red" };

export function ProductHealthSection({ health }: ProductHealthSectionProps) {
  if (!health.enabled) {
    return (
      <div className="hm-mon-empty" data-testid="product-health-off">
        <span className="hm-mon-empty-title">Monitoring is off</span>
        <span className="hm-mon-empty-detail">Set PRODUCT_HEALTH_ENABLED to start probing the live product.</span>
      </div>
    );
  }
  if (health.checks === 0) {
    return (
      <div className="hm-mon-empty" data-testid="product-health-idle">
        <span className="hm-mon-empty-title">Awaiting first check</span>
        <span className="hm-mon-empty-detail">The heartbeat runs every couple of minutes.</span>
      </div>
    );
  }
  return (
    <div className="hm-mon-probes">
      {health.probes.map((probe) => {
        const tone = probeTone(probe.status);
        return (
          <div key={probe.name} className={`hm-probe hm-probe--${tone}`} data-testid={`probe-${probe.name}`}>
            <div className="hm-probe-head">
              <span className="hm-probe-name">
                <span className={`hm-dot hm-dot--${tone}`} aria-hidden="true" />
                {probeLabel(probe.name)}
              </span>
              <span className={`hm-pill hm-pill--${tone}`}>{PILL_TEXT[probe.status]}</span>
            </div>
            <ProbeSparkline series={probe.sparkline} />
            <div className="hm-probe-detail">{probe.detail}</div>
          </div>
        );
      })}
    </div>
  );
}
