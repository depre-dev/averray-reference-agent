export interface TaskAgentDefinition {
  id: string;
  label: string;
  branchPrefix: string;
  greenfield: boolean;
  prBodyLabel: string;
  commitPrefix: string;
}

export interface SpecialistAgentDefinition extends TaskAgentDefinition {
  roleTitle: string;
  rolePrompt: string;
}

export const TEST_WRITER_AGENT_ID = "test-writer";
export const SECURITY_AGENT_ID = "security";
export const DOCS_AGENT_ID = "docs";

export const TEST_WRITER_ROLE_PROMPT = [
  "TEST-WRITER ROLE:",
  "- You are the internal Averray test-writer specialist.",
  "- Prefer adding or tightening tests, fixtures, and small test harness helpers.",
  "- Do not broaden production behavior unless a compile failure or test seam requires the smallest supporting change.",
  "- Keep edits scoped to the requested test-writing task and explain any non-test edit in the PR body.",
  "- Run the smallest relevant checks and leave merge/deploy decisions to the human gate.",
].join("\n");

export const SECURITY_ROLE_PROMPT = [
  "SECURITY ROLE:",
  "- You are the internal Averray security specialist.",
  "- Review and propose security-focused fixes for dependency CVEs, auth/session boundaries, secret handling, input validation, and operator safety.",
  "- Proposes-only: do not merge, deploy, rotate secrets, change live credentials, submit transactions, approve work, or take operational action.",
  "- For high-risk findings (secrets, auth bypass, chain/settlement, contracts, migrations, deploy-ops), stop implementation and escalate clearly to the operator with evidence and a proposed remediation plan.",
  "- For Polkadot, Substrate, Asset Hub, XCM, contract, fee, runtime, or settlement claims, verify with the polkadot-docs MCP plus on-chain/runtime or transaction evidence before relying on the claim.",
  "- Never print secrets, tokens, private keys, JWTs, or raw credential material; redact sensitive evidence.",
  "- Keep edits scoped to low-risk tests, docs, guardrails, or proposal artifacts unless the operator explicitly approved the implementation task.",
].join("\n");

export const DOCS_ROLE_PROMPT = [
  "DOCS ROLE:",
  "- You are the internal Averray docs specialist.",
  "- Propose documentation updates for changed product, runner, ops, API, monitor, or agent surfaces.",
  "- Prefer docs, runbooks, examples, changelog notes, and small wording corrections over runtime code.",
  "- Do not change production behavior unless a docs build/type seam requires the smallest supporting edit.",
  "- Call out stale or missing docs honestly; do not claim behavior is shipped unless code evidence proves it.",
  "- Run the smallest relevant checks and leave merge/deploy decisions to the human gate.",
].join("\n");

export function defineSpecialistAgent(input: SpecialistAgentDefinition): SpecialistAgentDefinition {
  const id = normalizeId(input.id);
  const branchPrefix = normalizeBranchPrefix(input.branchPrefix);
  if (!id) throw new Error("Specialist agent id is required.");
  if (!branchPrefix) throw new Error(`Specialist agent ${input.id} needs a branchPrefix.`);
  if (!input.rolePrompt.trim()) throw new Error(`Specialist agent ${input.id} needs a rolePrompt.`);
  return {
    ...input,
    id,
    branchPrefix,
  };
}

export const INTERNAL_SPECIALIST_AGENTS = [
  defineSpecialistAgent({
    id: TEST_WRITER_AGENT_ID,
    label: "Test-writer",
    branchPrefix: "test-writer",
    greenfield: true,
    prBodyLabel: "test-writer specialist",
    commitPrefix: "Test-writer task",
    roleTitle: "TEST-WRITER",
    rolePrompt: TEST_WRITER_ROLE_PROMPT,
  }),
  defineSpecialistAgent({
    id: SECURITY_AGENT_ID,
    label: "Security",
    branchPrefix: "security",
    greenfield: true,
    prBodyLabel: "security specialist",
    commitPrefix: "Security task",
    roleTitle: "SECURITY",
    rolePrompt: SECURITY_ROLE_PROMPT,
  }),
  defineSpecialistAgent({
    id: DOCS_AGENT_ID,
    label: "Docs",
    branchPrefix: "docs",
    greenfield: true,
    prBodyLabel: "docs specialist",
    commitPrefix: "Docs task",
    roleTitle: "DOCS",
    rolePrompt: DOCS_ROLE_PROMPT,
  }),
] as const;

export const TASK_AGENT_DEFINITIONS: readonly TaskAgentDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    branchPrefix: "codex",
    greenfield: false,
    prBodyLabel: "Codex worker",
    commitPrefix: "Codex task",
  },
  {
    id: "claude",
    label: "Claude",
    branchPrefix: "claude",
    greenfield: true,
    prBodyLabel: "Claude worker",
    commitPrefix: "Claude task",
  },
  ...INTERNAL_SPECIALIST_AGENTS,
];

export function taskAgentIds(): string[] {
  return TASK_AGENT_DEFINITIONS.map((agent) => agent.id);
}

export function knownTaskAgent(value: unknown): string | undefined {
  const id = normalizeId(value);
  return id && TASK_AGENT_DEFINITIONS.some((agent) => agent.id === id) ? id : undefined;
}

export function taskAgentDefinition(value: unknown): TaskAgentDefinition | undefined {
  const id = normalizeId(value);
  return id ? TASK_AGENT_DEFINITIONS.find((agent) => agent.id === id) : undefined;
}

export function specialistAgentDefinition(value: unknown): SpecialistAgentDefinition | undefined {
  const id = normalizeId(value);
  return id ? INTERNAL_SPECIALIST_AGENTS.find((agent) => agent.id === id) : undefined;
}

export function isGreenfieldTaskAgent(value: unknown): boolean {
  return taskAgentDefinition(value)?.greenfield === true;
}

export function taskAgentLabel(value: unknown): string {
  const id = normalizeId(value) || "codex";
  return taskAgentDefinition(id)?.label ?? labelFromId(id);
}

export function taskAgentBranchPrefix(value: unknown): string {
  const id = normalizeId(value) || "claude";
  return taskAgentDefinition(id)?.branchPrefix ?? normalizeBranchPrefix(id) ?? "agent";
}

export function taskAgentPrBodyLabel(value: unknown): string {
  const id = normalizeId(value) || "claude";
  return taskAgentDefinition(id)?.prBodyLabel ?? `${labelFromId(id)} worker`;
}

export function taskAgentCommitPrefix(value: unknown): string {
  const id = normalizeId(value) || "claude";
  return taskAgentDefinition(id)?.commitPrefix ?? `${labelFromId(id)} task`;
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeBranchPrefix(value: unknown): string {
  return normalizeId(value).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function labelFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("-");
}
