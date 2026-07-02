/**
 * ORCH-P4c — agentic backlog source for the Hermes router.
 *
 * The router's deterministic backlog (roadmap plan) is the predictable FLOOR.
 * This adds a board-grounded layer: Hermes (glm-5.2, over the gateway session
 * with its MCP tools + memory) reasons about the LIVE board and proposes genuine
 * work gaps. Those items are AUGMENTED onto the roadmap floor and flow through
 * the UNCHANGED router path — hard taxonomy (`assertTaxonomy`) + dispatch-policy
 * allowlist/budget + operator approval. Hermes gains NO new authority: it only
 * answers "what's worth proposing," grounded in board evidence it must cite.
 *
 * Every guardrail is preserved because this only changes the *backlog source*:
 *   • proposes-only (the router still writes `proposed`, never approves)
 *   • hard routing taxonomy still deterministically assigns/validates the agent
 *   • dispatch-policy allowlist + per-day/per-repo budgets still gate
 *   • operator approval still required; autonomy-mode + anomaly-pause still apply
 *
 * DEGRADED-SAFE: any failure (gateway down, non-JSON, no items) returns [] so the
 * caller falls back to the deterministic backlog. Every item is validated
 * (allowlisted repo + a cited board signal) or dropped — a hallucinated item with
 * no board signal never becomes a proposal.
 */

import type { RoutedWorkAgent, WorkRouterBacklogItem } from "@avg/averray-mcp/work-router";
import { chatWithHermesSession, type HermesSessionConfig } from "./hermes-session-client.js";
import type { HermesBoardSnapshot } from "./monitor-hermes-voice.js";

export interface AgenticBacklogConfig {
  session: HermesSessionConfig;
  /** dispatch.allowed_repos — Hermes may only propose for these (pre-filtered). */
  allowedRepos: readonly string[];
  /** Hard cap on items accepted from one router tick. */
  maxItems: number;
}

export interface AgenticBacklogInFlight {
  repo: string;
  status: string;
  title?: string;
  surface?: string;
}

export interface AgenticBacklogContext {
  board: HermesBoardSnapshot;
  /** Current queue tasks — so Hermes doesn't re-propose in-flight work. */
  inFlight: readonly AgenticBacklogInFlight[];
  /** Operator preferences / prior room decisions (guidance, not proof). */
  memoryNotes: readonly string[];
}

export interface AgenticBacklogDeps {
  /** Injection point so tests never hit the gateway. */
  chat?: typeof chatWithHermesSession;
}

/**
 * A router backlog item + the agent Hermes *suggested*. The suggestion is parsed
 * and carried now; PR #2 makes the work-router honor it on soft surfaces (the
 * hard taxonomy always overrides). Until then it's inert metadata.
 */
export type AgenticBacklogItem = WorkRouterBacklogItem & { suggestedAgent?: RoutedWorkAgent };

/** Ask Hermes for board-grounded work gaps; validate + normalize to backlog items. */
export async function collectAgenticBacklog(
  config: AgenticBacklogConfig,
  context: AgenticBacklogContext,
  deps: AgenticBacklogDeps = {}
): Promise<AgenticBacklogItem[]> {
  if (config.allowedRepos.length === 0 || config.maxItems <= 0) return [];
  const chat = deps.chat ?? chatWithHermesSession;

  let turnText: string | null = null;
  try {
    const turn = await chat(config.session, buildAgenticBacklogPrompt(config, context));
    turnText = turn?.text ?? null;
  } catch {
    return [];
  }
  if (!turnText) return [];

  const allowed = new Set(config.allowedRepos.map((repo) => repo.trim().toLowerCase()));
  const boardText = boardGroundingText(context.board);
  const items: AgenticBacklogItem[] = [];
  const seen = new Set<string>();
  for (const raw of parseWorkItems(turnText)) {
    if (items.length >= config.maxItems) break;
    const item = normalizeItem(raw, allowed);
    if (!item) continue;
    // Truth-boundary guard: a proposal that asserts a HIGH-RISK file category
    // (secrets/.env/migrations) the board evidence never mentions is an
    // ungrounded claim — drop it rather than surface a fabricated risk to the
    // operator. The generic-menu → specific-claim case (the #717 near-miss) is
    // addressed by the prompt's grounding rules + the card-side ground-truth panel.
    if (ungroundedHighRiskClaim(item, boardText)) continue;
    const key = `${item.repo}::${item.surface ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

// --- prompt -----------------------------------------------------------------

export function buildAgenticBacklogPrompt(config: AgenticBacklogConfig, context: AgenticBacklogContext): string {
  const lines: string[] = [];
  lines.push("You are Hermes, the board orchestrator. Find GENUINE work gaps on the live board that should become tasks.");
  lines.push("");
  lines.push("Live board (highest-priority evidence — every item you propose MUST cite a signal from here):");
  lines.push(formatBoardForPrompt(context.board));
  lines.push("");
  if (context.inFlight.length > 0) {
    lines.push("Already in flight (do NOT re-propose these):");
    for (const task of context.inFlight.slice(0, 20)) {
      lines.push(`- [${task.status}] ${task.repo}: ${truncate(task.surface || task.title || "task", 100)}`);
    }
    lines.push("");
  }
  if (context.memoryNotes.length > 0) {
    lines.push("Operator memory (preferences / prior decisions — guidance, not proof):");
    for (const note of context.memoryNotes.slice(0, 8)) lines.push(`- ${truncate(note, 200)}`);
    lines.push("");
  }
  lines.push(`You may ONLY propose work for these repos: ${config.allowedRepos.join(", ")}.`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Propose only REAL gaps grounded in the board (a failed check needing a fix, a stuck draft, missing coverage, a follow-up a card asks for). Do NOT invent work.");
  lines.push("- GROUND every factual claim in a specific card above — state only what that card's own fields (title/why/verdict/next) actually say about THAT card.");
  lines.push("- A card's \"why\" may list risk categories as possibilities (a review-gate that checks for secrets, contracts, OR migrations is a MENU of what it looks for — NOT proof the PR touches them). Never restate such a menu as a definite claim: do not say a PR \"touches secrets/migrations/contracts\" or is \"blocked/gated\" unless the cited card states that specifically for that PR.");
  lines.push("- Never invent PR numbers, file names, diff contents, error text, checks, or metrics that are not in the cited card. If you cannot ground a task's rationale in a specific card above, do not propose it.");
  lines.push("- Skip anything already in flight above. Skip merge/deploy — those stay with the human.");
  lines.push(`- At most ${config.maxItems} items, highest-leverage first. Fewer is fine. If nothing is genuinely needed, return [].`);
  lines.push("- suggestedAgent: 'codex' for chain/settlement/contracts/secrets/DB-migrations/deploy/ops; 'claude' for UI/frontend/monitor/docs/tests/non-financial. (The system enforces the dangerous ones regardless.)");
  lines.push("");
  lines.push("Return ONLY a JSON array, no prose, each item exactly:");
  lines.push('[{"repo":"owner/name","surface":"short area label","title":"short title","prompt":"concrete task instruction for the worker agent","why":"why this is needed","boardSignal":"the exact board card/lane/failure this addresses","suggestedAgent":"codex|claude"}]');
  return lines.join("\n");
}

function formatBoardForPrompt(board: HermesBoardSnapshot): string {
  const out: string[] = [];
  if (board.headline) out.push(`headline: ${truncate(board.headline, 300)}`);
  if (board.counts) {
    const counts = Object.entries(board.counts)
      .filter(([, v]) => v !== undefined && v !== "" && v !== false)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    if (counts) out.push(`lanes: ${counts}`);
  }
  const items = board.items ?? [];
  if (items.length === 0) return `${out.join("\n")}\ncards: none`;
  out.push("cards:");
  for (const card of items.slice(0, 14)) {
    const id = card.repo && card.number ? `${card.repo}#${card.number}` : card.repo || "card";
    const parts = [
      `${card.lane} / owner ${card.owner}`,
      id,
      card.verdict ? `verdict ${card.verdict}` : "",
      card.ageLabel ? `age ${card.ageLabel}` : "",
      `title ${truncate(card.title, 120)}`,
      card.why ? `why ${truncate(card.why, 160)}` : "",
      // The REAL diff areas (Stage 3). This is the definitive list of what the
      // PR touches — grounds the model so it can't invent a category (secrets/
      // migrations) the diff doesn't contain.
      card.touchedAreas && card.touchedAreas.length > 0 ? `diff-areas ${card.touchedAreas.join(", ")}` : "",
      card.next ? `next ${truncate(card.next, 160)}` : "",
    ].filter(Boolean);
    out.push(`  - ${parts.join(" | ")}`);
  }
  return out.join("\n");
}

// --- parse + validate -------------------------------------------------------

/** Extract the first JSON array from a model reply, tolerant of surrounding prose. */
export function parseWorkItems(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Validate one raw item → AgenticBacklogItem, or null to drop it. */
export function normalizeItem(raw: unknown, allowedRepos: ReadonlySet<string>): AgenticBacklogItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const repo = str(r.repo);
  const surface = str(r.surface);
  const prompt = str(r.prompt);
  const boardSignal = str(r.boardSignal);
  // Hard requirements: an allowlisted repo, a task surface + prompt, and — the
  // hallucination guard — a cited board signal. Missing any → drop the item.
  if (!repo || !allowedRepos.has(repo.toLowerCase())) return null;
  if (!surface || !prompt || !boardSignal) return null;

  const title = str(r.title) || surface;
  const why = str(r.why);
  const suggestedAgent = r.suggestedAgent === "codex" || r.suggestedAgent === "claude" ? r.suggestedAgent : undefined;

  return {
    repo,
    surface,
    title,
    prompt,
    area: surface,
    description: [why, `board: ${boardSignal}`].filter(Boolean).join(" — "),
    shortDescription: why || title,
    ...(suggestedAgent ? { suggestedAgent } : {}),
  };
}

// --- grounding guard --------------------------------------------------------

// High-risk file categories whose *false* assertion would most mislead a risk /
// routing decision — the ones the #717 near-miss fabricated. Kept deliberately
// tiny (secrets/.env and DB migrations). A proposal that asserts one of these
// but the board evidence never mentions it is dropped as ungrounded.
const HIGH_RISK_CLAIM_TOKENS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "secrets", pattern: /\bsecrets?\b|(?:^|[^.\w])\.env\b/i },
  { label: "migrations", pattern: /\bmigrations?\b/i },
];

/**
 * The high-risk category an item's text asserts that the board evidence the
 * model was shown NEVER mentions — or null when every asserted category is
 * grounded in the board. Mirrors the existing "must cite a real board signal"
 * guard: an ungrounded high-risk claim is a fabrication, so the caller drops it.
 */
export function ungroundedHighRiskClaim(item: AgenticBacklogItem, boardText: string): string | null {
  const claim = `${item.prompt} ${item.title} ${item.description ?? ""}`;
  for (const { label, pattern } of HIGH_RISK_CLAIM_TOKENS) {
    if (pattern.test(claim) && !pattern.test(boardText)) return label;
  }
  return null;
}

/** The board evidence the model is shown, flattened to one lowercase corpus so a
 *  proposal's high-risk claims can be checked for grounding against it. */
export function boardGroundingText(board: HermesBoardSnapshot): string {
  const parts: string[] = [board.headline ?? ""];
  for (const card of board.items ?? []) {
    parts.push(card.title ?? "", card.why ?? "", card.verdict ?? "", card.next ?? "", card.lane ?? "");
  }
  return parts.join(" \n ").toLowerCase();
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
