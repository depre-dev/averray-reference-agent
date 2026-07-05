// Ops sparklines — self-contained, --h4-tokened, dependency-free.
//   OpsSpark   a per-check status strip (sage/amber/coral/grey cells)
//   LineSpark  a tiny SVG polyline for a numeric series (latency, balance)
// Both right-align / left-pad so strips of different lengths still line up.

import type { ProbeStatus } from "../../lib/monitor/product-health.js";

export interface OpsSparkProps {
  series: ProbeStatus[];
  /** Fixed cell count; older checks pad the left. */
  bins?: number;
}

export function OpsSpark({ series, bins = 24 }: OpsSparkProps) {
  const cells = series.slice(Math.max(0, series.length - bins));
  const pad = Math.max(0, bins - cells.length);
  return (
    <span className="ops-spark" role="img" aria-label={`last ${cells.length} checks`}>
      {Array.from({ length: pad }).map((_, i) => (
        <i key={`p${i}`} className="ops-spark-cell ops-spark-cell--empty" />
      ))}
      {cells.map((status, i) => (
        <i key={i} className={`ops-spark-cell ops-spark-cell--${status}`} />
      ))}
    </span>
  );
}

export interface LineSparkProps {
  values: (number | null)[];
  tone?: "ok" | "tel" | "act";
  width?: number;
  height?: number;
  ariaLabel?: string;
}

/** A flat polyline sparkline. Null samples create gaps (no fake interpolation). */
export function LineSpark({ values, tone = "tel", width = 200, height = 36, ariaLabel }: LineSparkProps) {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length < 2) {
    return <span className="ops-linespark ops-linespark--empty" role="img" aria-label={ariaLabel ?? "no series yet"} />;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const n = values.length;
  // Split into contiguous segments so null gaps break the line honestly.
  const segments: string[][] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    const x = n === 1 ? 0 : (i / (n - 1)) * width;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) segments.push(current);
  return (
    <svg
      className={`ops-linespark ops-linespark--${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? "trend"}
    >
      {segments.map((seg, i) => (
        <polyline key={i} points={seg.join(" ")} fill="none" />
      ))}
    </svg>
  );
}
