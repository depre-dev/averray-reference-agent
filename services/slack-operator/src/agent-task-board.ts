import {
  agentTaskV1Schema,
  toLegacyAgentTaskCompatibilityView,
  type AgentTaskV1,
} from "@avg/schemas";

import type { CodexTask, CodexTaskStatus } from "./codex-task-queue.js";

export interface AgentTaskBoardItem extends Record<string, unknown> {
  id: string;
  workItemId: string;
  sourceKind: "agent_task" | "codex_task";
  status: CodexTaskStatus;
  repo: string;
  prompt: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  nonDispatchable: boolean;
}

export interface DualReadTaskCounts {
  total: number;
  proposed: number;
  approved: number;
  running: number;
  terminal: number;
}

const TERMINAL_STATUSES = new Set<CodexTaskStatus>(["completed", "failed", "cancelled"]);

export function mergeAgentTaskBoardItems(
  legacyInputs: readonly CodexTask[],
  agentTaskInputs: readonly AgentTaskV1[],
  limit = 100,
): AgentTaskBoardItem[] {
  const legacyItems = legacyInputs.map(legacyTaskBoardItem);
  const latestAgentItems = latestAgentTaskItems(agentTaskInputs);
  const agentWorkItemIds = new Set(latestAgentItems.map((item) => item.workItemId));
  return [
    ...latestAgentItems,
    ...legacyItems.filter((item) => !agentWorkItemIds.has(item.workItemId)),
  ]
    .sort((left, right) => {
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updated !== 0 ? updated : left.workItemId.localeCompare(right.workItemId);
    })
    .slice(0, normalizedLimit(limit));
}

export function countAgentTaskBoardItems(
  items: readonly AgentTaskBoardItem[],
): DualReadTaskCounts {
  return {
    total: items.length,
    proposed: items.filter((task) => task.status === "proposed").length,
    approved: items.filter((task) => task.status === "approved").length,
    running: items.filter((task) => task.status === "running").length,
    terminal: items.filter((task) => TERMINAL_STATUSES.has(task.status)).length,
  };
}

function legacyTaskBoardItem(task: CodexTask): AgentTaskBoardItem {
  const compatibility = toLegacyAgentTaskCompatibilityView(task);
  return {
    ...task,
    agent: task.agent ?? compatibility.executor.directAgent,
    workItemId: compatibility.workItemId,
    sourceKind: compatibility.sourceKind,
    nonDispatchable: compatibility.nonDispatchable,
    missingRequiredAgentTaskFields: compatibility.missingRequiredAgentTaskFields,
  };
}

function latestAgentTaskItems(inputs: readonly AgentTaskV1[]): AgentTaskBoardItem[] {
  const latest = new Map<string, AgentTaskV1>();
  for (const input of inputs) {
    const task = agentTaskV1Schema.parse(input);
    const current = latest.get(task.workItemId);
    if (
      !current
      || task.taskVersion > current.taskVersion
      || (
        task.taskVersion === current.taskVersion
        && Date.parse(task.timestamps.updatedAt) > Date.parse(current.timestamps.updatedAt)
      )
    ) {
      latest.set(task.workItemId, task);
    }
  }
  return [...latest.values()].map(agentTaskBoardItem);
}

function agentTaskBoardItem(task: AgentTaskV1): AgentTaskBoardItem {
  const directAgent = task.executor.kind === "direct" ? task.executor.directAgent : "harness";
  const dispatchable = task.executor.kind === "harness"
    && task.lifecycle === "approved"
    && task.approval.approvedTaskHash !== undefined;
  return {
    id: task.workItemId,
    workItemId: task.workItemId,
    sourceKind: "agent_task",
    schemaVersion: task.schemaVersion,
    kind: task.kind,
    taskVersion: task.taskVersion,
    correlationId: task.correlationId,
    status: legacyBoardStatus(task.lifecycle),
    agentTaskLifecycle: task.lifecycle,
    repo: task.repository.nameWithOwner,
    title: task.proposal.title,
    prompt: task.proposal.objective,
    reason: task.proposal.whyNow,
    requester: `${task.proposal.requestedBy.type}:${task.proposal.requestedBy.id}`,
    agent: directAgent,
    riskTier: task.risk.tier === "low" ? "low" : "high",
    agentTaskRiskTier: task.risk.tier,
    routingReason: task.executor.selectionReason,
    createdAt: task.proposal.createdAt,
    updatedAt: task.timestamps.updatedAt,
    ...(task.timestamps.approvedAt ? { approvedAt: task.timestamps.approvedAt } : {}),
    nonDispatchable: !dispatchable,
    dispatchable,
  };
}

function legacyBoardStatus(lifecycle: AgentTaskV1["lifecycle"]): CodexTaskStatus {
  switch (lifecycle) {
    case "proposed":
      return "proposed";
    case "approved":
      return "approved";
    case "dispatching":
    case "running":
    case "verifying":
      return "running";
    case "handoff_ready":
      return "completed";
    case "blocked":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
  throw new Error(`Unsupported AgentTask lifecycle: ${lifecycle satisfies never}`);
}

function normalizedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("AgentTask board limit must be a positive safe integer");
  }
  return value;
}
