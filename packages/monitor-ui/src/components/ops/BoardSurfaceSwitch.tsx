// The board-level Delivery ⇆ Ops switch. Lifted out of the Done-lane header so it
// swaps the WHOLE board (not one lane) between the delivery kanban and the
// full-canvas ops surface. The Ops tab carries a health dot so a degraded/red
// product is visible from the Delivery view; a fresh red also auto-flips here.

import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { overallSummary, overallToneClass } from "../../lib/monitor/product-health.js";

export type BoardSurface = "delivery" | "ops";

export interface BoardSurfaceSwitchProps {
  surface: BoardSurface;
  onChange: (surface: BoardSurface) => void;
  health: ProductHealth | undefined;
}

export function BoardSurfaceSwitch({ surface, onChange, health }: BoardSurfaceSwitchProps) {
  const overall = health ? overallSummary(health) : undefined;
  const tone = overall ? overallToneClass(overall.tone) : "muted";
  return (
    <div className="ops-switch" role="tablist" aria-label="Board surface">
      <button
        type="button"
        role="tab"
        aria-selected={surface === "delivery"}
        className={`ops-switch-opt${surface === "delivery" ? " is-on" : ""}`}
        onClick={() => onChange("delivery")}
      >
        Delivery
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={surface === "ops"}
        className={`ops-switch-opt${surface === "ops" ? " is-on" : ""}`}
        onClick={() => onChange("ops")}
        title={overall ? `Product health: ${overall.label}` : "Product health"}
      >
        <span className={`ops-dot ops-dot--${tone}`} aria-hidden="true" />
        Ops
      </button>
    </div>
  );
}
