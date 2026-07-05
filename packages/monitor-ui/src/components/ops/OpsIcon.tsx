// A tiny inline-SVG icon set for the Ops zones. The board ships no icon font, so
// these are self-contained 16px stroke glyphs that inherit currentColor. Kept
// deliberately minimal — one path per icon, flat, no fill.

export type OpsIconName = "wallet" | "flow" | "chart" | "timeline" | "topology" | "deploy" | "pulse";

const PATHS: Record<OpsIconName, string> = {
  wallet: "M2 5.5A1.5 1.5 0 0 1 3.5 4H12a2 2 0 0 1 2 2v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12zM11 9h1.5",
  flow: "M2 8h9m0 0-3-3m3 3-3 3M2 4v8",
  chart: "M2 2v11h12M5 10l2.5-3.5L10 8l3-4",
  timeline: "M2 8h12M5 8a1.6 1.6 0 1 0 0-.01M11 8a1.6 1.6 0 1 0 0-.01",
  topology: "M8 2.5a1.6 1.6 0 1 0 0 .01M4 13a1.6 1.6 0 1 0 0-.01M12 13a1.6 1.6 0 1 0 0-.01M8 4 4.6 11.4M8 4l3.4 7.4",
  deploy: "M8 2 4 6h2.5v5h3V6H12zM4.5 13.5h7",
  pulse: "M1.5 8h3l2-4 3 8 2-4h3",
};

export interface OpsIconProps {
  name: OpsIconName;
  size?: number;
}

export function OpsIcon({ name, size = 15 }: OpsIconProps) {
  return (
    <svg
      className="ops-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
