import type { ReactNode } from "react";

export interface UtilCardProps {
  /** Card title (display font). Doubles as the section's accessible name. */
  title: string;
  /** Faint eyebrow hint to the right of the title (e.g. "per model · last 60 min"). */
  hint?: string;
  /** Optional right-aligned action slot (e.g. a "+ New suite" button). */
  action?: ReactNode;
  /** Stretch to fill the grid cell height (the usage card on the left). */
  fill?: boolean;
  /** Override the accessible region name when it should differ from the title. */
  ariaLabel?: string;
  children?: ReactNode;
}

/**
 * Shared, calm card chrome for the Utilities panel (usage · suites · launcher).
 * One header treatment so the three surfaces read as siblings; secondary to the
 * board (dim paper, hairline border). All color comes from the --h4-* profile
 * tokens so it tracks the active theme.
 */
export function UtilCard({ title, hint, action, fill, ariaLabel, children }: UtilCardProps) {
  return (
    <section className={`hm-util-card${fill ? " hm-util-card--fill" : ""}`} aria-label={ariaLabel ?? title}>
      <div className="hm-util-card-head">
        <span className="hm-util-card-title">{title}</span>
        {hint ? <span className="hm-util-card-hint">{hint}</span> : null}
        {action ? <span className="hm-util-card-action">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}
