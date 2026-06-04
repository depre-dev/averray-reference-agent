// ORCH-P4b — Hermes router routine.
//
// This is the effectful, flag-gated companion to P4a's pure
// planAndRouteWork(...). It proposes queue entries and narrates them, but never
// approves, dispatches, merges, or deploys. The operator remains the gate.

import type { DispatchPolicyConfig, DispatchPolicyDecision } from "@avg/averray-mcp/dispatch-policy";
import { evaluateDispatchPolicy } from "@avg/averray-mcp/dispatch-policy";
import type { RoutingDecision, RoutingInput } from "@avg/averray-mcp/dispatch-routing";
import {
  planAndRouteWork,
  type PlanAndRouteWorkInput,
  type RoutedProposal,
  type WorkRouterBacklogItem,
  type WorkRouterRoutingScores,
} from "@avg/averray-mcp/work-router";
import type { CodexTask, CodexTaskInput } from "./codex-task-queue.js";

export interface HermesRouterConfig {
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  maxProposalsPerTick: number;
  lookbackMs: number;
}

export interface HermesRouterAuditRecord {
  surface: string;
  agent: string;
  riskTier: string;
  why: string;
  whyAgent: string;
  repo: string;
  dedupeKey: string;
  taskId?: string;
  action: "propose" | "skip";
  reason: "routed_proposal" | "duplicate_tick" | "open_task_exists" | "cooldown" | "dispatch_policy_blocked";
}

export interface HermesRouterDeps {
  getBacklog: () => Promise<WorkRouterBacklogItem[]> | WorkRouterBacklogItem[];
  listTasks: () => Promise<CodexTask[]> | CodexTask[];
  policy: () => DispatchPolicyConfig;
  classify: (input: RoutingInput) => Pick<RoutingDecision, "agent" | "riskTier" | "reason">;
  routingScores?: () => Promise<WorkRouterRoutingScores> | WorkRouterRoutingScores;
  plan?: (input: PlanAndRouteWorkInput) => RoutedProposal[];
  evaluatePolicy?: (config: DispatchPolicyConfig, input: Parameters<typeof evaluateDispatchPolicy>[1]) => DispatchPolicyDecision;
  propose: (input: CodexTaskInput) => Promise<{ task: CodexTask; created: boolean }> | { task: CodexTask; created: boolean };
  narrate: (proposal: RoutedProposal, task: CodexTask) => Promise<void> | void;
  audit: (record: HermesRouterAuditRecord) => Promise<void> | void;
  isSuspended: () => boolean;
  isHalt: () => boolean;
  inCooldown: (dedupeKey: string, nowMs: number) => boolean;
  markHandled: (dedupeKey: string, nowMs: number) => void;
  now: () => Date;
}

export interface HermesRouterResult {
  status: "disabled" | "paused" | "idle" | "proposed";
  reason?: "halt_present" | "autopilot_suspended" | "no_backlog_gap" | "no_policy_allowed_proposals";
  proposed: Array<{ taskId: string; dedupeKey: string; repo: string; agent: string; riskTier: string }>;
}

const ACTIVE_STATUSES = new Set(["proposed", "approved", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const HERMES_ROUTER_REQUESTER = "hermes-router";

export async function runHermesRouterOnce(config: HermesRouterConfig, deps: HermesRouterDeps): Promise<HermesRouterResult> {
  if (!config.enabled) return { status: "disabled", proposed: [] };
  if (deps.isHalt()) return { status: "paused", reason: "halt_present", proposed: [] };
  if (deps.isSuspended()) return { status: "paused", reason: "autopilot_suspended", proposed: [] };

  const now = deps.now();
  const nowMs = now.getTime();
  const tasks = await deps.listTasks();
  const backlog = await deps.getBacklog();
  const policy = deps.policy();
  const planner = deps.plan ?? planAndRouteWork;
  const evaluate = deps.evaluatePolicy ?? evaluateDispatchPolicy;
  const routingScores = deps.routingScores ? await deps.routingScores() : undefined;
  const routed = planner({
    backlog,
    inFlight: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).map(taskSnapshot),
    recentlyDone: tasks.filter((task) => isRecentlyDone(task, nowMs, config.lookbackMs)).map(taskSnapshot),
    policy: buildPolicySnapshot(policy, tasks, now),
    classify: deps.classify,
    ...(routingScores ? { routingScores } : {}),
    maxProposals: config.maxProposalsPerTick,
  });

  if (routed.length === 0) return { status: "idle", reason: "no_backlog_gap", proposed: [] };

  const proposed: HermesRouterResult["proposed"] = [];
  const seenThisTick = new Set<string>();
  const proposedRepoCounts = new Map<string, number>();
  let blockedByPolicy = 0;

  for (const proposal of routed) {
    if (proposed.length >= config.maxProposalsPerTick) break;
    if (seenThisTick.has(proposal.dedupeKey)) {
      await deps.audit(auditRecord(proposal, "skip", "duplicate_tick"));
      continue;
    }
    seenThisTick.add(proposal.dedupeKey);

    if (hasOpenTaskForProposal(tasks, proposal)) {
      deps.markHandled(proposal.dedupeKey, nowMs);
      await deps.audit(auditRecord(proposal, "skip", "open_task_exists"));
      continue;
    }

    if (deps.inCooldown(proposal.dedupeKey, nowMs)) {
      await deps.audit(auditRecord(proposal, "skip", "cooldown"));
      continue;
    }

    const counts = policyCountsFor(
      tasks,
      proposal.repo,
      now,
      proposed.length,
      proposedRepoCounts.get(proposal.repo) ?? 0,
    );
    const decision = evaluate(policy, {
      repo: proposal.repo,
      agent: proposal.agent,
      todayCount: counts.todayCount,
      todayRepoCount: counts.todayRepoCount,
    });
    if (!decision.allowed) {
      blockedByPolicy += 1;
      deps.markHandled(proposal.dedupeKey, nowMs);
      await deps.audit(auditRecord(proposal, "skip", "dispatch_policy_blocked"));
      continue;
    }

    const { task } = await deps.propose({
      repo: proposal.repo,
      surface: proposal.surface,
      agent: proposal.agent,
      riskTier: proposal.riskTier,
      routingReason: proposal.whyAgent,
      prompt: proposal.taskPrompt,
      title: `Hermes routed work: ${proposal.surface}`,
      reason: `${proposal.why} ${proposal.whyAgent}`,
      requester: HERMES_ROUTER_REQUESTER,
      correlationId: routerCorrelationId(proposal),
    });
    deps.markHandled(proposal.dedupeKey, nowMs);
    await deps.audit(auditRecord(proposal, "propose", "routed_proposal", task.id));
    await deps.narrate(proposal, task);
    proposed.push({
      taskId: task.id,
      dedupeKey: proposal.dedupeKey,
      repo: proposal.repo,
      agent: proposal.agent,
      riskTier: proposal.riskTier,
    });
    proposedRepoCounts.set(proposal.repo, (proposedRepoCounts.get(proposal.repo) ?? 0) + 1);
  }

  if (proposed.length > 0) return { status: "proposed", proposed };
  return {
    status: "idle",
    reason: blockedByPolicy > 0 ? "no_policy_allowed_proposals" : "no_backlog_gap",
    proposed: [],
  };
}

export function routerCorrelationId(proposal: Pick<RoutedProposal, "dedupeKey">): string {
  return `hermes-router:${proposal.dedupeKey}`;
}

export function fallbackHermesRouterNarration(proposal: RoutedProposal, task: Pick<CodexTask, "id">): string {
  return [
    `Hermes routed a backlog gap to ${proposal.agent}: ${proposal.surface}.`,
    `${proposal.why} Agent choice: ${proposal.whyAgent}.`,
    `I created proposed task ${task.id}; it will wait for operator approval and will not auto-run.`,
  ].join(" ");
}

function taskSnapshot(task: CodexTask): PlanAndRouteWorkInput["inFlight"][number] {
  return {
    repo: task.repo,
    status: task.status,
    ...(task.title ? { title: task.title } : {}),
    ...(task.surface ? { surface: task.surface } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(task.routingReason ? { area: task.routingReason } : {}),
  };
}

function isRecentlyDone(task: CodexTask, nowMs: number, lookbackMs: number): boolean {
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  const at = Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt ?? "");
  return Number.isFinite(at) && nowMs - at <= lookbackMs;
}

function buildPolicySnapshot(
  policy: DispatchPolicyConfig,
  tasks: readonly CodexTask[],
  now: Date,
): PlanAndRouteWorkInput["policy"] {
  const today = now.toISOString().slice(0, 10);
  const counted = tasks.filter((task) => isHermesProposedToday(task, today));
  const todayRepoCounts: Record<string, number> = {};
  for (const task of counted) todayRepoCounts[task.repo] = (todayRepoCounts[task.repo] ?? 0) + 1;
  return {
    allowedRepos: policy.allowedRepos,
    allowedAgents: policy.allowedAgents,
    perDayMax: policy.perDayMax,
    perRepoPerDayMax: policy.perRepoPerDayMax,
    todayCount: counted.length,
    todayRepoCounts,
  };
}

function policyCountsFor(
  tasks: readonly CodexTask[],
  repo: string,
  now: Date,
  acceptedThisTick: number,
  acceptedForRepoThisTick: number,
): { todayCount: number; todayRepoCount: number } {
  const today = now.toISOString().slice(0, 10);
  const counted = tasks.filter((task) => isHermesProposedToday(task, today));
  return {
    todayCount: counted.length + acceptedThisTick,
    todayRepoCount: counted.filter((task) => task.repo === repo).length + acceptedForRepoThisTick,
  };
}

function isHermesProposedToday(task: CodexTask, today: string): boolean {
  if (!task.createdAt?.startsWith(today)) return false;
  const requester = (task.requester ?? "").toLowerCase();
  if (!requester.startsWith("hermes")) return false;
  return !TERMINAL_STATUSES.has(task.status) || task.status === "completed";
}

function hasOpenTaskForProposal(tasks: readonly CodexTask[], proposal: RoutedProposal): boolean {
  const correlationId = routerCorrelationId(proposal);
  return tasks.some((task) =>
    task.correlationId === correlationId
    && !TERMINAL_STATUSES.has(task.status)
  );
}

function auditRecord(
  proposal: RoutedProposal,
  action: HermesRouterAuditRecord["action"],
  reason: HermesRouterAuditRecord["reason"],
  taskId?: string,
): HermesRouterAuditRecord {
  return {
    surface: proposal.surface,
    agent: proposal.agent,
    riskTier: proposal.riskTier,
    why: proposal.why,
    whyAgent: proposal.whyAgent,
    repo: proposal.repo,
    dedupeKey: proposal.dedupeKey,
    action,
    reason,
    ...(taskId ? { taskId } : {}),
  };
}
