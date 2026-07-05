// Shared zone panel — the framed surface every Ops zone renders into. A visible
// heading (icon + title + optional right-aligned meta) plus the zone body. Uses
// the --h4 paper surface so all zones share one chrome.

import type { ReactNode } from "react";
import { OpsIcon, type OpsIconName } from "./OpsIcon.js";

export interface OpsZoneProps {
  title: string;
  icon: OpsIconName;
  className?: string;
  meta?: ReactNode;
  testId?: string;
  children: ReactNode;
}

export function OpsZone({ title, icon, className = "", meta, testId, children }: OpsZoneProps) {
  return (
    <section className={`ops-zone ${className}`.trim()} data-testid={testId}>
      <h3 className="ops-zone-head">
        <span className="ops-zone-icon" aria-hidden>
          <OpsIcon name={icon} />
        </span>
        <span className="ops-zone-title">{title}</span>
        {meta ? <span className="ops-zone-meta">{meta}</span> : null}
      </h3>
      {children}
    </section>
  );
}
