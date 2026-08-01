// The Buzz publish transport: open a WebSocket, complete the NIP-42 AUTH
// handshake carrying the NIP-OA owner attestation, publish one event, close.
//
// SHORT-LIVED CONNECTIONS ON PURPOSE. Narration is edge-triggered and rare —
// `decideOpsNarration` speaks when the verdict crosses the red boundary, not on
// a cadence. A persistent socket for that traffic buys nothing and costs the
// thing we can least afford: reconnect logic, backoff state, and a socket that
// can be silently half-dead for hours inside the process whose entire job is
// noticing when something has gone quiet. A connection per message either works
// or reports why, every time.
//
// NOTHING HERE THROWS INTO THE HEARTBEAT. Every failure becomes a
// `BuzzPublishResult` with a reason. Buzz is a downstream notification surface;
// if it is unreachable, the monitor must carry on watching the money path and
// say so, not crash or stall. That is the same rule the disk probe taught us:
// the thing meant to warn you must not die with the thing it watches.

import {
  BuzzEventError,
  agentPubkey,
  authTagFromConfig,
  buildAuthEvent,
  buildStreamMessage,
  signEvent,
  type NostrEvent,
} from "./buzz-event.js";

export interface BuzzConfig {
  relayUrl: string;
  agentSecretKeyHex: string;
  authTag: string[];
  channelId: string;
}

export type BuzzPublishReason =
  | "published"
  | "disabled"
  | "misconfigured"
  | "connect-failed"
  | "auth-rejected"
  | "publish-rejected"
  | "timeout";

export interface BuzzPublishResult {
  ok: boolean;
  reason: BuzzPublishReason;
  /** Operator-facing sentence. Safe to log; never contains the secret key. */
  detail: string;
  eventId?: string;
}

/** Whole handshake + publish budget. Well inside the monitor's tick. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Read config from the environment. Returns null when Buzz is simply not
 * configured — the common case until the credentials are deployed, and NOT an
 * error to report every heartbeat.
 *
 * A PARTIAL configuration is an error, though: it means somebody intended to
 * turn this on and left it broken, which must not look the same as "off".
 */
export function readBuzzConfig(env: NodeJS.ProcessEnv = process.env):
  | { config: BuzzConfig }
  | { config: null; problem: string | null } {
  const relayUrl = env.BUZZ_RELAY_URL?.trim() ?? "";
  const secret = env.BUZZ_AGENT_SECRET_KEY?.trim() ?? "";
  const rawTag = env.BUZZ_OWNER_AUTH_TAG?.trim() ?? "";
  const channelId = env.BUZZ_OPS_CHANNEL_ID?.trim() ?? "";

  const present = [relayUrl, secret, rawTag, channelId].filter((v) => v.length > 0).length;
  if (present === 0) return { config: null, problem: null };
  if (present < 4) {
    const missing = [
      relayUrl ? null : "BUZZ_RELAY_URL",
      secret ? null : "BUZZ_AGENT_SECRET_KEY",
      rawTag ? null : "BUZZ_OWNER_AUTH_TAG",
      channelId ? null : "BUZZ_OPS_CHANNEL_ID",
    ].filter((v): v is string => v !== null);
    return { config: null, problem: `Buzz is partially configured — missing ${missing.join(", ")}` };
  }

  try {
    const authTag = authTagFromConfig(rawTag);
    // Fail at startup, not at the first incident, if the tag was minted for a
    // different agent key than the one deployed beside it.
    const pubkey = agentPubkey(secret);
    if (authTag[1] === pubkey) {
      return { config: null, problem: "BUZZ_OWNER_AUTH_TAG names the agent key as its own owner (self-attestation)" };
    }
    return { config: { relayUrl, agentSecretKeyHex: secret, authTag, channelId } };
  } catch (error) {
    return { config: null, problem: error instanceof BuzzEventError ? error.message : String(error) };
  }
}

interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", handler: (event: any) => void): void;
}

export interface PublishOptions {
  timeoutMs?: number;
  nowSeconds?: number;
  /** Injected for tests; defaults to the global WebSocket (Node >= 22.4). */
  openSocket?: (url: string) => Socket;
}

function defaultOpenSocket(url: string): Socket {
  if (typeof WebSocket === "undefined") {
    throw new BuzzEventError("global WebSocket is unavailable — Node 22.4+ is required to reach Buzz");
  }
  return new WebSocket(url) as unknown as Socket;
}

/**
 * Publish one narration message.
 *
 * The relay drives the handshake: it sends `["AUTH", <challenge>]` on connect,
 * we answer with a signed kind-22242 event carrying the owner attestation, and
 * only then is `["EVENT", …]` accepted. We wait for the `OK` frame rather than
 * assuming success — a fire-and-forget publish against a closed relay looks
 * identical whether it landed or was silently refused, and a narration channel
 * that quietly drops alerts is worse than one that is visibly off.
 */
export async function publishNarration(
  config: BuzzConfig,
  content: string,
  options: PublishOptions = {},
): Promise<BuzzPublishResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const createdAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const openSocket = options.openSocket ?? defaultOpenSocket;

  let message: NostrEvent;
  let pubkey: string;
  try {
    pubkey = agentPubkey(config.agentSecretKeyHex);
    message = signEvent(
      buildStreamMessage({
        agentPubkeyHex: pubkey,
        channelId: config.channelId,
        content,
        createdAt,
        authTag: config.authTag,
      }),
      config.agentSecretKeyHex,
    );
  } catch (error) {
    // Building the event cannot fail transiently — bad config or bad content.
    return {
      ok: false,
      reason: "misconfigured",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  return await new Promise<BuzzPublishResult>((resolve) => {
    let socket: Socket;
    let settled = false;
    let authSent = false;

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: "timeout",
        detail: `no response from ${config.relayUrl} within ${timeoutMs}ms${authSent ? " after AUTH" : " (never got an AUTH challenge)"}`,
      });
    }, timeoutMs);

    function finish(result: BuzzPublishResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing a socket that never opened is not a publish failure.
      }
      resolve(result);
    }

    try {
      socket = openSocket(config.relayUrl);
    } catch (error) {
      finish({
        ok: false,
        reason: "connect-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    socket.addEventListener("error", () => {
      // The WS error event carries no useful detail by design (it would leak
      // network internals to page scripts); the URL is the actionable part.
      finish({ ok: false, reason: "connect-failed", detail: `could not reach ${config.relayUrl}` });
    });

    socket.addEventListener("close", () => {
      finish({
        ok: false,
        reason: authSent ? "auth-rejected" : "connect-failed",
        detail: `relay closed the connection${authSent ? " after AUTH" : " before sending a challenge"}`,
      });
    });

    socket.addEventListener("message", (event: { data: unknown }) => {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return; // A frame we cannot parse is not ours to act on.
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

      if (frame[0] === "AUTH" && typeof frame[1] === "string") {
        try {
          const auth = signEvent(
            buildAuthEvent({
              agentPubkeyHex: pubkey,
              relayUrl: config.relayUrl,
              challenge: frame[1],
              createdAt,
              authTag: config.authTag,
            }),
            config.agentSecretKeyHex,
          );
          socket.send(JSON.stringify(["AUTH", auth]));
          authSent = true;
          // Publish immediately: the relay applies the session's new authority
          // to subsequent frames, and waiting for an OK on the AUTH event costs
          // a round trip for no added certainty — a rejected AUTH shows up as a
          // rejected EVENT with a reason.
          socket.send(JSON.stringify(["EVENT", message]));
        } catch (error) {
          finish({
            ok: false,
            reason: "misconfigured",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (frame[0] === "OK" && frame[1] === message.id) {
        if (frame[2] === true) {
          finish({ ok: true, reason: "published", detail: "relay accepted the message", eventId: message.id });
        } else {
          const why = typeof frame[3] === "string" && frame[3] ? frame[3] : "no reason given";
          // The relay prefixes membership refusals; surfacing the raw string
          // keeps an auth problem from being reported as a generic failure.
          finish({
            ok: false,
            reason: /auth|restricted|member/i.test(why) ? "auth-rejected" : "publish-rejected",
            detail: `relay rejected the message: ${why}`,
          });
        }
        return;
      }

      if (frame[0] === "NOTICE" && typeof frame[1] === "string") {
        // NOTICE is advisory and may arrive alongside a successful publish, so
        // it must not settle the promise on its own.
        return;
      }
    });
  });
}
