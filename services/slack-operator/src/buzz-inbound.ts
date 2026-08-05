// Deciding whether to answer a message in #Ops — the pure half of the inbound
// seam. No sockets, no clock, no LLM: every rule that could let this thing talk
// to itself is a function of its arguments, and therefore cheap to test.
//
// ── WHY THE RULES LIVE HERE AND NOT IN THE TRANSPORT ────────────────────────
//
// Until now Buzz has been publish-only, and the worst failure available to it
// was silence. Listening changes the risk completely: a bot that answers
// messages in a channel it also posts to can answer itself, and each answer is
// another message to answer. That loop runs at socket speed against a live
// money system, costs model spend per turn, and buries the one channel an
// operator is supposed to be able to trust at 3am.
//
// So the loop guard is not a line in a callback. It is the first rule in a pure
// function with a name, a reason, and a test that fails without it.
//
// ── THE GUARDS, AND WHAT EACH ONE IS FOR ────────────────────────────────────
//
//  · SELF — an event authored by our own key is never answered. Both the
//    narration publisher and this listener use one agent key, so this single
//    check also covers a second instance of the monitor started by accident:
//    it would post under the same pubkey and be ignored rather than argued with.
//  · REPLAY — the relay may hand us stored events on connect, and does hand
//    them to us again after a reconnect. Answering those means every restart
//    re-answers the last question, which is the exact shape of the duplicate
//    #Ops alerts that reached production once already (see probe-transitions).
//    Anything older than this process is history, not a question.
//  · SEEN — the same event id arriving twice is one question, not two.
//  · RATE — a bounded number of answers per window. This is the guard for the
//    loop we did NOT think of: if some future path defeats the self check, the
//    blast radius is a known small number of messages rather than a runaway.
//
// None of these overlap by accident. Each covers a way the previous one can be
// wrong, which is the point.

import { KIND_STREAM_MESSAGE, MAX_CONTENT_BYTES } from "./buzz-event.js";

/** Why a message was or was not answered. Every value is operator-facing. */
export type InboundVerdict =
  | "answer"
  | "ignore-disabled"
  | "ignore-kind"
  | "ignore-channel"
  | "ignore-self"
  | "ignore-replay"
  | "ignore-seen"
  | "ignore-empty"
  | "ignore-not-addressed"
  | "ignore-rate-limited";

/** The parts of a Nostr event this decision needs. Deliberately minimal. */
export interface InboundEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

export interface InboundContext {
  /** Our own x-only pubkey. The loop guard compares against this. */
  agentPubkey: string;
  /** The #Ops channel UUID; messages tagged for anywhere else are not ours. */
  channelId: string;
  /** Unix seconds this process began listening. Older events are history. */
  startedAtSeconds: number;
  /** Event ids already handled, so a redelivery is not a second question. */
  seenEventIds: ReadonlySet<string>;
  /** Answers already sent in the current rate window. */
  repliesInWindow: number;
  maxRepliesPerWindow: number;
  /** When true, only messages naming the agent are answered. */
  requireMention: boolean;
  /** Lowercase names that count as addressing the agent. */
  mentionNames: readonly string[];
  enabled: boolean;
}

export interface InboundDecision {
  verdict: InboundVerdict;
  /** One sentence, safe to log. Never contains message content verbatim. */
  detail: string;
  /** The question to ask Hermes. Present only when verdict is "answer". */
  question?: string;
}

export const DEFAULT_MAX_REPLIES_PER_WINDOW = 30;
export const DEFAULT_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Names that count as addressing the agent when `requireMention` is on. */
export const DEFAULT_MENTION_NAMES = ["hermes", "@hermes"] as const;

function channelOf(event: InboundEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] === "h" && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

function isAddressed(content: string, names: readonly string[]): boolean {
  const lower = content.toLowerCase();
  return names.some((name) => lower.includes(name.toLowerCase()));
}

/**
 * Strip a leading mention so Hermes receives the question rather than its own
 * name. "@hermes is the money path ok?" asks better than the raw string, and a
 * model given its own name as the first token sometimes answers about itself.
 */
function stripLeadingMention(content: string, names: readonly string[]): string {
  let text = content.trim();
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s,:]*`, "i");
    if (pattern.test(text)) {
      text = text.replace(pattern, "").trim();
      break;
    }
  }
  return text;
}

/**
 * Decide what to do with one inbound event.
 *
 * Order is deliberate. Cheap structural checks come first so a busy channel
 * costs nothing, the self check sits ahead of everything that could produce a
 * reply, and the rate limit is evaluated LAST so it counts only messages that
 * would genuinely have been answered — a window burned by our own narration
 * would disarm the guard exactly when it was needed.
 */
export function decideInboundMessage(event: InboundEvent, ctx: InboundContext): InboundDecision {
  if (!ctx.enabled) {
    return { verdict: "ignore-disabled", detail: "inbound replies are switched off" };
  }
  if (event.kind !== KIND_STREAM_MESSAGE) {
    return { verdict: "ignore-kind", detail: `kind ${event.kind} is not a channel message` };
  }

  const channel = channelOf(event);
  if (channel !== ctx.channelId) {
    return {
      verdict: "ignore-channel",
      detail: channel ? "message is tagged for a different channel" : "message carries no channel tag",
    };
  }

  // THE LOOP GUARD. Everything else is housekeeping; this is the one that keeps
  // the agent from talking to itself at socket speed.
  if (event.pubkey === ctx.agentPubkey) {
    return { verdict: "ignore-self", detail: "message was published by this agent" };
  }

  // History, not a question. The relay replays stored events on connect and
  // again after every reconnect; answering them re-answers the last question on
  // each restart.
  if (event.created_at < ctx.startedAtSeconds) {
    return {
      verdict: "ignore-replay",
      detail: `message predates this listener by ${ctx.startedAtSeconds - event.created_at}s`,
    };
  }

  if (ctx.seenEventIds.has(event.id)) {
    return { verdict: "ignore-seen", detail: "this event id was already handled" };
  }

  const trimmed = event.content.trim();
  if (trimmed.length === 0) {
    return { verdict: "ignore-empty", detail: "message has no text" };
  }

  if (ctx.requireMention && !isAddressed(trimmed, ctx.mentionNames)) {
    return { verdict: "ignore-not-addressed", detail: "message does not name the agent" };
  }

  if (ctx.repliesInWindow >= ctx.maxRepliesPerWindow) {
    return {
      verdict: "ignore-rate-limited",
      detail: `already sent ${ctx.repliesInWindow} replies in this window (max ${ctx.maxRepliesPerWindow})`,
    };
  }

  const question = ctx.requireMention ? stripLeadingMention(trimmed, ctx.mentionNames) : trimmed;
  if (question.length === 0) {
    // A message that was ONLY a mention. Nothing was asked.
    return { verdict: "ignore-empty", detail: "message named the agent but asked nothing" };
  }

  return { verdict: "answer", detail: "operator question in the ops channel", question };
}

/**
 * What Hermes is told before the operator's question.
 *
 * The session already IS Hermes — its own system prompt, tools, skills and
 * memory. This adds only what is specific to answering in a chat channel:
 *
 *  · Check the board. The whole point of the read seam is that current state
 *    comes from `averray_board_health`, not from the model's memory of an
 *    earlier reading.
 *  · Say UNKNOWN when the board cannot be reached. Silence and confident
 *    guessing are the two failure modes that make an ops channel worthless.
 *  · Answer, do not act. This is guidance, not enforcement — see the note on
 *    the wiring. It matters anyway: most of the risk here is a well-meaning
 *    agent deciding a question implies a fix.
 *  · Be short. This renders in a chat client, frequently on a phone, and an
 *    answer nobody scrolls through is an answer nobody reads.
 */
export const INBOUND_PREAMBLE = [
  "You are answering the operator in the Averray #Ops channel.",
  "",
  "- Current state comes from the ops board. Call `averray_board_health` and answer from its `verdict.reason`. Never answer about current state from an earlier reading.",
  "- `averray_ops_health` answers a DIFFERENT question: database and control-plane health read from Postgres. It is not the board and not the product verdict. Do not use it to say whether Averray is ok, and never describe something as \"the board\" unless it came from `averray_board_health`.",
  "- If the board cannot be reached, say the state is UNKNOWN. Never infer health from silence.",
  "- Answer the question. Do not take actions, move funds, deploy, or change configuration; you cannot, and claiming otherwise is worse than declining.",
  "- Write like a colleague, not a readout: plain conversational sentences, lead with the answer. Keep every figure, id and probe detail verbatim — reword the words AROUND the facts, never the facts, and never present the state as better or worse than the board says.",
  "- Keep it short — a few lines. This is read in a chat client, often on a phone.",
  "",
  "The operator asks:",
].join("\n");

export function buildInboundPrompt(question: string): string {
  return `${INBOUND_PREAMBLE}\n\n${question}`;
}

/**
 * Practical cap for a chat message, far below the relay's 64 KiB limit.
 *
 * The limit that bites is the reader's, not the protocol's: an ops answer that
 * fills a phone screen is one nobody finishes.
 */
export const MAX_REPLY_CHARS = 3500;

/**
 * Prepare a reply for publication.
 *
 * Returns null when there is nothing to say, so the caller can publish an
 * honest failure line instead of an empty message — `buildStreamMessage`
 * refuses empty content, and an unexplained silence in an ops channel reads as
 * the bot ignoring you rather than as a broken turn.
 */
export function formatReplyForBuzz(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= MAX_REPLY_CHARS) return trimmed;
  // Truncation is marked, never silent. A cut-off ops answer that looks
  // complete is a way to be confidently wrong.
  const kept = trimmed.slice(0, MAX_REPLY_CHARS);
  return `${kept}\n\n… (truncated — ask for the specific part you need)`;
}

/**
 * The line published when the turn produced no answer.
 *
 * A failed turn MUST say something. The alternative is silence, which is
 * indistinguishable from the listener being down — and the entire reason this
 * channel exists is to be the thing you can still trust when other things are
 * broken.
 */
export function describeInboundFailure(reason: string): string {
  return `⚠ I could not answer that — ${reason}. The question was received; this is a failure on my side, not a verdict about the system.`;
}

/** Guard against a reply that somehow exceeds the protocol limit. */
export function replyFitsRelay(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_CONTENT_BYTES;
}
