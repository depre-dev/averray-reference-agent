// The Delivery ⇆ Monitoring segmented toggle for the right lane head. Carries a
// health dot on the Monitoring tab so a red probe is visible from the Delivery
// view (the lane also auto-flips to Monitoring on a fresh red — see BoardView).

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { overallSummary, overallToneClass } from "../../lib/monitor/product-health.js";

export type LaneMode = "delivery" | "monitoring";

export interface MonitoringLaneToggleProps {
  mode: LaneMode;
  onChange: (mode: LaneMode) => void;
  health: ProductHealth | undefined;
}

export function MonitoringLaneToggle({ mode, onChange, health }: MonitoringLaneToggleProps) {
  const tone = health ? overallToneClass(overallSummary(health).tone) : "muted";
  return (
    <div className="hm-lane-switch" role="tablist" aria-label="Right lane view">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "delivery"}
        className={`hm-lane-switch-opt${mode === "delivery" ? " is-on" : ""}`}
        onClick={() => onChange("delivery")}
      >
        Delivery
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "monitoring"}
        className={`hm-lane-switch-opt${mode === "monitoring" ? " is-on" : ""}`}
        onClick={() => onChange("monitoring")}
      >
        <span className={`hm-dot hm-dot--${tone}`} aria-hidden="true" />
        Monitoring
      </button>
    </div>
  );
}
