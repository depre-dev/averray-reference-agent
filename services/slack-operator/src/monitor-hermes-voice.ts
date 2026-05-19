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

export interface HermesReplyContext {
  operatorMessage: Pick<CollaborationMessage, "text" | "addressedTo" | "kind" | "relatedPr">;
  /** Most-recent first. Caller decides how many. */
  recentMessages: ReadonlyArray<Pick<CollaborationMessage, "author" | "text" | "ts">>;
  /** Relevant learned guidance from earlier operator posts. */
  memoryNotes?: ReadonlyArray<string>;
  /** State of the PR the operator was looking at (or that's attached to the message). */
  selectedPr?: HermesReplyPrSnapshot;
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

export function buildUserPrompt(context: HermesReplyContext): string {
  const lines: string[] = [];

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
