import type { AdminActionKind } from "./operator-admin.js";
import { getProjectMemory, type ProjectMemoryEntry } from "./operator-project-memory.js";

export interface ProjectRunbookInput {
  action?: AdminActionKind;
  project?: string;
  query?: string;
}

export interface RunbookTemplate {
  goal: string;
  trigger: string;
  requiredEvidence: string[];
  operatorSteps: string[];
  stopConditions: string[];
  postActionVerification: string[];
  rollbackNotes: string[];
}

export function getProjectRunbook(input: ProjectRunbookInput = {}) {
  const generatedAt = new Date().toISOString();
  const action = normalizeAction(input.action, input.query);
  const memory = getProjectMemory({ project: input.project, query: input.query });
  const selectedProject = projectFromMemory(memory);
  const template = runbookForAction(action, selectedProject);
  const projectName = selectedProject?.name ?? input.project ?? "unknown project";

  return {
    schemaVersion: 1,
    kind: "project_admin_runbook",
    generatedAt,
    mutates: false,
    action,
    target: {
      project: selectedProject?.id ?? null,
      name: selectedProject?.name ?? null,
      repos: selectedProject?.repos ?? [],
      requestedProject: input.project ?? null,
      requestedQuery: input.query ?? null,
    },
    title: `${titleCase(action)} runbook - ${projectName}`,
    project: selectedProject ? projectSummary(selectedProject) : null,
    runbook: template,
    suggestedHermesCommands: suggestedHermesCommands(action, selectedProject),
    safety: {
      readOnly: true,
      mutates: false,
      proposalOnly: true,
      approvalRequired: true,
      secretsIncluded: false,
      githubMutated: false,
      deployTriggered: false,
      serviceRestarted: false,
      rollbackTriggered: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

function normalizeAction(action: AdminActionKind | undefined, query: string | undefined): AdminActionKind {
  if (action && action !== "unknown") return action;
  const normalized = String(query ?? "").toLowerCase();
  if (/\bsecret|token|credential|jwt\b/.test(normalized)) return "secret_rotation";
  if (/\brollback|roll back|revert\b/.test(normalized)) return "rollback";
  if (/\brestart|recreate\b/.test(normalized)) return "restart";
  if (/\bdeploy|release|ship\b/.test(normalized)) return "deploy";
  if (/\bmerge|pull request|pr\b/.test(normalized)) return "merge";
  return "unknown";
}

function projectFromMemory(memory: ReturnType<typeof getProjectMemory>): ProjectMemoryEntry | undefined {
  return "selectedProject" in memory ? memory.selectedProject : undefined;
}

function runbookForAction(action: AdminActionKind, project: ProjectMemoryEntry | undefined): RunbookTemplate {
  if (action === "merge") return mergeRunbook(project);
  if (action === "deploy") return deployRunbook(project);
  if (action === "rollback") return rollbackRunbook(project);
  if (action === "secret_rotation") return secretRotationRunbook(project);
  if (action === "restart") return restartRunbook(project);
  return genericRunbook(project);
}

function mergeRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  const repo = primaryRepo(project);
  return {
    goal: "Decide whether a pull request is ready for a human merge approval.",
    trigger: "A PR has green CI and the author asks for review, merge, or release readiness.",
    requiredEvidence: [
      "GitHub CI and merge queue checks are green.",
      "Hermes PR handoff verdict is ok_to_merge, or every needs_review / hold reason has a human resolution.",
      "Changed files match the stated PR scope and required tests.",
      "PR notes mention affected surfaces: backend, frontend, indexer, Caddy, contracts, public site, or docs.",
      "Rollback/deploy notes are present when deployment or ops files changed.",
    ],
    operatorSteps: [
      repo ? `Run \`github status\` and inspect ${repo} PR status.` : "Run `github status` and inspect PR status.",
      "Open the handoff monitor and read the latest PR handoff card.",
      "If high-risk files changed, ask for explicit human review before merge.",
      "Use `propose merge for owner/repo#PR` to get a proposal-only admin recommendation.",
      "Merge manually only after the human owner approves the evidence.",
    ],
    stopConditions: [
      "Any required CI or merge queue check is failing, cancelled, or still running.",
      "Hermes says hold/block, or the handoff monitor shows unresolved risks.",
      "Secrets, contract deployment, production config, or generated assets changed without explicit notes.",
    ],
    postActionVerification: [
      "Confirm the merge landed on main.",
      "Watch production deploy workflow if this repo auto-deploys on main.",
      "Check the handoff monitor for post-deploy verification if a deploy starts.",
    ],
    rollbackNotes: [
      "A merge rollback is usually a revert PR, not a force push.",
      "If production breaks after merge, follow the deploy/rollback runbook instead of retrying blindly.",
    ],
  };
}

function deployRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  const deploy = project?.deploy ?? {};
  return {
    goal: "Ship a known commit and verify production is healthy afterward.",
    trigger: stringField(deploy, "trigger") ?? "A human owner decides a commit or PR should be released.",
    requiredEvidence: [
      "Target commit is known and points at the intended branch or release.",
      "CI is green for the target commit.",
      "No open blocker in `github status`, `handoff monitor`, or `ops health`.",
      stringField(deploy, "knownSecretRotation")
        ? `Known secret/token state checked: ${stringField(deploy, "knownSecretRotation")}`
        : "Required deploy credentials/secrets are present and not pasted into Hermes.",
      "Rollback path is known before starting the deploy.",
    ],
    operatorSteps: [
      stringField(deploy, "workflow")
        ? `Trigger or watch GitHub workflow \`${stringField(deploy, "workflow")}\` when applicable.`
        : "Trigger or watch the documented deploy workflow.",
      stringField(deploy, "script")
        ? `On the VPS, the deploy script is \`${stringField(deploy, "script")}\`.`
        : "",
      stringField(deploy, "command")
        ? `Manual deploy command: \`${stringField(deploy, "command")}\`.`
        : "",
      "Keep deployment serialized; do not start a second deploy while one is active.",
      "After deploy completes, run the read-only Hermes post-deploy testbed suite.",
    ].filter(Boolean),
    stopConditions: [
      "Deploy workflow is already running or locked.",
      "Required token/JWT/credential is expired or missing.",
      "CI is not green for the target commit.",
      "Recent post-deploy checks failed and have not been explained.",
    ],
    postActionVerification: [
      "Check deploy workflow result.",
      "Run `run testbed e2e read-only` or the configured post-deploy suite.",
      "Check `ops health`, `github status`, and the handoff monitor.",
      "Verify public app/API URLs listed in project memory if applicable.",
    ],
    rollbackNotes: [
      "Rollback requires explicit human approval.",
      "Prefer the project’s rollback workflow or redeploying a known-good commit.",
      "Capture failure command/logs before rollback so the cause is not lost.",
    ],
  };
}

function rollbackRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  return {
    goal: "Return production to a known-good state with an audit trail.",
    trigger: "A deploy is unhealthy, customer-facing behavior regressed, or a human owner requests rollback.",
    requiredEvidence: [
      "Current bad deploy SHA/run is identified.",
      "Known-good SHA/run is identified.",
      "Failure symptom and first failing check/log are captured.",
      "Human owner explicitly approves rollback.",
      project ? `Project memory reviewed for ${project.name}.` : "Project memory reviewed for the target project.",
    ],
    operatorSteps: [
      "Freeze new deploy attempts until rollback decision is clear.",
      "Collect deploy workflow URL, failing check, and relevant health output.",
      "Use `propose rollback for owner/repo sha <known-good-sha>` for an advisory recommendation.",
      "Execute rollback manually through the project’s documented deploy/rollback path.",
    ],
    stopConditions: [
      "No known-good target is available.",
      "The issue is a secret/config outage that rollback will not fix.",
      "The rollback itself would deploy contracts, move funds, or change DNS without a separate plan.",
    ],
    postActionVerification: [
      "Run post-deploy verification against the rollback target.",
      "Confirm GitHub/deploy status and app/API health.",
      "Record the bad deploy, rollback target, and remaining follow-up.",
    ],
    rollbackNotes: [
      "Rollback is itself a mutation and must be approved outside this runbook.",
      "Hermes can propose and verify, but should not execute rollback yet.",
    ],
  };
}

function secretRotationRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  return {
    goal: "Rotate a credential without exposing it to Hermes or chat logs.",
    trigger: "A token expires, is suspected compromised, or needs scheduled rotation.",
    requiredEvidence: [
      "Secret name and owning system are identified.",
      "Consumer services/workflows that depend on the secret are listed.",
      "A rollback/recovery path exists if the new secret fails.",
      "New secret value is handled only in approved secret stores, never pasted into Hermes/Slack.",
      project ? `Project owner known: ${project.owner}.` : "Project owner is identified.",
    ],
    operatorSteps: [
      "Pause deploys or workflows that depend on the expiring secret if needed.",
      "Generate or obtain the new secret in the provider UI/CLI.",
      "Update GitHub/VPS/Cloudflare/Slack secret stores directly; do not send the value to Hermes.",
      "Restart or rerun only the affected workflow/service.",
      "Ask Hermes to verify via read-only health checks after rotation.",
    ],
    stopConditions: [
      "You cannot identify all consumers of the secret.",
      "The secret value appears in chat, logs, PRs, or shell history.",
      "There is no way to verify the new secret safely.",
    ],
    postActionVerification: [
      "Run affected workflow or health check.",
      "Confirm no auth errors remain.",
      "Record that rotation happened without storing the secret value.",
    ],
    rollbackNotes: [
      "Keep the old credential valid only until verification succeeds, when provider policy allows.",
      "If the new credential fails, restore from the secure provider/store, not from Hermes output.",
    ],
  };
}

function restartRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  return {
    goal: "Restart only the affected service with minimal blast radius.",
    trigger: "A service is unhealthy and read-only checks suggest a restart may clear the condition.",
    requiredEvidence: [
      "Affected service/container is identified.",
      "Current health/log symptom is captured.",
      "No deploy or migration is already running.",
      "Restart command and expected health endpoint are known.",
      project ? `Project memory reviewed for ${project.name}.` : "Project memory reviewed for the target project.",
    ],
    operatorSteps: [
      "Run read-only health/log checks first.",
      "Prefer targeted service restart/recreate over whole-stack restart.",
      "Watch logs and health for the affected service.",
      "Escalate to deploy/rollback runbook if restart does not resolve it.",
    ],
    stopConditions: [
      "Database migration, deploy, or backup is active.",
      "Restart would drop in-flight work with no recovery plan.",
      "The root issue is expired credentials or config drift.",
    ],
    postActionVerification: [
      "Health endpoint returns ok.",
      "Recent errors stop increasing.",
      "Operator surfaces still work.",
    ],
    rollbackNotes: [
      "A restart rollback is usually another targeted restart or deploy rollback if new code caused it.",
    ],
  };
}

function genericRunbook(project: ProjectMemoryEntry | undefined): RunbookTemplate {
  return {
    goal: "Prepare a safe admin action with human approval.",
    trigger: "A human or agent asks whether a project-admin action is ready.",
    requiredEvidence: [
      "Action type is explicit: merge, deploy, rollback, secret_rotation, or restart.",
      "Target project/repo/environment is identified.",
      "Read-only health/GitHub/handoff evidence has been checked.",
      "Human owner approval path is known.",
    ],
    operatorSteps: [
      project ? `Start from project memory for ${project.name}.` : "Run `project memory` to identify the target project.",
      "Pick a specific runbook: merge, deploy, rollback, secret rotation, or restart.",
      "Use an admin proposal command before any mutation.",
    ],
    stopConditions: [
      "The requested action is ambiguous.",
      "The action would expose or change secrets through chat.",
      "The action affects contracts, funds, DNS, or production config without a separate plan.",
    ],
    postActionVerification: [
      "Use read-only status checks appropriate to the selected action.",
    ],
    rollbackNotes: [
      "No mutation should happen from the generic runbook.",
    ],
  };
}

function suggestedHermesCommands(action: AdminActionKind, project: ProjectMemoryEntry | undefined) {
  const repo = primaryRepo(project) ?? "owner/repo";
  if (action === "merge") return [`propose merge for ${repo}#<PR>`, "github status", "handoff monitor"];
  if (action === "deploy") return [`propose deploy for ${repo} sha <SHA>`, "run testbed e2e read-only", "ops health"];
  if (action === "rollback") return [`propose rollback for ${repo} sha <KNOWN_GOOD_SHA>`, "ops health", "handoff monitor"];
  if (action === "secret_rotation") return ["propose secret rotation", "ops health", "github status"];
  if (action === "restart") return ["ops health", "handoff monitor"];
  return ["project memory", "admin readiness", "admin proposal"];
}

function projectSummary(project: ProjectMemoryEntry) {
  return {
    id: project.id,
    name: project.name,
    repos: project.repos,
    owner: project.owner,
    role: project.role,
  };
}

function primaryRepo(project: ProjectMemoryEntry | undefined) {
  return project?.repos[0];
}

function titleCase(action: AdminActionKind) {
  return action.split("_").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
