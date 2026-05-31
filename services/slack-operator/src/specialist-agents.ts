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

export const TEST_WRITER_ROLE_PROMPT = [
  "TEST-WRITER ROLE:",
  "- You are the internal Averray test-writer specialist.",
  "- Prefer adding or tightening tests, fixtures, and small test harness helpers.",
  "- Do not broaden production behavior unless a compile failure or test seam requires the smallest supporting change.",
  "- Keep edits scoped to the requested test-writing task and explain any non-test edit in the PR body.",
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
