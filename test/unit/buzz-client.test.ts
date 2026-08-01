import { describe, expect, it } from "vitest";

import {
  publishNarration,
  readBuzzConfig,
  type BuzzConfig,
} from "../../services/slack-operator/src/buzz-client.js";
import { agentPubkey, computeEventId } from "../../services/slack-operator/src/buzz-event.js";

const AGENT_SECRET = "0000000000000000000000000000000000000000000000000000000000000002";
const OWNER_PUBKEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AUTH_TAG = ["auth", OWNER_PUBKEY, "created_at<1913957000", "ab".repeat(64)];
const CHANNEL = "3f2a9c10-5b6d-4e7f-8a91-2c3d4e5f6a7b";

const config: BuzzConfig = {
  relayUrl: "wss://buzz.example.com",
  agentSecretKeyHex: AGENT_SECRET,
  authTag: AUTH_TAG,
  channelId: CHANNEL,
};

type Handler = (event: any) => void;

/**
 * A relay that behaves like Buzz: challenge on connect, then answer the EVENT.
 * `script` decides how it responds, so each failure mode is reproducible without
 * a network.
 */
function fakeRelay(script: {
  challenge?: string | null;
  onEvent?: (event: any) => unknown[] | null;
  failOpen?: boolean;
  closeAfterAuth?: boolean;
}) {
  const sent: unknown[][] = [];
  const handlers = new Map<string, Handler[]>();
  const emit = (type: string, payload: unknown) => {
    for (const h of handlers.get(type) ?? []) h(payload);
  };

  const socket = {
    send(data: string) {
      const frame = JSON.parse(data) as unknown[];
      sent.push(frame);
      if (frame[0] === "EVENT") {
        if (script.closeAfterAuth) {
          queueMicrotask(() => emit("close", {}));
          return;
        }
        const reply = script.onEvent?.(frame[1]);
        if (reply) queueMicrotask(() => emit("message", { data: JSON.stringify(reply) }));
      }
    },
    close() {},
    addEventListener(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      if (type === "message" && script.challenge) {
        // The relay speaks first — the client must not send anything before it.
        queueMicrotask(() => emit("message", { data: JSON.stringify(["AUTH", script.challenge]) }));
      }
      if (type === "error" && script.failOpen) queueMicrotask(() => emit("error", {}));
    },
  };
  return { socket, sent, openSocket: () => socket as any };
}

describe("publishNarration", () => {
  it("completes the handshake and reports the accepted event id", async () => {
    const relay = fakeRelay({
      challenge: "chal-123",
      onEvent: (event) => ["OK", event.id, true, ""],
    });
    const result = await publishNarration(config, "money path degraded", {
      openSocket: relay.openSocket,
      nowSeconds: 1713956400,
    });

    expect(result).toMatchObject({ ok: true, reason: "published" });
    expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);

    const [authFrame, eventFrame] = relay.sent;
    expect(authFrame[0]).toBe("AUTH");
    expect(eventFrame[0]).toBe("EVENT");

    // The AUTH event must carry the challenge AND the owner attestation —
    // without the latter this closed relay refuses a non-member agent.
    const auth = authFrame[1] as { kind: number; tags: string[][]; pubkey: string };
    expect(auth.kind).toBe(22242);
    expect(auth.tags).toContainEqual(["challenge", "chal-123"]);
    expect(auth.tags).toContainEqual(AUTH_TAG);
    expect(auth.pubkey).toBe(agentPubkey(AGENT_SECRET));

    // The message is kind 9 addressed to the channel UUID, and its id is
    // genuinely the hash of what was sent.
    const message = eventFrame[1] as any;
    expect(message.kind).toBe(9);
    expect(message.tags).toContainEqual(["h", CHANNEL]);
    expect(message.id).toBe(
      computeEventId({
        pubkey: message.pubkey,
        created_at: message.created_at,
        kind: message.kind,
        tags: message.tags,
        content: message.content,
      }),
    );
  });

  it("reports a rejection reason rather than claiming success", async () => {
    // A narration channel that silently drops alerts is worse than one visibly
    // off, so a false OK must never be reported as published.
    const relay = fakeRelay({
      challenge: "c",
      onEvent: (event) => ["OK", event.id, false, "blocked: rate-limited"],
    });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("publish-rejected");
    expect(result.detail).toContain("rate-limited");
  });

  it("distinguishes an auth refusal from a generic rejection", async () => {
    // Membership problems need a different operator response than a transient
    // publish failure, so they must not collapse into one reason.
    const relay = fakeRelay({
      challenge: "c",
      onEvent: (event) => ["OK", event.id, false, "auth-required: not a relay member"],
    });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket });
    expect(result.reason).toBe("auth-rejected");
  });

  it("ignores an OK for somebody else's event", async () => {
    // Concurrent traffic on the socket must not settle our publish.
    const relay = fakeRelay({
      challenge: "c",
      onEvent: () => ["OK", "f".repeat(64), true, ""],
    });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket, timeoutMs: 60 });
    expect(result.reason).toBe("timeout");
  });

  it("does not treat a NOTICE as a verdict", async () => {
    const relay = fakeRelay({ challenge: "c", onEvent: () => ["NOTICE", "heads up"] });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket, timeoutMs: 60 });
    expect(result.reason).toBe("timeout");
  });

  it("times out rather than hanging when the relay never challenges", async () => {
    const relay = fakeRelay({ challenge: null });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket, timeoutMs: 50 });
    expect(result.reason).toBe("timeout");
    expect(result.detail).toContain("never got an AUTH challenge");
  });

  it("reports a connect failure without throwing", async () => {
    const relay = fakeRelay({ failOpen: true });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket });
    expect(result).toMatchObject({ ok: false, reason: "connect-failed" });
  });

  it("reads a close after AUTH as an auth rejection", async () => {
    // Buzz drops the connection on some refusals instead of sending OK=false.
    const relay = fakeRelay({ challenge: "c", closeAfterAuth: true });
    const result = await publishNarration(config, "hi", { openSocket: relay.openSocket });
    expect(result.reason).toBe("auth-rejected");
  });

  it("never throws on bad input — it degrades", async () => {
    // The heartbeat calls this. A throw here would take down the monitor that
    // watches the money path, for a notification channel.
    const result = await publishNarration({ ...config, channelId: "#ops" }, "hi", {
      openSocket: fakeRelay({ challenge: "c" }).openSocket,
    });
    expect(result).toMatchObject({ ok: false, reason: "misconfigured" });
    expect(result.detail).toContain("UUID");
  });

  it("surfaces a socket constructor failure as connect-failed", async () => {
    const result = await publishNarration(config, "hi", {
      openSocket: () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "connect-failed" });
    expect(result.detail).toContain("ENOTFOUND");
  });
});

describe("readBuzzConfig", () => {
  const full = {
    BUZZ_RELAY_URL: "wss://buzz.averray.com",
    BUZZ_AGENT_SECRET_KEY: AGENT_SECRET,
    BUZZ_OWNER_AUTH_TAG: JSON.stringify(AUTH_TAG),
    BUZZ_OPS_CHANNEL_ID: CHANNEL,
  } as unknown as NodeJS.ProcessEnv;

  it("reads a complete configuration", () => {
    const result = readBuzzConfig(full);
    expect(result.config).toMatchObject({ relayUrl: "wss://buzz.averray.com", channelId: CHANNEL });
  });

  it("treats no configuration as OFF, not as a problem", () => {
    // Buzz is unconfigured until the credentials land. Reporting that as an
    // error every heartbeat is how a board teaches its operator to ignore it.
    expect(readBuzzConfig({} as NodeJS.ProcessEnv)).toEqual({ config: null, problem: null });
  });

  it("treats PARTIAL configuration as a problem", () => {
    // Somebody meant to turn this on and left it broken. That must not look
    // the same as "off".
    const { BUZZ_OPS_CHANNEL_ID, ...partial } = full as Record<string, string>;
    const result = readBuzzConfig(partial as NodeJS.ProcessEnv);
    expect(result.config).toBeNull();
    expect((result as { problem: string }).problem).toContain("BUZZ_OPS_CHANNEL_ID");
  });

  it("rejects a tag minted for a different agent key at startup", () => {
    // Catching this at boot beats discovering it during the first real incident.
    const selfAttested = JSON.stringify(["auth", agentPubkey(AGENT_SECRET), "", "ab".repeat(64)]);
    const result = readBuzzConfig({ ...full, BUZZ_OWNER_AUTH_TAG: selfAttested } as NodeJS.ProcessEnv);
    expect(result.config).toBeNull();
    expect((result as { problem: string }).problem).toContain("self-attestation");
  });

  it("explains a truncated auth tag instead of failing obscurely", () => {
    const truncated = JSON.stringify(AUTH_TAG).slice(0, 40);
    const result = readBuzzConfig({ ...full, BUZZ_OWNER_AUTH_TAG: truncated } as NodeJS.ProcessEnv);
    expect(result.config).toBeNull();
    expect((result as { problem: string }).problem).toContain("ONE line");
  });
});
