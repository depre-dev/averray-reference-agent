// A compact uptime strip — one cell per check, coloured by status (green ok /
// grey degraded / coral red). The series right-aligns into a fixed cell count so
// every probe's strip lines up.

import type { ProbeStatus } from "../../lib/monitor/product-health.js";
import { probeTone } from "../../lib/monitor/product-health.js";

export interface ProbeSparklineProps {
  series: ProbeStatus[];
  /** Fixed cell count; older checks pad the left with empty cells. */
  bins?: number;
}

export function ProbeSparkline({ series, bins = 24 }: ProbeSparklineProps) {
  const cells = series.slice(Math.max(0, series.length - bins));
  const pad = Math.max(0, bins - cells.length);
  return (
    <div className="hm-spark" role="img" aria-label={`uptime over the last ${cells.length} checks`}>
      {Array.from({ length: pad }).map((_, i) => (
        <span key={`pad-${i}`} className="hm-spark-cell hm-spark-cell--empty" />
      ))}
      {cells.map((status, i) => (
        <span key={i} className={`hm-spark-cell hm-spark-cell--${probeTone(status)}`} />
      ))}
    </div>
  );
}
