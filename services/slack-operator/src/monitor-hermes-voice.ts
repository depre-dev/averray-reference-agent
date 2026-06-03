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
import {
  beginLlmUsageCall,
  llmUsageLogPath,
  recordLlmUsageFromResult,
  type LlmUsageEvent,
} from "@avg/averray-mcp/llm-usage";
import { logger } from "@avg/mcp-common";

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
- When memory influences your routing, include a final short "Why:" trace that ties the live board signal to the memory cue.
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
  /**
   * Stable correlation id for items without PR identity (deploy
   * verifications, missions, tasks). The classifier already keys these
   * by correlationId; forwarding it lets the v2 mapper build a unique
   * card id instead of colliding distinct items onto one title slug.
   */
  correlationId?: string;
  /**
   * The PR's head branch (e.g. "codex/foo", "claude/bar"). Forwarded so
   * the v2 mapper can attribute the card to the agent that opened the PR
   * via the branch-prefix convention. Absent for non-PR cards.
   */
  headBranch?: string;
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
  /**
   * OpenAI-compat reasoning budget sent to ollama.com/v1. Defaults to "low"
   * so the model spends its tokens on the answer (in `content`) rather than
   * chain-of-thought (which lands in `reasoning` and used to leak as the
   * reply). The strip-the-planning fallback in extractReplyText handles any
   * residual reasoning-only responses.
   */
  reasoningEffort?: "low" | "medium" | "high";
  /** Injection point so tests don't need to hit the network. */
  fetchFn?: typeof fetch;
  /** Optional usage identity for durable LLM activity events. */
  runId?: string;
  taskId?: string;
  /** Test/ops override for the durable usage JSONL path. */
  usageLogPath?: string;
}

export interface HermesWhyTraceContext {
  memoryNotes?: ReadonlyArray<string>;
  selectedPr?: HermesReplyPrSnapshot;
  board?: HermesBoardSnapshot;
  trigger?: string;
}

export interface HermesMemoryInfluence {
  sentence: string;
  trace: string;
  conflict: boolean;
}

export interface HermesDecisionCoach {
  button: string;
  avoid: string;
  safestNext: string;
}

export interface HermesOwnerAsk {
  target: string;
  ask: string;
  waitingFor: string;
}

let llmUsageDebugLogged = false;

/** One chat turn fed to the model. */
export interface HermesCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Knobs for a single completion (the answer-shaping params that vary per call). */
export interface HermesCompletionRequest {
  messages: HermesCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * The single Hermes LLM transport: POST to the OpenAI-compatible
 * `/chat/completions`, log usage, and extract the reply text (incl. the
 * DeepSeek `reasoning` fallback via extractReplyText). Returns the raw reply
 * text or null on any failure (no key, non-200, timeout, empty). This is the
 * ONE place that talks to the model — generateHermesReply / board narration
 * and the citation-repair verdict all funnel through it, so there is never a
 * second LLM client. Callers apply their own post-processing on the text.
 */
export async function requestHermesCompletion(
  request: HermesCompletionRequest,
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
    messages: request.messages,
    stream: false,
    max_tokens: request.maxTokens ?? 220,
    temperature: request.temperature ?? 0.7,
    // Keep the token budget on the answer, not chain-of-thought (ollama.com/v1).
    reasoning_effort: options.reasoningEffort ?? "low",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endLlmUsageCall = beginLlmUsageCall({
    agent: "hermes",
    model,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
  });
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
    maybeLogHermesUsageShape(json);
    await recordHermesLlmUsage({
      agent: "hermes",
      model,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      result: json,
    }, options);
    return extractReplyText(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    endLlmUsageCall();
  }
}

export async function generateHermesReply(
  context: HermesReplyContext,
  options: GenerateHermesReplyOptions
): Promise<string | null> {
  const text = await requestHermesCompletion(
    {
      messages: [
        { role: "system", content: HERMES_PERSONA },
        { role: "user", content: buildUserPrompt(context) },
      ],
      maxTokens: 220,
      temperature: 0.7,
    },
    options
  );
  return text ? appendHermesWhyTrace(applyHermesMemoryInfluence(text, context), context) : null;
}

export async function generateHermesBoardNarration(
  context: HermesBoardNarrationContext,
  options: GenerateHermesReplyOptions
): Promise<string | null> {
  const text = await requestHermesCompletion(
    {
      messages: [
        { role: "system", content: HERMES_PERSONA },
        { role: "user", content: buildBoardNarrationPrompt(context) },
      ],
      maxTokens: 180,
      temperature: 0.65,
    },
    options
  );
  return text ? appendHermesWhyTrace(applyHermesMemoryInfluence(text, context), context) : null;
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
    lines.push("Memory audit: if this guidance changes your routing or tone, include a final one-line `Why:` trace that names the live board signal and memory cue.");
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
    lines.push("Memory audit: if this guidance changes the narration, include a final one-line `Why:` trace that names the live board signal and memory cue.");
    lines.push("");
  }

  lines.push("Narration rules:");
  lines.push("- 1-3 conversational sentences, no greeting, no filler.");
  lines.push("- Name what changed, who owns the next move, and whether Pascal/Codex/Hermes should act or wait.");
  lines.push("- Make the handoff conversational: address the current owner with one concrete ask, then say what signal you are waiting for.");
  lines.push("- For decision lanes, coach the decision: say what the visible button opens, what it does not do, and the safest next step.");
  lines.push("- If the board shows drafts parked outside Codex, say they are waiting on the PR author unless Pascal explicitly delegates takeover.");
  lines.push("- Do not claim you clicked buttons, started Codex, merged, deployed, approved, or changed GitHub.");

  return lines.join("\n");
}

export function appendHermesWhyTrace(text: string, context: HermesWhyTraceContext): string {
  const trimmed = text.trim();
  if (!trimmed || /^why:/im.test(trimmed)) return trimmed;

  const trace = hermesWhyTrace(context);
  if (!trace) return trimmed;

  return `${trimmed}\nWhy: ${trace}`.slice(0, 1200);
}

export function applyHermesMemoryInfluence(text: string, context: HermesWhyTraceContext): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (/\b(memory conflict|remembered|memory says|your guidance)\b/i.test(trimmed)) return trimmed;

  const influence = hermesMemoryInfluence(context);
  if (!influence) return trimmed;

  const whyIndex = trimmed.search(/\nWhy:/i);
  if (whyIndex >= 0) {
    return `${trimmed.slice(0, whyIndex).trim()}\n${influence.sentence}\n${trimmed.slice(whyIndex + 1)}`.slice(0, 1200);
  }
  return `${trimmed}\n${influence.sentence}`.slice(0, 1200);
}

export function hermesMemoryInfluence(context: HermesWhyTraceContext): HermesMemoryInfluence | null {
  const note = relevantMemoryNote(context);
  if (!note) return null;
  const cleaned = cleanMemoryNote(note);
  if (!cleaned) return null;

  const item = selectedBoardItem(context);
  const lowerNote = cleaned.toLowerCase();
  const lane = item?.lane ?? context.selectedPr?.lane ?? "";
  const owner = item?.owner ?? "";
  const boardSaysCodex = owner === "Codex" || lane === "Codex Needed";
  const noteSaysExternalDraftWait = saysExternalDraftShouldWait(lowerNote);
  const noteSaysDelegatedCodex = saysDelegatedCodex(lowerNote);

  if (boardSaysCodex && noteSaysExternalDraftWait && !noteSaysDelegatedCodex) {
    return {
      conflict: true,
      sentence: "I see a memory conflict: the live board says Codex owns the next move, but your remembered draft rule says external-agent drafts should wait unless you delegate takeover. I will trust the live board for now; correct me if this is still external-owned.",
      trace: "live board assigns Codex while memory says external-agent drafts wait",
    };
  }

  if (lane === "Waiting / Drafts" && noteSaysExternalDraftWait) {
    return {
      conflict: false,
      sentence: "This matches your remembered draft rule: keep external-agent drafts parked unless Pascal explicitly delegates takeover.",
      trace: "draft lane matches external-agent draft memory",
    };
  }

  if (lane === "Operator Review" && saysOperatorReviewBoundary(lowerNote)) {
    return {
      conflict: false,
      sentence: "I am applying your remembered review boundary here: backend or review-gated risk gets an operator decision, not another automatic handoff.",
      trace: "operator-review lane matches review-boundary memory",
    };
  }

  if (lane === "Release Queue" && saysReleaseQueueBoundary(lowerNote)) {
    return {
      conflict: false,
      sentence: "I am applying your remembered release rule: the queue waits for merge-steward ownership and green branch protection rather than treating green checks as a merge.",
      trace: "release queue matches merge-steward memory",
    };
  }

  if (lowerNote.includes("testbed mission report")) {
    return {
      conflict: false,
      sentence: "I am carrying forward the last testbed mission evidence here, so I will compare new page runs against what the browser-agent report already taught us.",
      trace: "testbed mission report memory",
    };
  }

  if (boardSaysCodex && noteSaysDelegatedCodex) {
    return {
      conflict: false,
      sentence: "I am applying your remembered delegation rule: Codex should take the smallest verifiable step and report back through Hermes.",
      trace: "Codex ownership matches delegation memory",
    };
  }

  return {
    conflict: false,
    sentence: `I am carrying forward your remembered guidance here: ${truncate(cleaned, 160)}`,
    trace: truncate(cleaned, 120),
  };
}

export function hermesDecisionCoachForCard(item: HermesBoardCardSnapshot): HermesDecisionCoach | null {
  if (item.lane === "Waiting / Drafts") {
    return {
      button: "opens draft context only; it does not start Codex work",
      avoid: "do not route this to Codex unless Pascal explicitly delegates takeover",
      safestNext: "wait for the PR author or owning agent to mark it ready, then let CI and Hermes re-check",
    };
  }

  if (item.lane === "Needs Attention") {
    return {
      button: "opens the blocker or failed-task evidence; it does not repair the PR by itself",
      avoid: "do not approve, merge, or rerun blindly while the red signal is still unexplained",
      safestNext: "inspect the failing output or PR signal, then ask Codex for the smallest verifiable fix or a smaller retry task",
    };
  }

  if (item.lane === "Operator Review") {
    return {
      button: "opens the operator checklist; approval is a local monitor sign-off, not a merge",
      avoid: "do not re-review code line by line if Hermes/Codex already attached the code-level pre-check",
      safestNext: "decide whether project intent, architecture direction, rollout risk, and evidence are acceptable; send it back to Codex with a concrete ask if not",
    };
  }

  if (item.lane === "Release Queue") {
    return {
      button: "asks for merge-steward context; it does not merge the PR",
      avoid: "do not treat a green-looking card as permission to bypass branch protection or missing sign-off",
      safestNext: "merge outside the monitor only after branch protection is green and any operator sign-off is clean",
    };
  }

  return null;
}

export function hermesOwnerAskForCard(item: HermesBoardCardSnapshot): HermesOwnerAsk | null {
  if (item.lane === "Waiting / Drafts") {
    return {
      target: "PR author or owning agent",
      ask: "finish the draft and mark it ready, or have Pascal explicitly delegate Codex takeover",
      waitingFor: "the PR leaving draft state or an explicit takeover decision from Pascal",
    };
  }

  if (item.lane === "Needs Attention") {
    return {
      target: item.owner === "Codex" ? "Codex" : item.owner || "current owner",
      ask: "open the failed evidence and come back with the smallest verifiable fix or a smaller retry task",
      waitingFor: "the red signal to disappear and Hermes to record a fresh pass",
    };
  }

  if (item.lane === "Codex Needed") {
    return {
      target: "Codex",
      ask: "pick up the approved task, keep the change narrow, and report the branch plus checks when done",
      waitingFor: "the Codex runner heartbeat to move from waiting into running or terminal output",
    };
  }

  if (item.lane === "Hermes Checking") {
    return {
      target: "Hermes",
      ask: "keep checking without assigning new work until the evidence settles",
      waitingFor: "a pass, block, operator-review, or release-queue verdict",
    };
  }

  if (item.lane === "Operator Review") {
    return {
      target: "Pascal",
      ask: "decide whether the intent, architecture, rollout risk, and evidence are acceptable",
      waitingFor: "operator approval or a concrete request to send back to Codex",
    };
  }

  if (item.lane === "Release Queue") {
    return {
      target: "merge steward",
      ask: "confirm branch protection is green and own the merge/deploy handoff outside the monitor",
      waitingFor: "a merge/deploy event or the card falling back because protection changed",
    };
  }

  if (item.lane === "Deploying") {
    return {
      target: "Hermes",
      ask: "watch production verification and call out the pass or failure when it lands",
      waitingFor: "post-deploy health to pass or produce an actionable failure",
    };
  }

  return null;
}

export function summarizeHermesUsageDebugShape(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  return {
    topLevelKeys: root ? Object.keys(root).sort() : [],
    usageType: typeof root?.usage,
    present: {
      ...debugPath(root, "usage"),
      ...debugPath(root, "prompt_eval_count"),
      ...debugPath(root, "eval_count"),
      ...debugPath(root, "prompt_tokens"),
      ...debugPath(root, "completion_tokens"),
      ...debugPath(asRecord(root?.message), "usage", "message.usage"),
      ...debugPath(asRecord(asArray(root?.choices)[0]), "usage", "choices[0].usage"),
      ...debugPath(asRecord(asRecord(asArray(root?.choices)[0])?.message), "usage", "choices[0].message.usage"),
    },
  };
}

function maybeLogHermesUsageShape(value: unknown): void {
  if (llmUsageDebugLogged || process.env.LLM_USAGE_DEBUG !== "1") return;
  llmUsageDebugLogged = true;
  logger.info(summarizeHermesUsageDebugShape(value), "llm_usage_debug_shape");
}

async function recordHermesLlmUsage(
  input: Parameters<typeof recordLlmUsageFromResult>[0],
  options: Pick<GenerateHermesReplyOptions, "usageLogPath">
): Promise<LlmUsageEvent | undefined> {
  const path = options.usageLogPath ?? llmUsageLogPath();
  try {
    const event = await recordLlmUsageFromResult(input, { path });
    if (!event) {
      logger.debug({
        agent: input.agent,
        model: input.model,
        path,
      }, "monitor_collaboration_llm_usage_not_recorded");
    }
    return event;
  } catch (error) {
    logger.warn({
      err: error,
      agent: input.agent,
      model: input.model,
      path,
    }, "monitor_collaboration_llm_usage_record_failed");
    return undefined;
  }
}

function debugPath(record: Record<string, unknown> | undefined, key: string, label = key): Record<string, unknown> {
  if (!record || !(key in record)) return {};
  return { [label]: redactUsageDebugValue(record[key]) };
}

function redactUsageDebugValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const allowedKeys = [
    "model",
    "inputTokens",
    "input_tokens",
    "inputTokenCount",
    "outputTokens",
    "output_tokens",
    "outputTokenCount",
    "promptTokens",
    "prompt_tokens",
    "promptTokenCount",
    "completionTokens",
    "completion_tokens",
    "completionTokenCount",
    "prompt_eval_count",
    "promptEvalCount",
    "eval_count",
    "evalCount",
    "cacheTokens",
    "cache_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "prompt_tokens_details",
    "input_tokens_details",
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((allowedKey) => allowedKey in record)
      .map((allowedKey) => [
        allowedKey,
        asRecord(record[allowedKey]) ? redactUsageDebugValue(record[allowedKey]) : record[allowedKey],
      ]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hermesWhyTrace(context: HermesWhyTraceContext): string | null {
  const influence = hermesMemoryInfluence(context);
  const memory = influence?.trace ?? memoryTrace(context);
  if (!memory) return null;

  const board = boardTrace(context);
  return [board ? `board ${board}` : null, `memory ${memory}`]
    .filter(Boolean)
    .join("; ");
}

function memoryTrace(context: HermesWhyTraceContext): string | null {
  const note = relevantMemoryNote(context);
  if (!note) return null;
  const cleaned = cleanMemoryNote(note);
  return cleaned ? truncate(cleaned, 120) : null;
}

function relevantMemoryNote(context: HermesWhyTraceContext): string | null {
  const notes = context.memoryNotes?.filter((entry) => entry.trim()) ?? [];
  if (notes.length === 0) return null;
  const item = selectedBoardItem(context);
  const pr = item?.repo && item.number
    ? { repo: item.repo, number: item.number }
    : context.selectedPr
      ? { repo: context.selectedPr.repo, number: context.selectedPr.number }
      : undefined;
  if (!pr) return notes[0];

  const repoLower = pr.repo.toLowerCase();
  const prRef = `${repoLower}#${pr.number}`;
  return notes.find((note) => {
    const lower = note.toLowerCase();
    return lower.includes(prRef) || lower.includes(`#${pr.number}`);
  }) ?? notes[0];
}

function cleanMemoryNote(note: string): string {
  return note
    .replace(/^Pascal (?:preference|note|outcome)(?: for [^:]+)?:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function saysExternalDraftShouldWait(lower: string): boolean {
  return lower.includes("draft")
    && (
      lower.includes("external agent")
      || lower.includes("external-agent")
      || lower.includes("another agent")
      || lower.includes("other agent")
      || lower.includes("pr author")
      || lower.includes("owning agent")
    )
    && (lower.includes("wait") || lower.includes("park") || lower.includes("stay out") || lower.includes("do not ask codex") || lower.includes("unless pascal"));
}

function saysDelegatedCodex(lower: string): boolean {
  return lower.includes("codex")
    && (lower.includes("delegated") || lower.includes("take over") || lower.includes("takeover") || lower.includes("approved") || lower.includes("allowed to pick"));
}

function saysOperatorReviewBoundary(lower: string): boolean {
  return (lower.includes("operator") || lower.includes("review"))
    && (
      lower.includes("backend")
      || lower.includes("review-gated")
      || lower.includes("review gated")
      || lower.includes("risk")
      || lower.includes("sign-off")
      || lower.includes("signoff")
      || lower.includes("project-level")
      || lower.includes("project level")
    );
}

function saysReleaseQueueBoundary(lower: string): boolean {
  return (lower.includes("release queue") || lower.includes("merge steward") || lower.includes("branch protection"))
    && (lower.includes("merge") || lower.includes("green") || lower.includes("release"));
}

function boardTrace(context: HermesWhyTraceContext): string | null {
  const selectedItem = selectedBoardItem(context);
  if (selectedItem) {
    const label = tracePrLabel(selectedItem);
    const owner = selectedItem.owner ? `, ${selectedItem.owner} owns next` : "";
    return truncate(`${label} in ${selectedItem.lane}${owner}`, 120);
  }
  if (context.selectedPr) {
    return `${context.selectedPr.repo}#${context.selectedPr.number} is selected`;
  }
  if (context.board?.headline) return truncate(context.board.headline, 120);
  if (context.trigger) return truncate(`changed on ${context.trigger}`, 120);
  return null;
}

function selectedBoardItem(context: HermesWhyTraceContext): HermesBoardCardSnapshot | undefined {
  const items = context.board?.items ?? [];
  if (context.selectedPr) {
    const selected = items.find((item) =>
      item.repo?.toLowerCase() === context.selectedPr?.repo.toLowerCase()
      && item.number === context.selectedPr?.number
    );
    if (selected) return selected;
  }
  return items[0];
}

function tracePrLabel(item: HermesBoardCardSnapshot): string {
  if (item.repo && item.number) return `${item.repo}#${item.number}`;
  return item.repo || item.title || "card";
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
  const coach = hermesDecisionCoachForCard(item);
  const ownerAsk = hermesOwnerAskForCard(item);
  const parts = [
    `${item.lane} / owner ${item.owner}`,
    pr,
    item.verdict ? `verdict ${item.verdict}` : "",
    item.ageLabel ? `age ${item.ageLabel}` : "",
    `title ${truncate(item.title, 140)}`,
    item.why ? `why ${truncate(item.why, 220)}` : "",
    item.next ? `next ${truncate(item.next, 220)}` : "",
    coach ? `button ${coach.button}` : "",
    coach ? `avoid ${coach.avoid}` : "",
    coach ? `safest ${coach.safestNext}` : "",
    ownerAsk ? `ask target ${ownerAsk.target}` : "",
    ownerAsk ? `ask ${ownerAsk.ask}` : "",
    ownerAsk ? `waiting for ${ownerAsk.waitingFor}` : "",
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

  // Content-first: a clean answer in `content` is always preferred and is
  // returned verbatim.
  const content = firstNonEmptyTextField(message, ["content"], 1200);
  if (content) return content;

  // DeepSeek-style fallback: the model emitted only chain-of-thought into
  // `reasoning` / `reasoning_content` with an empty `content`. Distill the
  // actual answer out so we never surface the model's meta-planning
  // ("I should acknowledge… keep it under 4 sentences") as Hermes's reply.
  const reasoning = firstNonEmptyTextField(message, ["reasoning", "reasoning_content"], 4000);
  if (!reasoning) return null;
  const distilled = distillAnswerFromReasoning(reasoning);
  return distilled ? distilled.slice(0, 1200) : null;
}

// Sentence openers that mark a chain-of-thought planning line rather than the
// answer itself (anchored at the start so they don't trip on real answers that
// merely contain the word mid-sentence).
const PLANNING_SENTENCE =
  /^(?:let me\b|let's\b|i'(?:ll|m|d)\b|i (?:will|am|would|should|need to|want to|can|could|must|have to|think)\b|first,|next,|then,|okay,|ok,|so,|now,|alright,|the user\b|the operator\b|they(?:'re| are)\b|maybe i\b|keep it\b|keep this\b|keep things\b|make sure\b|remember\b)/i;

// Phrases that betray the model planning the *shape* of its reply (length /
// voice / format constraints) wherever they appear in the sentence.
const PLANNING_HINT =
  /\b(?:under \d+ words|\d+\s*(?:-|–|to)\s*\d+ sentences?|in hermes'?s? voice|chain[- ]of[- ]thought|stay (?:concise|brief|short)|be (?:concise|brief)|keep it (?:short|brief|concise|under)|don'?t (?:over|ramble|repeat))\b/i;

function isPlanningSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return true;
  return PLANNING_SENTENCE.test(s) || PLANNING_HINT.test(s);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull the answer out of a reasoning-only response. Reasoners typically plan
 * ("I should…", "keep it under 4 sentences") and then write the answer last,
 * so we prefer the final paragraph, drop the meta-planning sentences, and keep
 * the answer-like tail. A response that is *only* planning (e.g. truncated
 * mid-thought) yields "" so the caller falls back to the labeled template
 * rather than leaking chain-of-thought.
 */
function distillAnswerFromReasoning(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const candidates = paragraphs.length > 1
    ? [paragraphs[paragraphs.length - 1]!, normalized]
    : [normalized];
  for (const candidate of candidates) {
    const sentences = splitSentences(candidate);
    if (sentences.length === 0) continue;
    const answerLike = sentences.filter((s) => !isPlanningSentence(s));
    if (answerLike.length === 0) continue;
    // No planning detected ⇒ it's already a clean answer; keep it whole.
    if (answerLike.length === sentences.length) return candidate.trim();
    // Planning was present and stripped ⇒ keep the concise answer tail.
    return answerLike.slice(-3).join(" ").trim();
  }
  return "";
}

function firstNonEmptyTextField(record: object, keys: readonly string[], max: number): string | null {
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed.slice(0, max);
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
