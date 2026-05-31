// O4 — the dispatch guardrail (NEW; deliberately separate from
// mutation-policy.ts, which governs claim/submit).
//
// Hermes gains the power to PROPOSE agent tasks (enqueue_agent_task). Per
// AGENTS.md invariant #6, a new power ships with an allowlist + budget + human
// approval. This module is the allowlist + budget half; the human-approval half
// is the unchanged operator gate (approveCodexTask) — this PR proposes only,
// never approves.
//
// FAIL-CLOSED: an empty/malformed allowlist denies everything (Hermes can
// propose nothing until the operator opts repos in) — never allow-all.

import { optionalEnv, readYamlFile } from "@avg/mcp-common";

export interface DispatchPolicyConfig {
  /** Repos Hermes may propose work in. EMPTY ⇒ deny everything (fail-closed). */
  allowedRepos: string[];
  /** Agents Hermes may propose to. Defaults to codex + claude. */
  allowedAgents: string[];
  /** Max Hermes-proposed tasks per day across all repos. */
  perDayMax: number;
  /** Max per repo per day. 0 ⇒ no per-repo cap (only the global cap applies). */
  perRepoPerDayMax: number;
  /** Max recorded LLM cost per day. 0 ⇒ disabled until the operator opts in. */
  perDayUsdMax: number;
}

export interface DispatchPolicyInput {
  repo: string;
  agent: string;
  /** Hermes-proposed tasks already created today (all repos). */
  todayCount: number;
  /** Hermes-proposed tasks already created today for `repo`. */
  todayRepoCount: number;
  /** Recorded LLM usage spend for today, if available from A1/A3 counters. */
  todayCostUsd?: number | null;
  /** Recorded average cost estimate for the selected agent, if available. */
  estimatedTaskCostUsd?: number | null;
}

export interface DispatchPolicyDecision {
  allowed: boolean;
  reason: string;
}

interface DispatchYamlBlock {
  allowed_repos?: unknown;
  allowed_agents?: unknown;
  per_day_max?: unknown;
  per_repo_per_day_max?: unknown;
  per_day_usd_max?: unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

function positiveIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Load the dispatch guardrail from the `dispatch:` block of policy.yaml, with
 * env overrides. Defaults are fail-closed: an absent/empty allowed_repos denies
 * everything. allowed_agents defaults to codex + claude.
 */
export function loadDispatchPolicyConfig(env: NodeJS.ProcessEnv = process.env): DispatchPolicyConfig {
  const yaml = readYamlFile<{ dispatch?: DispatchYamlBlock }>(
    optionalEnv("POLICY_CONFIG_PATH", "/config/policy.yaml") ?? "/config/policy.yaml",
    {},
  );
  const block = yaml.dispatch ?? {};

  // Env override for repos (comma/space-separated) when present; else the yaml.
  const envRepos = env.HERMES_DISPATCH_ALLOWED_REPOS;
  const allowedRepos = envRepos !== undefined
    ? envRepos.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean)
    : stringArray(block.allowed_repos);

  const allowedAgents = stringArray(block.allowed_agents);
  return {
    allowedRepos,
    allowedAgents: allowedAgents.length > 0 ? allowedAgents : ["codex", "claude"],
    perDayMax: positiveIntOr(env.HERMES_DISPATCH_PER_DAY_MAX ?? block.per_day_max, 10),
    perRepoPerDayMax: positiveIntOr(env.HERMES_DISPATCH_PER_REPO_PER_DAY_MAX ?? block.per_repo_per_day_max, 5),
    perDayUsdMax: positiveNumberOr(env.HERMES_DISPATCH_PER_DAY_USD_MAX ?? block.per_day_usd_max, 0),
  };
}

/**
 * Decide whether Hermes may propose this task. Pure: the caller supplies the
 * already-counted daily totals (derived from the task queue). Fail-closed.
 */
export function evaluateDispatchPolicy(
  config: DispatchPolicyConfig,
  input: DispatchPolicyInput,
): DispatchPolicyDecision {
  if (!Array.isArray(config.allowedRepos) || config.allowedRepos.length === 0) {
    return { allowed: false, reason: "dispatch_allowlist_empty" };
  }
  const repo = (input.repo ?? "").trim();
  if (!repo) return { allowed: false, reason: "repo_required" };
  if (!config.allowedRepos.includes(repo)) {
    return { allowed: false, reason: "repo_not_allowed" };
  }
  const agent = (input.agent ?? "").trim();
  if (!config.allowedAgents.includes(agent)) {
    return { allowed: false, reason: "agent_not_allowed" };
  }
  if (input.todayCount >= config.perDayMax) {
    return { allowed: false, reason: "daily_budget_exhausted" };
  }
  if (config.perRepoPerDayMax > 0 && input.todayRepoCount >= config.perRepoPerDayMax) {
    return { allowed: false, reason: "repo_daily_budget_exhausted" };
  }
  if (config.perDayUsdMax > 0) {
    if (input.todayCostUsd === null || input.todayCostUsd === undefined
      || input.estimatedTaskCostUsd === null || input.estimatedTaskCostUsd === undefined) {
      return { allowed: true, reason: "dispatch_allowed_cost_unmeasured" };
    }
    if (input.todayCostUsd + input.estimatedTaskCostUsd > config.perDayUsdMax) {
      return { allowed: false, reason: "daily_cost_budget_exhausted" };
    }
  }
  return { allowed: true, reason: "dispatch_allowed" };
}

function positiveNumberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
