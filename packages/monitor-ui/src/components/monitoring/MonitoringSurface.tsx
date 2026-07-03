// The Monitoring view that fills the switched right lane. A stack of monitoring
// sections — product-health is the first. Future sections (uptime %, liquidity
// trend, money-path KPIs, incident log) drop in as their own components below;
// this surface just composes them, so growing the monitoring story is additive.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { overallSummary, overallToneClass } from "../../lib/monitor/product-health.js";
import { ProductHealthSection } from "./ProductHealthSection.js";

export interface MonitoringSurfaceProps {
  health: ProductHealth;
}

export function MonitoringSurface({ health }: MonitoringSurfaceProps) {
  const overall = overallSummary(health);
  return (
    <div className="hm-mon-surface" data-testid="monitoring-surface">
      <section className="hm-mon-section">
        <header className="hm-mon-section-head">
          <span className="hm-mon-section-title">Product health</span>
          <span className={`hm-pill hm-pill--${overallToneClass(overall.tone)}`}>{overall.label}</span>
        </header>
        <ProductHealthSection health={health} />
      </section>
      <p className="hm-mon-headroom">More monitoring lands here — uptime, liquidity trend, incidents.</p>
    </div>
  );
}
