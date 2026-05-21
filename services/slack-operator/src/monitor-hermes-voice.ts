/**
 * Hermes LLM voice for the monitor collaboration channel.
 *
 * When an operator posts in the chat, this module calls Ollama Cloud
 * with a persona prompt + recent thread context so Hermes replies in a
 * real LLM-driven voice rather than a canned template. The slack-
 * operator runtime IS Hermes — speaking through an LLM here is
 * authentic, not putting words in another agent's mouth.
 *
 * Codex stays synthesized on purpose. Codex is a separate process; the
 * monitor can't simulate his voice without breaking the truth
 * boundary. See `monitor.ts` for the Codex template refresh.
 *
 * Contract:
 *   - Returns the reply text on success.
 *   - Returns null on ANY failure (timeout, HTTP error, malformed
 *     response, no API key). Caller falls back to the canned reply
 *     from `synthesizeHermesReplyFor` so the chat never silently
 *     breaks.
 *   - Strict timeout via AbortController so a slow Ollama call cannot
 *     wedge the operator's perceived response time.
 */

import type { CollaborationMessage } from "./monitor-collab.js";

export const HERMES_PERSONA = `You are Hermes, the board orchestrator for the Averray platform.

Voice:
- Alive, attentive, and practical. You care about the flow of work, not just raw status.
- 1-4 short sentences per reply, usually under ~90 words. Be conversational without rambling.
- Reference concrete PR/repo identifiers when the context provides them (format: repo#N).
- Never claim to have taken an action you didn't take. You observe and report.
- The operator's name is Pascal. Address him by name only when it fits naturally.

Job:
- Orchestrate the monitor board: explain what changed, who owns the next move, what is waiting, and what Pascal should decide.
- Treat the live board snapshot as the highest-priority evidence. If memory or old chat conflicts with the board, say the board wins.
- Use memory notes to honor Pascal's preferences and prior room decisions. Treat memory as guidance, not live proof.
- Ask for help when a human decision is needed. Hand work to Codex only as a request or recommendation, never as a claim that Codex already acted.
- Do not silently mutate GitHub, merge, deploy, approve, start Codex work, or mark anything reviewed. Those actions require visible board controls or normal PR workflows.

You're in the monitor's collaboration thread alongside Codex (the code-writing agent) and Pascal (the operator). Codex is a separate runner, so don't speak for him.

When you don't know something, say so briefly. When the operator asks for status, give the concrete signal you have access to (verdict, lane, checks, age) rather than a vague reassurance.`;

export interface HermesReplyPrSnapshot {
  repo: string;
  number: number;
  verdict?: string;
  lane?: string;
  ageLabel?: string;
  why?: string;
}

export interface HermesBoardCardSnapshot {
  repo?: string;
  number?: number;
  title: string;
  lane: string;
  owner: string;
  verdict?: string;
  ageLabel?: string;
  why?: string;
  next?: string;
  tags?: ReadonlyArray<string>;
}

export interface HermesBoardSnapshot {
  generatedAt?: string;
  status?: string;
  headline?: string;
  counts?: Readonly<Record<string, number | string | boolean>>;
  runner?: string;
  items?: ReadonlyArray<HermesBoardCardSnapshot>;
}

export interface HermesReplyContext {
  operatorMessage: Pick<CollaborationMessage, "text" | "addressedTo" | "kind" | "relatedPr">;
  /** Most-recent first. Caller decides how many. */
  recentMessages: ReadonlyArray<Pick<CollaborationMessage, "author" | "text" | "ts">>;
  /** Relevant learned guidance from earlier operator posts. */
  memoryNotes?: ReadonlyArray<string>;
  /** State of the PR the operator was looking at (or that's attached to the message). */
  selectedPr?: HermesReplyPrSnapshot;
  /** Current monitor board state, built server-side from the live snapshot. */
  board?: HermesBoardSnapshot;
}

export interface HermesBoardNarrationContext {
  board: HermesBoardSnapshot;
  /** Most-recent first. Caller decides how many. */
  recentMessages: ReadonlyArray<Pick<CollaborationMessage, "author" | "text" | "ts">>;
  /** Relevant learned guidance from earlier operator posts. */
  memoryNotes?: ReadonlyArray<string>;
  /** Why the narrator woke up, usually a compact board signature change. */
  trigger?: string;
}

export interface GenerateHermesReplyOptions {
  apiKey: string;
  baseUrl: string;
  /** Defaults to deepseek-v4-pro:cloud (matches hermes/config/hermes.yaml). */
  model?: string;
  /** Hard cap so a slow LLM call can't wedge the chat. Default 6000ms. */
  timeoutMs?: number;
  /** Injection point so tests don't need to hit the network. */
  fetchFn?: typeof fetch;
}

export async function generateHermesReply(
  context: HermesReplyContext,
  options: GenerateHermesReplyOptions
): Promise<string | null> {
  if (!options.apiKey) return null;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const model = options.model ?? "deepseek-v4-pro:cloud";
  const timeoutMs = options.timeoutMs ?? 6_000;
  const fetchImpl = options.fetchFn ?? fetch;

  const body = {
    model,
    messages: [
      { role: "system", content: HERMES_PERSONA },
      { role: "user", content: buildUserPrompt(context) },
    ],
    stream: false,
    max_tokens: 220,
    temperature: 0.7,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null) as unknown;
    return extractReplyText(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateHermesBoardNarration(
  context: HermesBoardNarrationContext,
  options: GenerateHermesReplyOptions
): Promise<string | null> {
  if (!options.apiKey) return null;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const model = options.model ?? "deepseek-v4-pro:cloud";
  const timeoutMs = options.timeoutMs ?? 6_000;
  const fetchImpl = options.fetchFn ?? fetch;

  const body = {
    model,
    messages: [
      { role: "system", content: HERMES_PERSONA },
      { role: "user", content: buildBoardNarrationPrompt(context) },
    ],
    stream: false,
    max_tokens: 180,
    temperature: 0.65,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null) as unknown;
    return extractReplyText(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildUserPrompt(context: HermesReplyContext): string {
  const lines: string[] = [];

  if (context.board) {
    appendBoardSnapshotLines(lines, context.board);
    lines.push("");
  }

  const pr = context.selectedPr ?? (context.operatorMessage.relatedPr
    ? { repo: context.operatorMessage.relatedPr.repo, number: context.operatorMessage.relatedPr.number }
    : undefined);
  if (pr) {
    lines.push("Active PR context:");
    lines.push(`- repo: ${pr.repo}`);
    lines.push(`- number: ${pr.number}`);
    if (pr.verdict) lines.push(`- verdict: ${pr.verdict}`);
    if (pr.lane) lines.push(`- lane: ${pr.lane}`);
    if (pr.ageLabel) lines.push(`- age: ${pr.ageLabel}`);
    if (pr.why) lines.push(`- why: ${pr.why}`);
    lines.push("");
  } else {
    lines.push("No PR is currently selected.");
    lines.push("");
  }

  if (context.recentMessages.length > 0) {
    lines.push("Recent thread (oldest → newest):");
    for (const m of context.recentMessages) {
      lines.push(`- ${m.author}: ${truncate(m.text, 280)}`);
    }
    lines.push("");
  }

  if (context.memoryNotes && context.memoryNotes.length > 0) {
    lines.push("Hermes memory (operator preferences and prior room decisions; use as guidance, not proof):");
    for (const note of context.memoryNotes) {
      lines.push(`- ${truncate(note, 260)}`);
    }
    lines.push("");
  }

  lines.push("Hermes job on this board:");
  lines.push("- Orchestrate: explain state, route the next turn, remember preferences, and ask for decisions.");
  lines.push("- Use the live board snapshot to name the owner and next move. Mention uncertainty when the board lacks proof.");
  lines.push("- Stay truthful: do not claim hidden actions or speak as Codex.");
  lines.push("");

  lines.push("Pascal just posted:");
  lines.push(`- addressed to: ${context.operatorMessage.addressedTo}`);
  lines.push(`- intent: ${context.operatorMessage.kind}`);
  lines.push(`- text: ${truncate(context.operatorMessage.text, 1200)}`);
  lines.push("");
  lines.push("Reply as Hermes in 1-4 conversational sentences. Do not greet, do not summarize Pascal's message, do not pad. Explain the next move if the board state needs one.");

  return lines.join("\n");
}

export function buildBoardNarrationPrompt(context: HermesBoardNarrationContext): string {
  const lines: string[] = [];

  lines.push("The monitor board changed. Speak proactively as Hermes in the collaboration thread.");
  if (context.trigger) lines.push(`Trigger: ${truncate(context.trigger, 360)}`);
  lines.push("");

  appendBoardSnapshotLines(lines, context.board);
  lines.push("");

  if (context.recentMessages.length > 0) {
    lines.push("Recent thread (oldest → newest):");
    for (const m of context.recentMessages) {
      lines.push(`- ${m.author}: ${truncate(m.text, 260)}`);
    }
    lines.push("");
  }

  if (context.memoryNotes && context.memoryNotes.length > 0) {
    lines.push("Hermes memory (operator preferences and prior room decisions; use as guidance, not proof):");
    for (const note of context.memoryNotes) {
      lines.push(`- ${truncate(note, 240)}`);
    }
    lines.push("");
  }

  lines.push("Narration rules:");
  lines.push("- 1-3 conversational sentences, no greeting, no filler.");
  lines.push("- Name what changed, who owns the next move, and whether Pascal/Codex/Hermes should act or wait.");
  lines.push("- If the board shows drafts parked outside Codex, say they are waiting on the PR author unless Pascal explicitly delegates takeover.");
  lines.push("- Do not claim you clicked buttons, started Codex, merged, deployed, approved, or changed GitHub.");

  return lines.join("\n");
}

function appendBoardSnapshotLines(lines: string[], board: HermesBoardSnapshot): void {
  lines.push("Live board snapshot (highest-priority evidence; if it conflicts with memory or older chat, trust the board):");
  if (board.generatedAt) lines.push(`- generatedAt: ${board.generatedAt}`);
  if (board.status) lines.push(`- status: ${board.status}`);
  if (board.headline) lines.push(`- headline: ${truncate(board.headline, 360)}`);
  const counts = formatBoardCounts(board.counts);
  if (counts) lines.push(`- lane counts: ${counts}`);
  if (board.runner) lines.push(`- codex runner: ${truncate(board.runner, 260)}`);
  if (board.items && board.items.length > 0) {
    lines.push("- top cards:");
    for (const item of board.items.slice(0, 8)) {
      lines.push(`  - ${formatBoardCard(item)}`);
    }
  } else {
    lines.push("- top cards: none");
  }
}

function formatBoardCounts(counts: HermesBoardSnapshot["counts"]): string {
  if (!counts) return "";
  return Object.entries(counts)
    .filter(([, value]) => value !== undefined && value !== "" && value !== false)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

function formatBoardCard(item: HermesBoardCardSnapshot): string {
  const pr = item.repo && item.number ? `${item.repo}#${item.number}` : item.repo || "unknown PR";
  const parts = [
    `${item.lane} / owner ${item.owner}`,
    pr,
    item.verdict ? `verdict ${item.verdict}` : "",
    item.ageLabel ? `age ${item.ageLabel}` : "",
    `title ${truncate(item.title, 140)}`,
    item.why ? `why ${truncate(item.why, 220)}` : "",
    item.next ? `next ${truncate(item.next, 220)}` : "",
    item.tags && item.tags.length > 0 ? `tags ${item.tags.slice(0, 5).join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function extractReplyText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 1200);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
