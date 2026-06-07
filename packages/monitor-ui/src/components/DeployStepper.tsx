import type { DeployStepView } from "../lib/monitor/deploy-stepper.js";

const STATE_LABEL: Record<DeployStepView["state"], string> = {
  done: "done",
  "in-progress": "in progress",
  pending: "pending",
};

const STATE_GLYPH: Record<DeployStepView["state"], string> = {
  done: "✓",
  "in-progress": "⟳",
  pending: "",
};

export function DeployStepper({
  steps,
  compact = false,
}: {
  steps: readonly DeployStepView[];
  compact?: boolean;
}) {
  return (
    <div
      className={"h4-stepper h4-deploy-stepper" + (compact ? " h4-deploy-stepper--compact" : "")}
      aria-label="Deploy verification steps"
    >
      {steps.map((step) => (
        <div key={step.id} className={`h4-stepper-row is-${step.state}`}>
          <span className="h4-stepper-dot" aria-hidden>
            {STATE_GLYPH[step.state]}
          </span>
          <span className="h4-stepper-label">{step.label}</span>
          <span className="h4-stepper-state">{STATE_LABEL[step.state]}</span>
          <span className="h4-stepper-source">{step.detail}</span>
        </div>
      ))}
    </div>
  );
}
