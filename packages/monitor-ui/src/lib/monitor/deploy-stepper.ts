import type { CardCheckRun, CardChecks, DeployCard } from "./card-types.js";

export type DeployStepId =
  | "ci-queued"
  | "install"
  | "unit-tests"
  | "browser-replay"
  | "hermes-review"
  | "ready";

export type DeployStepState = "done" | "in-progress" | "pending";

export interface DeployStepView {
  id: DeployStepId;
  label: string;
  state: DeployStepState;
  detail: string;
}

export const DEPLOY_STEPS: readonly { id: DeployStepId; label: string }[] = [
  { id: "ci-queued", label: "CI queued" },
  { id: "install", label: "install" },
  { id: "unit-tests", label: "unit tests" },
  { id: "browser-replay", label: "browser replay" },
  { id: "hermes-review", label: "Hermes review" },
  { id: "ready", label: "ready" },
];

type DeployStepperSource = Pick<DeployCard, "checkRuns" | "checks" | "verification" | "deploySteps">;

const AWAITING_DATA = "awaiting data";

const STEP_MATCHERS: Record<DeployStepId, RegExp[]> = {
  "ci-queued": [
    /\bci\b.*\bqueue[du]?\b/i,
    /\bqueue[du]?\b.*\bci\b/i,
    /\bgithub actions?\b/i,
    /\bworkflow\b/i,
    /\bdeploy production\b/i,
  ],
  install: [
    /\binstall\b/i,
    /\bnpm ci\b/i,
    /\bsetup node\b/i,
    /\bdependencies\b/i,
  ],
  "unit-tests": [
    /\bunit\b/i,
    /\bunit tests?\b/i,
    /\bnpm test\b/i,
    /\bvitest\b/i,
  ],
  "browser-replay": [
    /\bbrowser replay\b/i,
    /\bbrowser\b/i,
    /\bplaywright\b/i,
    /\btestbed\b/i,
    /\bsmoke\b/i,
  ],
  "hermes-review": [
    /\bhermes\b.*\breview\b/i,
    /\breview\b.*\bhermes\b/i,
    /\bhermes checking\b/i,
    /\bpost[-_\s]?deploy verification\b/i,
  ],
  ready: [
    /\bready\b/i,
    /\bdeploy ok\b/i,
    /\bpost[_-\s]?deploy[_-\s]?healthy\b/i,
  ],
};

const STATUS_WEIGHT: Record<DeployStepState, number> = {
  pending: 0,
  "in-progress": 1,
  done: 2,
};

export function deployStepsForCard(card: DeployStepperSource): DeployStepView[] {
  const steps = new Map<DeployStepId, DeployStepView>(
    DEPLOY_STEPS.map((step) => [
      step.id,
      {
        ...step,
        state: "pending",
        detail: AWAITING_DATA,
      },
    ]),
  );

  const explicitStepIds = applyExplicitDeploySteps(steps, card.deploySteps);
  applyCheckRuns(steps, card.checkRuns, explicitStepIds);
  applyAggregateChecks(steps, card.checks, card.checkRuns, explicitStepIds);
  applyLegacyVerificationLabel(steps, card.verification, explicitStepIds);

  return DEPLOY_STEPS.map((step) => steps.get(step.id)!);
}

function applyExplicitDeploySteps(steps: Map<DeployStepId, DeployStepView>, rawSteps: unknown): Set<DeployStepId> {
  const explicitStepIds = new Set<DeployStepId>();
  if (!Array.isArray(rawSteps)) return explicitStepIds;
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = stepIdFromString(stringField(record.id) ?? stringField(record.label) ?? stringField(record.name));
    if (!id) continue;
    const state = normalizeExplicitState(stringField(record.state) ?? stringField(record.status));
    const detail = stringField(record.detail) ?? stringField(record.source) ?? "deploy step";
    mergeStep(steps, id, { state, detail });
    explicitStepIds.add(id);
  }
  return explicitStepIds;
}

function applyCheckRuns(
  steps: Map<DeployStepId, DeployStepView>,
  checkRuns: CardCheckRun[] | undefined,
  explicitStepIds: Set<DeployStepId>,
): void {
  if (!checkRuns || checkRuns.length === 0) return;
  if (!explicitStepIds.has("ci-queued")) {
    mergeStep(steps, "ci-queued", {
      state: "done",
      detail: `${checkRuns.length} check run${checkRuns.length === 1 ? "" : "s"} reported`,
    });
  }

  for (const step of DEPLOY_STEPS) {
    if (explicitStepIds.has(step.id)) continue;
    const matching = checkRuns.filter((run) => stepMatchesName(step.id, run.name));
    if (matching.length === 0) continue;
    mergeStep(steps, step.id, stateFromCheckRuns(matching));
  }
}

function applyAggregateChecks(
  steps: Map<DeployStepId, DeployStepView>,
  checks: CardChecks | undefined,
  checkRuns: CardCheckRun[] | undefined,
  explicitStepIds: Set<DeployStepId>,
): void {
  if (!checks || checks.total <= 0 || (checkRuns && checkRuns.length > 0) || explicitStepIds.has("ci-queued")) return;
  mergeStep(steps, "ci-queued", {
    state: "done",
    detail: `${checks.total} aggregate check${checks.total === 1 ? "" : "s"} reported`,
  });
}

function applyLegacyVerificationLabel(
  steps: Map<DeployStepId, DeployStepView>,
  verification: DeployCard["verification"] | undefined,
  explicitStepIds: Set<DeployStepId>,
): void {
  const label = verification?.label?.trim();
  if (!label) return;
  const id = stepIdFromString(label);
  if (!id) return;
  if (explicitStepIds.has(id)) return;
  mergeStep(steps, id, {
    state: "in-progress",
    detail: `legacy verification label: ${label}`,
  });
}

function stateFromCheckRuns(checkRuns: CardCheckRun[]): { state: DeployStepState; detail: string } {
  const names = checkRuns.map((run) => run.name).join(", ");
  if (checkRuns.some((run) => run.status === "running")) {
    return { state: "in-progress", detail: names };
  }
  if (checkRuns.some((run) => run.status === "fail")) {
    return { state: "pending", detail: `failed: ${names}` };
  }
  if (checkRuns.some((run) => run.status === "pass")) {
    return { state: "done", detail: names };
  }
  return { state: "pending", detail: names };
}

function normalizeExplicitState(value: string | undefined): DeployStepState {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "done" || normalized === "pass" || normalized === "passed" || normalized === "success") return "done";
  if (normalized === "current" || normalized === "running" || normalized === "in_progress" || normalized === "in-progress") return "in-progress";
  return "pending";
}

function mergeStep(
  steps: Map<DeployStepId, DeployStepView>,
  id: DeployStepId,
  update: { state: DeployStepState; detail: string },
): void {
  const current = steps.get(id);
  if (!current) return;
  if (STATUS_WEIGHT[update.state] < STATUS_WEIGHT[current.state]) return;
  steps.set(id, {
    ...current,
    state: update.state,
    detail: update.detail || current.detail,
  });
}

function stepMatchesName(id: DeployStepId, name: string): boolean {
  return STEP_MATCHERS[id].some((matcher) => matcher.test(name));
}

function stepIdFromString(value: string | undefined): DeployStepId | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return DEPLOY_STEPS.find((step) => normalized.toLowerCase() === step.label.toLowerCase())?.id
    ?? DEPLOY_STEPS.find((step) => stepMatchesName(step.id, normalized))?.id;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
