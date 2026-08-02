// Wiring: turn config into a running listener, or say precisely why not.
//
// Kept out of index.ts because the interesting part is the REFUSALS. Three
// separate things must be true before this can answer a question — Buzz
// credentials, the inbound switch, and a reachable agent gateway — and each
// missing one produces a different operator action. Collapsing them into "not
// started" would hide which.
//
// ── A LISTENER THAT CANNOT ANSWER MUST NOT LISTEN ───────────────────────────
//
// If the Hermes gateway is not configured, this refuses to open the socket at
// all rather than connecting and failing per question. A channel where every
// question gets an error reply is worse than one that was never claimed to
// work: the operator would be told, message by message, about a configuration
// problem that is the same problem every time.
//
// ── ON THE READ-ONLY BOUNDARY, HONESTLY ─────────────────────────────────────
//
// The prompt tells Hermes to answer rather than act. That is GUIDANCE, not
// enforcement — the session carries whatever MCP tools it has, and some of them
// mutate. What actually bounds the blast radius is that the relay is closed
// (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`) and the channel has one member, so the
// only person who can ask anything is the operator who could run those tools
// directly. That is an acceptable boundary for a private ops channel and NOT an
// acceptable one for a shared or public channel. If Buzz ever gains members,
// this needs tool-level scoping before it stays on.
//
// Default OFF for exactly that reason.

import { logger } from "@avg/mcp-common";

import { publishNarration, readBuzzConfig, type BuzzConfig } from "./buzz-client.js";
import { agentPubkey } from "./buzz-event.js";
import {
  DEFAULT_MAX_REPLIES_PER_WINDOW,
  DEFAULT_MENTION_NAMES,
  DEFAULT_RATE_WINDOW_MS,
  buildInboundPrompt,
} from "./buzz-inbound.js";
import { BuzzResponder } from "./buzz-responder.js";
import { subscribeToBuzz, type BuzzSubscription, type ListenerState } from "./buzz-subscribe.js";
import { chatWithHermesSession } from "./hermes-session-client.js";
import { resolveHermesSessionConfig } from "./monitor-hermes-voice.js";

function isOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export interface InboundStartResult {
  started: boolean;
  /** Why it did or did not start. Always set, always operator-facing. */
  reason: string;
  subscription?: BuzzSubscription;
  responder?: BuzzResponder;
}

/**
 * Start the inbound listener if everything it needs is present.
 *
 * Returns rather than throws: the monitor's job is watching the money path, and
 * a chat feature failing to start must never be the reason it does not run.
 */
export function startBuzzInbound(env: NodeJS.ProcessEnv = process.env): InboundStartResult {
  if (!isOn(env.BUZZ_INBOUND_ENABLED)) {
    return { started: false, reason: "BUZZ_INBOUND_ENABLED is not set — inbound replies are off" };
  }

  const buzz = readBuzzConfig(env);
  if (!buzz.config) {
    return {
      started: false,
      reason: buzz.problem ?? "Buzz is not configured — no relay credentials",
    };
  }

  const session = resolveHermesSessionConfig(env);
  if (!session) {
    // The refusal that matters most. See the header: connecting without a way
    // to answer turns one configuration problem into one error per question.
    return {
      started: false,
      reason:
        "the Hermes gateway is not configured (HERMES_SESSION_API_ENABLED / HERMES_API_URL / HERMES_API_TOKEN) — "
        + "refusing to listen for questions that could not be answered",
    };
  }

  let pubkey: string;
  try {
    pubkey = agentPubkey(buzz.config.agentSecretKeyHex);
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const maxPerHour = Number(env.BUZZ_INBOUND_MAX_REPLIES_PER_HOUR);
  const startedAtSeconds = Math.floor(Date.now() / 1000);

  // One session across questions, so a follow-up like "and solvency?" means
  // what the operator intends. Reset on failure by simply not updating the id.
  let sessionId: string | undefined;

  const responder = new BuzzResponder(
    {
      agentPubkey: pubkey,
      channelId: buzz.config.channelId,
      startedAtSeconds,
      maxRepliesPerWindow:
        Number.isFinite(maxPerHour) && maxPerHour > 0 ? maxPerHour : DEFAULT_MAX_REPLIES_PER_WINDOW,
      rateWindowMs: DEFAULT_RATE_WINDOW_MS,
      requireMention: isOn(env.BUZZ_INBOUND_REQUIRE_MENTION),
      mentionNames: DEFAULT_MENTION_NAMES,
      enabled: true,
    },
    {
      ask: async (question) => {
        const turn = await chatWithHermesSession(session, buildInboundPrompt(question), sessionId);
        if (!turn) return null;
        sessionId = turn.sessionId;
        return turn.text;
      },
      publish: async (text) => {
        const result = await publishNarration(buzz.config as BuzzConfig, text);
        return { ok: result.ok, detail: result.detail };
      },
      log: (line) => logger.info({ line }, "buzz_inbound"),
    },
  );

  const subscription = subscribeToBuzz(
    buzz.config,
    {
      onMessage: (event) => responder.handle(event),
      onState: (state: ListenerState) => {
        // Phase changes are rare and each one is operationally meaningful, so
        // all of them are logged. A listener that is retrying looks exactly
        // like a channel nobody has posted in; the log is where that difference
        // is visible until the board carries the row.
        logger.info({ phase: state.phase, detail: state.detail, failures: state.failures }, "buzz_listener");
      },
    },
    { sinceSeconds: startedAtSeconds },
  );

  return {
    started: true,
    reason: `listening on ${buzz.config.relayUrl} for channel ${buzz.config.channelId}`,
    subscription,
    responder,
  };
}
