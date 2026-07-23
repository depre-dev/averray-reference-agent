import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { AgentType } from "../lib/monitor/card-types.js";

export type StateVariant =
  | "fail"
  | "pass"
  | "pending"
  | "degraded"
  | "fresh"
  | "age"
  | "neutral"
  | "risk"
  | "secret"
  | "info"
  | "draft"
  | "ghost"
  | "running"
  | "hermes";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "action";
export type ButtonSize = "xs" | "sm" | "md";
export type AgentTagAgent = AgentType | "operator" | "system" | "room" | "board";

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function variantClass(prefix: string, variant: StateVariant): string {
  return `${prefix}--${variant}`;
}

export function agentClass(agent: AgentTagAgent | undefined): string {
  return `agent-dot--${agent ?? "ext"}`;
}

export function agentDisplayName(agent: AgentTagAgent | undefined): string {
  if (agent === "operator") return "operator";
  if (agent === "test-writer") return "test-writer";
  if (agent === "security") return "security";
  if (agent === "docs") return "docs";
  if (agent === "hermes") return "hermes";
  if (agent === "harness") return "harness";
  if (agent === "codex") return "codex";
  if (agent === "claude") return "claude";
  if (agent === "room") return "room";
  if (agent === "board") return "board";
  if (agent === "system") return "system";
  return "ext";
}

export function Badge({
  variant = "neutral",
  dot = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: StateVariant;
  dot?: boolean;
}) {
  return (
    <span className={joinClasses("hm-badge", "hm-pill", variantClass("hm-badge", variant), variantClass("hm-pill", variant), className)} {...props}>
      {dot ? <span className="dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StatusPill({
  variant = "neutral",
  dot = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: StateVariant;
  dot?: boolean;
}) {
  return (
    <span className={joinClasses("hm-status-pill", variantClass("hm-status-pill", variant), className)} {...props}>
      {dot ? <span className="status-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={joinClasses(
        "hm-btn",
        `hm-btn--${variant}`,
        size !== "md" ? `hm-btn--${size}` : undefined,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function AgentTag({
  agent,
  identifier,
  label,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  agent?: AgentTagAgent;
  identifier?: ReactNode;
  label?: ReactNode;
}) {
  const display = label ?? agentDisplayName(agent);
  return (
    <span className={joinClasses("hm-agent-tag", className)} {...props}>
      <span className={joinClasses("agent-dot", agentClass(agent))} aria-hidden />
      <span className="hm-agent-tag-label">{display}</span>
      {identifier ? <strong className="hm-agent-tag-id">{identifier}</strong> : null}
      {children}
    </span>
  );
}

export function CardHeader({
  agent,
  id,
  status,
  statusVariant,
  statusClassName,
}: {
  agent?: AgentTagAgent;
  id: ReactNode;
  status: ReactNode;
  statusVariant: StateVariant;
  statusClassName?: string;
}) {
  return (
    <div className="hm-card-head">
      <AgentTag agent={agent} identifier={id} className="hm-card-id hm-mono" />
      <StatusPill
        variant={statusVariant}
        dot
        className={joinClasses("hm-card-fresh", statusClassName)}
      >
        {status}
      </StatusPill>
    </div>
  );
}

export function LaneHeader({
  title,
  count,
  action,
  collapse,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  collapse?: ReactNode;
}) {
  return (
    <div className="hm-lane-head">
      <div className="hm-lane-head-row">
        <span className="hm-lane-title">{title}</span>
        <StatusPill variant={count > 0 ? "pending" : "neutral"} className="hm-lane-count">
          {count}
        </StatusPill>
        {collapse}
      </div>
      {action ? <div className="hm-lane-action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={joinClasses("hm-empty-state", className)} {...props}>
      {children}
    </div>
  );
}
