import { agentTaskV1Schema, type AgentTaskV1 } from "./agent-task.js";

export type CanonicalContractValue =
  | null
  | boolean
  | number
  | string
  | CanonicalContractValue[]
  | { [key: string]: CanonicalContractValue };

export function canonicalContractJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value, new Set<object>()));
}

export async function hashCanonicalContract(value: unknown): Promise<`sha256:${string}`> {
  const serialized = canonicalContractJson(value);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function agentTaskApprovalPayload(taskInput: AgentTaskV1): CanonicalContractValue {
  const task = agentTaskV1Schema.parse(taskInput);
  return toCanonicalValue({
    schemaVersion: task.schemaVersion,
    kind: task.kind,
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    correlationId: task.correlationId,
    taskKind: task.taskKind,
    proposal: task.proposal,
    repository: task.repository,
    intent: task.intent,
    acceptance: task.acceptance,
    risk: task.risk,
    requestedAuthority: task.requestedAuthority,
    budget: task.budget,
    deadline: task.deadline,
    executor: task.executor,
    policyVersion: task.approval.policyVersion,
    policyHash: task.approval.policyHash,
  }, new Set<object>());
}

export async function hashAgentTaskApprovalPayload(
  task: AgentTaskV1,
): Promise<`sha256:${string}`> {
  return hashCanonicalContract(agentTaskApprovalPayload(task));
}

export async function agentTaskApprovalHashMatches(task: AgentTaskV1): Promise<boolean> {
  if (task.approval.status !== "approved" || !task.approval.approvedTaskHash) return false;
  return task.approval.approvedTaskHash === await hashAgentTaskApprovalPayload(task);
}

function toCanonicalValue(value: unknown, seen: Set<object>): CanonicalContractValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical contracts reject non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("canonical contracts reject cyclic values");
    seen.add(value);
    const result = value.map((item) => toCanonicalValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("canonical contracts reject cyclic values");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical contracts accept only plain objects");
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, CanonicalContractValue> = {};
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const field = record[key];
      if (field === undefined) {
        throw new TypeError(`canonical contracts reject undefined field: ${key}`);
      }
      result[key] = toCanonicalValue(field, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`canonical contracts reject ${typeof value} values`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
