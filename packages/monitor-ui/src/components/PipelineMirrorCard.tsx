import type { BoardCard } from "../lib/monitor/card-types.js";
import { isDecision, type KanbanTier } from "../lib/monitor/lane-rules.js";
import { deployStepsForCard } from "../lib/monitor/deploy-stepper.js";
import { AgentTag, StatusPill, type StateVariant } from "./ui.js";
import { DeployStepper } from "./DeployStepper.js";

export type PipelineMirrorCardProps = {
  card: BoardCard;
  tier: KanbanTier;
  focused?: boolean;
  inboxAvailable?: boolean;
  onJumpToInbox?: (card: BoardCard) => void;
  /** PR-F3: render the deploy checkpoint stepper inline (the active deploy). */
  showStepper?: boolean;
};

function shortId(id: string): string {
  return id.replace(/^[a-z-]+ /, "");
}

function statusFor(card: BoardCard, tier: KanbanTier): { label: string; variant: StateVariant } {
  if (tier === "hide" || card.type === "done") return { label: "VERIFIED", variant: "pass" };
  if (card.state === "failed-fetch" || card.state === "source-offline") return { label: "SOURCE ISSUE", variant: "degraded" };
  if (card.state === "stale") return { label: "STALE", variant: "age" };
  if (card.state === "running") return { label: "RUNNING", variant: "running" };
  if (card.type === "task" && card.taskStatus) return { label: card.taskStatus.toUpperCase(), variant: taskVariant(card.taskStatus) };
  if (card.type === "mission" && card.missionStatus) return { label: card.missionStatus.toUpperCase(), variant: missionVariant(card.missionStatus) };
  if (card.type === "deploy") return { label: deployStatusLabel(card), variant: "running" };
  if (card.waitingOn?.actor) return { label: `WAITING ON ${card.waitingOn.actor.toUpperCase()}`, variant: "neutral" };
  return { label: "WATCHING", variant: "neutral" };
}

function deployStatusLabel(card: Extract<BoardCard, { type: "deploy" }>): string {
  const current = card.deploySteps?.find((step) => (
    step.state === "in-progress" || step.state === "current" || step.state === "running"
  ));
  return current?.label ?? card.verification?.label ?? "DEPLOYING";
}

function taskVariant(status: NonNullable<Extract<BoardCard, { type: "task" }>["taskStatus"]>): StateVariant {
  if (status === "failed" || status === "cancelled") return "fail";
  if (status === "completed") return "pass";
  if (status === "running") return "running";
  return "pending";
}

function missionVariant(status: NonNullable<Extract<BoardCard, { type: "mission" }>["missionStatus"]>): StateVariant {
  if (status === "failed") return "fail";
  if (status === "completed") return "pass";
  if (status === "running") return "running";
  if (status === "requested") return "pending";
  return "neutral";
}

export function PipelineMirrorCard({
  card,
  tier,
  focused = false,
  inboxAvailable = false,
  onJumpToInbox,
  showStepper = false,
}: PipelineMirrorCardProps) {
  const status = statusFor(card, tier);
  const deploySteps = showStepper && card.type === "deploy" ? deployStepsForCard(card) : null;
  // PR-F1: the "jump to inbox" affordance + "awaiting" treatment use the shared
  // isDecision predicate, so a mirror only points to the inbox when the card is
  // genuinely there. Finished release-history cards (no live decision) stay
  // passive — no broken jump to a card the inbox no longer holds.
  const canJump = inboxAvailable && isDecision(card) && onJumpToInbox;
  const classes = [
    "hm-pipeline-card",
    tier === "hide" ? "hm-pipeline-card--verified" : "",
    isDecision(card) ? "is-awaiting-inbox" : "",
    focused ? "is-focused" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      className={classes}
      data-pipeline-card-id={card.id}
      data-h4-tier={tier}
      aria-label={`${card.agentType} ${shortId(card.id)} — ${card.title}`}
    >
      <div className="hm-pipeline-card-head">
        <AgentTag agent={card.agentType} identifier={shortId(card.id)} className="hm-pipeline-card-id hm-mono" />
        <StatusPill variant={status.variant} dot className="hm-pipeline-card-status">
          {status.label}
        </StatusPill>
      </div>
      <div className="hm-pipeline-card-title">{card.title}</div>
      <div className="hm-pipeline-card-meta">
        <span className="hm-pipeline-card-repo">{card.repo}</span>
      </div>
      {deploySteps ? (
        <div className="hm-pipeline-card-deploy">
          <span className="hm-pipeline-card-deploy-label">Current deploy · verifying</span>
          <DeployStepper steps={deploySteps} compact />
        </div>
      ) : null}
      {canJump ? (
        <button
          type="button"
          className="hm-pipeline-card-jump"
          onClick={(event) => {
            event.stopPropagation();
            onJumpToInbox(card);
          }}
        >
          <span>Awaiting your decision in inbox</span>
          <strong>jump ›</strong>
        </button>
      ) : null}
    </article>
  );
}
