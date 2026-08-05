// The Hermes-written morning briefing — conversational words, mechanical truth.
//
// The operator asked for the briefing to read like a colleague rather than a
// stat dump, and Hermes — a full LLM — already fronts the channel, so the
// words should genuinely be his. The danger is equally plain: a model
// paraphrasing money facts will eventually improve one. The ops contract
// exists because paraphrase drift burned us before ("read verdict.reason,
// never the headline"), and a briefing is the highest-trust message the
// channel sends.
//
// Resolution: Hermes writes AROUND the facts, and a mechanical gate proves
// the facts survived. The gate extracts every number and hex id from the fact
// strings (the probes' own details — the same strings the board renders) and
// requires each to appear verbatim in the prose; the verdict headline must be
// quoted whole; and the prose may not claim green over a red board. Any miss
// — or the model being down, slow, or empty — sends the plain digest instead.
// The briefing is therefore never absent and never wrong; only sometimes less
// charming.
//
// RESIDUAL, NAMED: the gate is necessary, not sufficient. It cannot detect
// framing drift that keeps every figure — invented worry over a green board,
// soothing sentence-shapes around a named red. The controls there are the
// prompt's hard rules, temperature 0.4, and the operator seeing voice+reason
// in the morning_digest_voice log line. If the prose ever reads wrong, unset
// OLLAMA_API_KEY: the digest loses charm, never truth.
//
// Kept pure of transport: the caller injects a `request` function (bound to
// requestHermesCompletion, the ONE LLM client), so every rule here runs in the
// local unit suite with a stub.

import type { HermesCompletionRequest } from "./monitor-hermes-voice.js";

export interface ConversationalDigestInput {
  /** The deterministic digest — the model's source AND the fallback text. */
  plain: string;
  /** deriveOpsVerdict headline; must survive verbatim, quoted once. */
  verdictHeadline: string;
  /** The strings whose numbers must survive: probe details + the bank line. */
  facts: readonly string[];
  /** Red probe count — a red board must never read as green. */
  redCount: number;
  /**
   * Human labels of every not-ok item. Each must be NAMED in the prose —
   * a red probe whose detail happens to carry no digits ("settlement
   * stalled") would otherwise be droppable without tripping the fact gate.
   */
  attentionLabels?: readonly string[];
  request: (req: HermesCompletionRequest) => Promise<string | null>;
}

export interface ConversationalDigestResult {
  text: string;
  voice: "hermes" | "plain";
  /** Why the plain form went out; absent when voice is "hermes". */
  reason?: string;
}

/**
 * Every number and hex id in the fact strings. "gas ×3.2" yields "3.2", which
 * "3.2×" and "3.2 times" both contain — the gate constrains the FIGURES, not
 * the phrasing around them. Deliberately necessary-not-sufficient: a token the
 * model drops or rewrites ("1,234" → "1234") fails closed to the plain form.
 */
export function digestFactTokens(facts: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const fact of facts) {
    for (const match of fact.match(/0x[0-9a-fA-F]+|\d+(?:[.,]\d+)?/g) ?? []) tokens.add(match);
  }
  return [...tokens];
}

const CLAIMS_ALL_GREEN = /all\s+(?:\d+\s+)?probes?\s+(?:are\s+)?green|all\s+green|all\s+clear/i;

/** Null when the candidate may ship; otherwise the named reason it may not. */
export function conversationalDigestViolation(
  input: Pick<ConversationalDigestInput, "verdictHeadline" | "facts" | "redCount" | "attentionLabels">,
  candidate: string,
): string | null {
  const text = candidate.trim();
  if (!text) return "empty";
  // A briefing longer than the plain form ever gets is the model rambling.
  if (text.length > 1600) return "too_long";
  if (!text.includes(input.verdictHeadline)) return "headline_missing";
  for (const token of digestFactTokens(input.facts)) {
    if (!text.includes(token)) return `fact_missing:${token}`;
  }
  for (const label of input.attentionLabels ?? []) {
    if (!text.toLowerCase().includes(label.toLowerCase())) return `attention_missing:${label}`;
  }
  if (input.redCount > 0 && CLAIMS_ALL_GREEN.test(text)) return "polarity";
  return null;
}

const VOICE_RULES = [
  "You are Hermes, the ops co-pilot for Averray, writing the once-daily briefing to the operator in the #Ops channel.",
  "Rewrite the briefing below as short, warm, conversational PLAIN TEXT — a colleague catching someone up, not a report. No markdown, no headings, no bullet lists.",
  "Hard rules, none negotiable:",
  "- Every number and id in the briefing appears verbatim in your text. Do not round, convert, or drop any.",
  '- Quote the line after "The board reads:" exactly once, verbatim, in double quotes.',
  "- Never present the state as better or worse than the briefing does. If items need attention, name every one of them.",
  "- 4 to 8 sentences. End with the briefing's own closing sense: whether anything is waiting on the operator.",
].join("\n");

export async function composeConversationalDigest(
  input: ConversationalDigestInput,
): Promise<ConversationalDigestResult> {
  let reply: string | null = null;
  try {
    reply = await input.request({
      messages: [
        { role: "system", content: VOICE_RULES },
        {
          role: "user",
          content: `Today's briefing, already correct and complete:\n\n${input.plain}\n\nSay it as yourself.`,
        },
      ],
      maxTokens: 480,
      temperature: 0.4,
    });
  } catch {
    reply = null;
  }
  if (reply === null) return { text: input.plain, voice: "plain", reason: "llm_unavailable" };
  const violation = conversationalDigestViolation(input, reply);
  if (violation) return { text: input.plain, voice: "plain", reason: violation };
  return { text: reply.trim(), voice: "hermes" };
}
