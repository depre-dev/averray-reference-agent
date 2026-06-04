// Hermes Handoff Monitor — DegradedCard
//
// Hand-built card variant for the two states where the live Card shape
// isn't trustworthy: `failed-fetch` (upstream returned an error) and
// `source-offline` (upstream unreachable).
//
// Visual contract:
//   - failed-fetch   → rose ribbon, ERROR pip, "Retry now" action
//   - source-offline → neutral grey, OFFLINE pip, "View last known"
//                       action (no urgency — we don't know what's
//                       happening upstream, so we don't fake confidence)
//
// The hard rule from §16 of the spec: zero tolerance for hiding "we
// don't know if there's action needed." A failed-fetch card must be
// obviously not-fresh; an offline card must not pretend we have current
// data.

import type { ReactNode } from "react";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import { Badge, Button, CardHeader, type StateVariant } from "../ui.js";

export type DegradedCardKind = "failed-fetch" | "source-offline";

export type DegradedCardProps = {
  card: BoardCard;
  /** Operator-facing body copy explaining what happened. */
  body: ReactNode;
  /** Pill labels (e.g. ["fetch failed", "retry available"]). */
  pills: ReadonlyArray<readonly [pillClass: string, label: string]>;
  /** Primary action label (e.g. "Retry now", "View last known"). */
  action: string;
  /** Click handler — typically wired to a retry / refresh in M5'. */
  onAction?: () => void;
  /** Card click handler — opens the context drawer in M6'. */
  onClick?: (card: BoardCard) => void;
};

export function DegradedCard({ card, body, pills, action, onAction, onClick }: DegradedCardProps) {
  const kind: DegradedCardKind = card.state === "source-offline" ? "source-offline" : "failed-fetch";
  const isErr = kind === "failed-fetch";

  return (
    <div
      className={"hm-card " + (isErr ? "hm-card--err" : "hm-card--offline")}
      onClick={onClick ? () => onClick(card) : undefined}
      tabIndex={-1}
      data-card-id={card.id}
      data-card-state={kind}
      role={onClick ? "button" : "article"}
      aria-label={`${card.id} — ${isErr ? "error" : "offline"}: ${card.title}`}
    >
      <CardHeader
        agent="ext"
        id={card.id}
        status={isErr ? "ERROR" : "OFFLINE"}
        statusVariant={isErr ? "fail" : "degraded"}
      />

      <div className="hm-card-title" style={{ color: isErr ? "var(--hm-rose)" : "var(--hm-muted)" }}>
        {body}
      </div>

      <div className="hm-pillrow">
        {pills.map(([cls, label]) => (
          <Badge key={label} variant={pillVariantFromClass(cls)} className={cls}>
            {label}
          </Badge>
        ))}
      </div>

      <div className="hm-card-cta">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onAction?.();
          }}
          disabled={!onAction}
        >
          {action}
        </Button>
      </div>
    </div>
  );
}

function pillVariantFromClass(cls: string): StateVariant {
  if (cls.includes("--err")) return "fail";
  if (cls.includes("--offline")) return "degraded";
  if (cls.includes("--running")) return "pending";
  if (cls.includes("--ok")) return "pass";
  if (cls.includes("--info")) return "info";
  return "neutral";
}
