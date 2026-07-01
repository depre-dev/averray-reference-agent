import type { DispatchPolicyConfig } from "./dispatch-policy.js";
import type { RoutingDecision, RoutingInput, RiskTier } from "./dispatch-routing.js";
import type { HermesBacklogItem } from "./hermes-backlog.js";

export type RoutedWorkAgent = "codex" | "claude";
export type RoutedWorkStatus = "proposed" | "approved" | "running" | "completed" | "failed" | "cancelled" | string;
export type WorkRouterRoutingScoreStatus = "baseline_available" | "insufficient_data";

export interface WorkRouterRoutingScore {
  status: WorkRouterRoutingScoreStatus;
  score: number | null;
  samples: number;
  reason?: string;
}

export type WorkRouterRoutingScores = Record<string, Partial<Record<RoutedWorkAgent, WorkRouterRoutingScore>>>;

export interface WorkRouterBacklogItem extends Partial<Pick<HermesBacklogItem, "id" | "title" | "prompt" | "stream">> {
  repo: string;
  surface?: string;
  area?: string;
  description?: string;
  shortDescription?: string;
  /**
   * Agent Hermes suggested (agentic backlog). Honored ONLY on soft surfaces; the
   * hard taxonomy always overrides on dangerous surfaces. Absent for
   * deterministic/roadmap items (which route via the classifier + learned routing).
   */
  suggestedAgent?: RoutedWorkAgent;
}

export interface WorkRouterTaskSnapshot {
  repo: string;
  status?: RoutedWorkStatus;
  surface?: string;
  area?: string;
  title?: string;
  prompt?: string;
}

export interface WorkRouterPolicySnapshot extends Pick<
  DispatchPolicyConfig,
  "allowedRepos" | "allowedAgents" | "perDayMax" | "perRepoPerDayMax"
> {
  todayCount: number;
  todayRepoCounts?: Record<string, number>;
}

export type WorkRouterClassifier = (input: RoutingInput) => Pick<RoutingDecision, "agent" | "riskTier" | "reason">;

export interface PlanAndRouteWorkInput {
  backlog: WorkRouterBacklogItem[];
  inFlight: WorkRouterTaskSnapshot[];
  recentlyDone: WorkRouterTaskSnapshot[];
  policy: WorkRouterPolicySnapshot;
  classify: WorkRouterClassifier;
  /** ORCH-P4c: learned scorecard memory. Used only on soft surfaces. */
  routingScores?: WorkRouterRoutingScores;
  maxProposals?: number;
}

export interface RoutedProposal {
  taskPrompt: string;
  repo: string;
  surface: string;
  agent: RoutedWorkAgent;
  riskTier: RiskTier;
  why: string;
  whyAgent: string;
  dedupeKey: string;
}

const DEFAULT_MAX_PROPOSALS = 3;
const ACTIVE_STATUSES = new Set(["proposed", "approved", "running"]);

export function planAndRouteWork(input: PlanAndRouteWorkInput): RoutedProposal[] {
  const maxProposals = boundedMax(input.maxProposals ?? DEFAULT_MAX_PROPOSALS);
  if (maxProposals <= 0) return [];

  const covered = new Set<string>();
  for (const task of input.inFlight) {
    if (!task.status || ACTIVE_STATUSES.has(task.status)) covered.add(dedupeKeyForTask(task));
  }
  for (const task of input.recentlyDone) covered.add(dedupeKeyForTask(task));

  const proposals: RoutedProposal[] = [];
  const acceptedRepoCounts = new Map<string, number>();
  for (const item of input.backlog) {
    if (proposals.length >= maxProposals) break;
    const repo = normalizeRepo(item.repo);
    if (!repo) continue;
    const surface = itemSurface(item);
    const title = itemTitle(item);
    const proposalDedupeKey = dedupeKey(repo, surface, title);
    if (covered.has(proposalDedupeKey)) continue;

    const description = itemDescription(item);
    const routing = input.classify({
      repo,
      area: surface,
      prompt: [title, description].filter(Boolean).join(": "),
      tags: item.stream ? [item.stream] : undefined,
    });
    const classifiedAgent = routedAgent(routing.agent);
    const hardAgent = hardTaxonomyAgent(surface, title);
    const suggested = item.suggestedAgent === "codex" || item.suggestedAgent === "claude" ? item.suggestedAgent : undefined;
    let choice: { agent: RoutedWorkAgent; note?: string };
    if (hardAgent) {
      // Dangerous surface: the hard taxonomy is the wall. Nothing — not the
      // classifier, not learned routing, not Hermes's suggestion — overrides it.
      choice = {
        agent: hardAgent,
        note: hardAgent === classifiedAgent
          ? undefined
          : `Hard taxonomy kept ${surface} with ${hardAgent}; classifier, learned routing, and Hermes's suggestion cannot override it.`,
      };
    } else if (suggested) {
      // Soft surface only: honor Hermes's suggested agent, above the classifier
      // and learned routing. assertTaxonomy below is still the final guard.
      const learnedAgent = learnedRoutingChoice(surface, classifiedAgent, input.routingScores).agent;
      choice = {
        agent: suggested,
        note: `Hermes suggested ${suggested} for this soft surface.${learnedAgent !== suggested ? ` (classifier/learned leaned ${learnedAgent})` : ""}`,
      };
    } else {
      choice = learnedRoutingChoice(surface, classifiedAgent, input.routingScores);
    }
    const agent = choice.agent;
    assertTaxonomy(surface, title, agent);
    if (!policyAllows(input.policy, { repo, agent, accepted: proposals.length, acceptedRepoCounts })) continue;

    const proposal: RoutedProposal = {
      taskPrompt: item.prompt?.trim() || defaultPrompt(title, description, surface),
      repo,
      surface,
      agent,
      riskTier: routing.riskTier,
      why: `Fills uncovered backlog gap: ${title}.`,
      whyAgent: [routing.reason, choice.note].filter(Boolean).join(" "),
      dedupeKey: proposalDedupeKey,
    };
    proposals.push(proposal);
    acceptedRepoCounts.set(repo, (acceptedRepoCounts.get(repo) ?? 0) + 1);
    covered.add(proposalDedupeKey);
  }

  return proposals;
}

function policyAllows(
  policy: WorkRouterPolicySnapshot,
  input: {
    repo: string;
    agent: RoutedWorkAgent;
    accepted: number;
    acceptedRepoCounts: Map<string, number>;
  },
): boolean {
  if (!Array.isArray(policy.allowedRepos) || policy.allowedRepos.length === 0) return false;
  if (!policy.allowedRepos.includes(input.repo)) return false;
  if (!Array.isArray(policy.allowedAgents) || !policy.allowedAgents.includes(input.agent)) return false;
  if (input.accepted + policy.todayCount >= policy.perDayMax) return false;

  if (policy.perRepoPerDayMax > 0) {
    const current = policy.todayRepoCounts?.[input.repo] ?? 0;
    const acceptedForRepo = input.acceptedRepoCounts.get(input.repo) ?? 0;
    if (current + acceptedForRepo >= policy.perRepoPerDayMax) return false;
  }
  return true;
}

function routedAgent(agent: string): RoutedWorkAgent {
  if (agent === "codex" || agent === "claude") return agent;
  throw new Error(`routing_taxonomy_violation: unsupported routed agent ${agent}`);
}

function assertTaxonomy(surface: string, title: string, agent: RoutedWorkAgent): void {
  const hardAgent = hardTaxonomyAgent(surface, title);
  if (hardAgent && agent !== hardAgent) {
    throw new Error(`routing_taxonomy_violation: ${surface} must route to ${hardAgent}`);
  }
}

// The hard-taxonomy WALL — the ONLY surfaces force-routed to an agent and
// validated by assertTaxonomy (which throws on any violation). These are the
// dangerous, correctness-critical, hard-to-reverse surfaces that must always be
// Codex; nothing (classifier, learned routing, or Hermes's suggestion) overrides
// them. Everything else (UI/docs/tests/residual) defaults to Claude via the
// classifier but is Hermes-overridable on soft surfaces (agent suggestion).
//
// secrets/migrations/deploy are walled explicitly: they were only classifier-
// defaulted to Codex, and once soft surfaces became Hermes-overridable they'd
// otherwise be re-routable off Codex, which must never happen.
function hardTaxonomyAgent(surface: string, title: string): RoutedWorkAgent | undefined {
  const haystack = normalizeText(`${surface} ${title}`);
  if (matchesAny(haystack, [
    "chain", "settlement", "escrow", "contract", "contracts", "xcm", "polkadot", "substrate", "treasury",
    "secret", "secrets", "credential", "credentials", "migration", "migrations", "deploy", "deployment",
  ])) {
    return "codex";
  }
  return undefined;
}

function learnedRoutingChoice(
  surface: string,
  staticAgent: RoutedWorkAgent,
  routingScores: WorkRouterRoutingScores | undefined,
): { agent: RoutedWorkAgent; note?: string } {
  const normalizedSurface = normalizeText(surface);
  const surfaceScores = routingScores?.[normalizedSurface];
  if (!surfaceScores) return { agent: staticAgent };
  const otherAgent: RoutedWorkAgent = staticAgent === "codex" ? "claude" : "codex";
  const staticScore = surfaceScores[staticAgent];
  const otherScore = surfaceScores[otherAgent];
  if (!isUsableRoutingScore(staticScore) || !isUsableRoutingScore(otherScore)) {
    return {
      agent: staticAgent,
      note: `Learned routing has insufficient ${normalizedSurface || "general"} data; static fallback kept ${staticAgent}.`,
    };
  }
  if ((otherScore.score ?? 0) > (staticScore.score ?? 0)) {
    return {
      agent: otherAgent,
      note: `Learned routing preferred ${otherAgent} for ${normalizedSurface || "general"} (${otherAgent} ${otherScore.score} from ${otherScore.samples} sample(s), ${staticAgent} ${staticScore.score} from ${staticScore.samples}).`,
    };
  }
  return {
    agent: staticAgent,
    note: `Learned routing kept ${staticAgent} for ${normalizedSurface || "general"} (${staticAgent} ${staticScore.score} from ${staticScore.samples} sample(s), ${otherAgent} ${otherScore.score} from ${otherScore.samples}).`,
  };
}

function isUsableRoutingScore(score: WorkRouterRoutingScore | undefined): score is WorkRouterRoutingScore & { score: number } {
  return score?.status === "baseline_available" && typeof score.score === "number" && Number.isFinite(score.score);
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function dedupeKeyForTask(task: WorkRouterTaskSnapshot): string {
  return dedupeKey(normalizeRepo(task.repo), task.surface ?? task.area ?? "", task.title ?? task.prompt ?? "");
}

function dedupeKey(repo: string, surface: string, title: string): string {
  const normalizedSurface = normalizeText(surface);
  const normalizedTitle = normalizeText(title);
  return [repo, normalizedSurface || normalizedTitle, normalizedTitle].filter(Boolean).join("|");
}

function itemSurface(item: WorkRouterBacklogItem): string {
  return (item.surface ?? item.area ?? item.stream ?? "general").trim() || "general";
}

function itemTitle(item: WorkRouterBacklogItem): string {
  return (item.title ?? item.id ?? item.description ?? item.shortDescription ?? "Untitled backlog item").trim();
}

function itemDescription(item: WorkRouterBacklogItem): string {
  return (item.shortDescription ?? item.description ?? item.prompt ?? item.title ?? "").trim();
}

function defaultPrompt(title: string, description: string, surface: string): string {
  const suffix = description && description !== title ? ` ${description}` : "";
  return `Build ${title} for ${surface}.${suffix}`.trim();
}

function normalizeRepo(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function boundedMax(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PROPOSALS;
  return Math.max(0, Math.floor(value));
}
