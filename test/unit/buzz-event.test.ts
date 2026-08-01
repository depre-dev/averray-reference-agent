import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";

import {
  BuzzEventError,
  KIND_CLIENT_AUTH,
  KIND_PROFILE,
  KIND_STREAM_MESSAGE,
  MAX_CONTENT_BYTES,
  agentPubkey,
  authTagFromConfig,
  buildAuthEvent,
  buildProfileEvent,
  buildStreamMessage,
  computeEventId,
  serializeForId,
  signEvent,
} from "../../services/slack-operator/src/buzz-event.js";

const AGENT_SECRET = "0000000000000000000000000000000000000000000000000000000000000002";
const AGENT_PUBKEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const OWNER_PUBKEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AUTH_TAG = ["auth", OWNER_PUBKEY, "created_at<1913957000", "ab".repeat(64)];
const CHANNEL = "3f2a9c10-5b6d-4e7f-8a91-2c3d4e5f6a7b";

describe("event serialization", () => {
  it("serializes exactly as NIP-01 specifies", () => {
    // The id is a hash of THESE bytes. A stray space or a reordered field
    // yields a valid-looking event the relay rejects as a bad signature, with
    // no way to tell from the rejection what went wrong.
    const event = {
      pubkey: AGENT_PUBKEY,
      created_at: 1713956400,
      kind: 9,
      tags: [["h", CHANNEL]],
      content: "money path degraded",
    };
    expect(serializeForId(event)).toBe(
      `[0,"${AGENT_PUBKEY}",1713956400,9,[["h","${CHANNEL}"]],"money path degraded"]`,
    );
    expect(serializeForId(event)).not.toContain(" \n");
  });

  it("escapes control characters the way NIP-01 requires", () => {
    const event = {
      pubkey: AGENT_PUBKEY,
      created_at: 1,
      kind: 9,
      tags: [],
      content: 'line\nbreak\ttab "quote" \\slash',
    };
    // Exactly the escapes the spec named, not a \u000a form.
    expect(serializeForId(event)).toContain('"line\\nbreak\\ttab \\"quote\\" \\\\slash"');
  });

  it("keeps non-ASCII literal rather than \\u-escaping it", () => {
    // The id is hashed over UTF-8 bytes; escaping would change them.
    const event = { pubkey: AGENT_PUBKEY, created_at: 1, kind: 9, tags: [], content: "réserve → 0" };
    expect(serializeForId(event)).toContain("réserve → 0");
  });

  it("produces a 32-byte id that changes with any field", () => {
    const base = { pubkey: AGENT_PUBKEY, created_at: 1713956400, kind: 9, tags: [], content: "a" };
    const id = computeEventId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventId({ ...base, content: "b" })).not.toBe(id);
    expect(computeEventId({ ...base, created_at: 1713956401 })).not.toBe(id);
    expect(computeEventId({ ...base, tags: [["h", CHANNEL]] })).not.toBe(id);
  });
});

describe("signing", () => {
  it("signs an event whose signature verifies against its own id", () => {
    const unsigned = buildStreamMessage({
      agentPubkeyHex: AGENT_PUBKEY,
      channelId: CHANNEL,
      content: "verdict RED — payout shortfall",
      createdAt: 1713956400,
    });
    const signed = signEvent(unsigned, AGENT_SECRET);
    expect(signed.id).toBe(computeEventId(unsigned));
    expect(schnorr.verify(signed.sig, Buffer.from(signed.id, "hex"), AGENT_PUBKEY)).toBe(true);
  });

  it("refuses to sign for a pubkey the key does not own", () => {
    // Catching this locally matters: the relay's rejection is just
    // "invalid: bad signature", which says nothing about the cause.
    const unsigned = buildStreamMessage({
      agentPubkeyHex: OWNER_PUBKEY,
      channelId: CHANNEL,
      content: "x",
      createdAt: 1,
    });
    expect(() => signEvent(unsigned, AGENT_SECRET)).toThrow(/does not match the signing key/);
  });

  it("rejects a malformed secret key", () => {
    const unsigned = buildStreamMessage({ agentPubkeyHex: AGENT_PUBKEY, channelId: CHANNEL, content: "x", createdAt: 1 });
    expect(() => signEvent(unsigned, "nope")).toThrow(/64 lowercase hex/);
  });

  it("derives the agent pubkey from its secret", () => {
    expect(agentPubkey(AGENT_SECRET)).toBe(AGENT_PUBKEY);
  });
});

describe("buildStreamMessage", () => {
  it("is kind 9 addressed by the channel UUID in an h tag", () => {
    const event = buildStreamMessage({
      agentPubkeyHex: AGENT_PUBKEY,
      channelId: CHANNEL,
      content: "hello",
      createdAt: 1713956400,
      authTag: AUTH_TAG,
    });
    expect(event.kind).toBe(KIND_STREAM_MESSAGE);
    expect(event.tags[0]).toEqual(["h", CHANNEL]);
    expect(event.tags).toContainEqual(AUTH_TAG);
  });

  it("rejects a channel name where a UUID belongs", () => {
    // A name would be accepted-looking and post nowhere, or somewhere else.
    expect(() =>
      buildStreamMessage({ agentPubkeyHex: AGENT_PUBKEY, channelId: "#ops", content: "x", createdAt: 1 }),
    ).toThrow(/must be a lowercase UUID/);
  });

  it("refuses empty content and content over the relay's limit", () => {
    expect(() =>
      buildStreamMessage({ agentPubkeyHex: AGENT_PUBKEY, channelId: CHANNEL, content: "", createdAt: 1 }),
    ).toThrow(/empty message/);
    expect(() =>
      buildStreamMessage({
        agentPubkeyHex: AGENT_PUBKEY,
        channelId: CHANNEL,
        content: "x".repeat(MAX_CONTENT_BYTES + 1),
        createdAt: 1,
      }),
    ).toThrow(/over the 65536 limit/);
  });

  it("measures the limit in BYTES, not characters", () => {
    // A multi-byte character would slip past a .length check and be refused by
    // the relay instead — a failure that only shows up with non-ASCII text.
    const content = "é".repeat(MAX_CONTENT_BYTES / 2);
    expect(Buffer.byteLength(content, "utf8")).toBe(MAX_CONTENT_BYTES);
    expect(() =>
      buildStreamMessage({ agentPubkeyHex: AGENT_PUBKEY, channelId: CHANNEL, content: `${content}é`, createdAt: 1 }),
    ).toThrow(/over the 65536 limit/);
  });

  it("omits the auth tag when none is supplied", () => {
    const event = buildStreamMessage({ agentPubkeyHex: AGENT_PUBKEY, channelId: CHANNEL, content: "x", createdAt: 1 });
    expect(event.tags).toEqual([["h", CHANNEL]]);
  });
});

describe("buildProfileEvent", () => {
  it("is kind 0 with a JSON object of the set fields and no channel tag", () => {
    // A profile is not addressed to a channel — it describes the KEY, and every
    // client that renders any of its messages reads it.
    const event = buildProfileEvent({
      agentPubkeyHex: AGENT_PUBKEY,
      profile: { displayName: "Hermes", name: "hermes", about: "Averray ops monitor." },
      createdAt: 1713956400,
      authTag: AUTH_TAG,
    });
    expect(event.kind).toBe(KIND_PROFILE);
    expect(event.tags).toEqual([AUTH_TAG]);
    expect(JSON.parse(event.content)).toEqual({
      display_name: "Hermes",
      name: "hermes",
      about: "Averray ops monitor.",
    });
  });

  it("omits unset and empty fields rather than writing empty strings", () => {
    // An empty string is a VALUE in kind 0 — it would blank the field for every
    // reader, which is not the same as leaving it alone.
    const event = buildProfileEvent({
      agentPubkeyHex: AGENT_PUBKEY,
      profile: { displayName: "Hermes", about: "", picture: undefined },
      createdAt: 1,
    });
    expect(JSON.parse(event.content)).toEqual({ display_name: "Hermes" });
    expect(event.tags).toEqual([]);
  });

  it("refuses a wholly empty profile", () => {
    // Publishing {} would REPLACE the existing profile with nothing, since kind
    // 0 is replaceable. Silently erasing a name is worse than refusing.
    expect(() =>
      buildProfileEvent({ agentPubkeyHex: AGENT_PUBKEY, profile: {}, createdAt: 1 }),
    ).toThrow(/empty profile/);
  });

  it("signs and verifies like any other event", () => {
    const signed = signEvent(
      buildProfileEvent({ agentPubkeyHex: AGENT_PUBKEY, profile: { displayName: "Hermes" }, createdAt: 1 }),
      AGENT_SECRET,
    );
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toHaveLength(128);
  });
});

describe("buildAuthEvent", () => {
  it("is kind 22242 carrying relay, challenge, and the owner attestation", () => {
    const event = buildAuthEvent({
      agentPubkeyHex: AGENT_PUBKEY,
      relayUrl: "wss://buzz.averray.com",
      challenge: "abc123",
      createdAt: 1713956400,
      authTag: AUTH_TAG,
    });
    expect(event.kind).toBe(KIND_CLIENT_AUTH);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["relay", "wss://buzz.averray.com"],
      ["challenge", "abc123"],
      AUTH_TAG,
    ]);
  });

  it("refuses an empty challenge", () => {
    expect(() =>
      buildAuthEvent({
        agentPubkeyHex: AGENT_PUBKEY,
        relayUrl: "wss://buzz.averray.com",
        challenge: "",
        createdAt: 1,
        authTag: AUTH_TAG,
      }),
    ).toThrow(BuzzEventError);
  });
});

describe("authTagFromConfig", () => {
  it("parses the tag exactly as the mint script prints it", () => {
    expect(authTagFromConfig(JSON.stringify(AUTH_TAG))).toEqual(AUTH_TAG);
  });

  it("tolerates one layer of wrapping quotes", () => {
    // Wrapping a JSON value in quotes is the natural instinct when pasting into
    // a .env file, and silently failing on it would waste a deploy cycle.
    expect(authTagFromConfig(`'${JSON.stringify(AUTH_TAG)}'`)).toEqual(AUTH_TAG);
    expect(authTagFromConfig(`"${JSON.stringify(AUTH_TAG)}"`)).toEqual(AUTH_TAG);
  });

  it("gives an actionable error when a .env line break truncated the value", () => {
    // The realistic failure is NOT a multiline JSON string arriving here — a
    // .env parser reads line by line, so a wrapped value reaches us CUT OFF at
    // the newline. That truncation is what must produce a pointed error.
    const full = JSON.stringify(AUTH_TAG);
    const truncated = full.slice(0, full.indexOf(",", 40));
    expect(() => authTagFromConfig(truncated)).toThrow(/ONE line/);
  });

  it("accepts a complete value even if it arrived with internal whitespace", () => {
    // JSON permits whitespace between tokens, so a complete-but-reflowed array
    // is still valid and there is nothing to gain by rejecting it. Worth
    // pinning: an earlier version of this test assumed the opposite.
    const spaced = JSON.stringify(AUTH_TAG).replace(",", ",\n  ");
    expect(authTagFromConfig(spaced)).toEqual(AUTH_TAG);
  });

  it("rejects a tag of the wrong shape", () => {
    expect(() => authTagFromConfig(JSON.stringify(["auth", OWNER_PUBKEY]))).toThrow(/4 strings/);
    expect(() => authTagFromConfig(JSON.stringify(["nope", OWNER_PUBKEY, "", "ab"]))).toThrow(/must start with "auth"/);
  });
});
