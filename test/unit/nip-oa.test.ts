import { describe, expect, it } from "vitest";

import {
  AUTH_TAG_DOMAIN,
  NipOaError,
  authTagDigest,
  buildAuthPreimage,
  computeAuthTag,
  expiringConditions,
  parseAuthTag,
  validateConditions,
  verifyAuthTag,
} from "../../services/slack-operator/src/nip-oa.js";

// Vectors copied verbatim from docs/nips/NIP-OA.md at tag relay-v0.2.0 — the ref
// of the image running in production. They are the reason this module can be
// trusted before anything is deployed: the preimage and digest are fully
// deterministic, so the byte-level construction is PROVEN rather than plausible.
// Getting the domain separator or the colon placement subtly wrong produces a
// tag that fails at the relay with an auth error indistinguishable from a bad
// key — which is exactly the debugging session these tests exist to prevent.
const OWNER_PUBKEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const AGENT_PUBKEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const AGENT_SECRET = "0000000000000000000000000000000000000000000000000000000000000002";
const CONDITIONS = "kind=1&created_at<1713957000";
const SPEC_DIGEST = "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6";
const SPEC_SIG =
  "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
const SPEC_TAG = JSON.stringify(["auth", OWNER_PUBKEY, CONDITIONS, SPEC_SIG]);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("NIP-OA spec vectors", () => {
  it("builds the exact preimage from the spec", () => {
    expect(buildAuthPreimage(AGENT_PUBKEY, CONDITIONS)).toBe(
      `${AUTH_TAG_DOMAIN}${AGENT_PUBKEY}:${CONDITIONS}`,
    );
    expect(buildAuthPreimage(AGENT_PUBKEY, CONDITIONS)).toBe(
      "nostr:agent-auth:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:kind=1&created_at<1713957000",
    );
  });

  it("hashes the preimage to the digest the spec publishes", () => {
    expect(hex(authTagDigest(AGENT_PUBKEY, CONDITIONS))).toBe(SPEC_DIGEST);
  });

  it("accepts the spec's own signed tag", () => {
    // Verifying a signature we did NOT produce is the strongest available check
    // that our preimage matches the relay's — a self-consistent round trip would
    // pass even if both sides were wrong in the same way.
    expect(verifyAuthTag(SPEC_TAG, AGENT_PUBKEY)).toBe(OWNER_PUBKEY);
  });

  it("mints a tag that verifies (BIP-340 signing is randomized, so compare by verification)", () => {
    const minted = computeAuthTag({
      ownerSecretKeyHex: OWNER_SECRET,
      agentPubkeyHex: AGENT_PUBKEY,
      conditions: CONDITIONS,
    });
    const [label, owner, conditions, signature] = JSON.parse(minted) as string[];
    expect(label).toBe("auth");
    expect(owner).toBe(OWNER_PUBKEY);
    expect(conditions).toBe(CONDITIONS);
    expect(signature).toHaveLength(128);
    expect(verifyAuthTag(minted, AGENT_PUBKEY)).toBe(OWNER_PUBKEY);
  });

  it("rejects a tag presented by an agent key it was not minted for", () => {
    // The whole point of binding the agent key into the preimage: a stolen tag
    // is useless to a different agent.
    const other = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee4";
    expect(() => verifyAuthTag(SPEC_TAG, other)).toThrow(NipOaError);
  });
});

describe("NIP-OA invalid vectors", () => {
  // One case per bullet in the spec's "Invalid Test Vectors" section.
  it("rejects a tag with the wrong element count", () => {
    expect(() => verifyAuthTag(JSON.stringify(["auth", OWNER_PUBKEY, CONDITIONS]), AGENT_PUBKEY)).toThrow(
      /4 elements/,
    );
    expect(() =>
      verifyAuthTag(JSON.stringify(["auth", OWNER_PUBKEY, CONDITIONS, SPEC_SIG, "extra"]), AGENT_PUBKEY),
    ).toThrow(/4 elements/);
  });

  it("rejects a trailing delimiter in conditions", () => {
    expect(() => validateConditions("kind=1&")).toThrow(/empty clause/);
    expect(() => validateConditions("&kind=1")).toThrow(/empty clause/);
    expect(() => validateConditions("kind=1&&kind=2")).toThrow(/empty clause/);
  });

  it("rejects a leading zero in a clause value", () => {
    expect(() => validateConditions("kind=01")).toThrow(/leading zero/);
    // "0" itself is canonical and must still be accepted.
    expect(() => validateConditions("kind=0")).not.toThrow();
  });

  it("rejects self-attestation", () => {
    expect(() =>
      computeAuthTag({ ownerSecretKeyHex: OWNER_SECRET, agentPubkeyHex: OWNER_PUBKEY, conditions: "" }),
    ).toThrow(/self-attestation/);
  });

  it("rejects a well-formed tag whose signature does not verify", () => {
    const tampered = JSON.stringify(["auth", OWNER_PUBKEY, "kind=2&created_at<1713957000", SPEC_SIG]);
    expect(() => verifyAuthTag(tampered, AGENT_PUBKEY)).toThrow(/signature verification failed/);
  });

  it("rejects whitespace and unsupported clauses", () => {
    expect(() => validateConditions("kind=1 & kind=2")).toThrow(/whitespace/);
    expect(() => validateConditions("expires=99")).toThrow(/unsupported clause/);
    expect(() => validateConditions("created_at=99")).toThrow(/unsupported clause/);
  });

  it("enforces the documented value ranges", () => {
    expect(() => validateConditions("kind=65535")).not.toThrow();
    expect(() => validateConditions("kind=65536")).toThrow(/out of range/);
    expect(() => validateConditions("created_at<4294967295")).not.toThrow();
    expect(() => validateConditions("created_at<4294967296")).toThrow(/out of range/);
  });

  it("treats an empty conditions string as valid and unconstrained", () => {
    expect(() => validateConditions("")).not.toThrow();
    const minted = computeAuthTag({
      ownerSecretKeyHex: OWNER_SECRET,
      agentPubkeyHex: AGENT_PUBKEY,
      conditions: "",
    });
    expect(verifyAuthTag(minted, AGENT_PUBKEY)).toBe(OWNER_PUBKEY);
  });
});

describe("parseAuthTag", () => {
  it("accepts a structurally valid tag without doing crypto", () => {
    // Same shape, deliberately bogus signature: the startup path must not need
    // the agent key to tell an operator their config is malformed.
    const bogus = JSON.stringify(["auth", OWNER_PUBKEY, CONDITIONS, "0".repeat(128)]);
    expect(parseAuthTag(bogus)).toEqual({
      ownerPubkey: OWNER_PUBKEY,
      conditions: CONDITIONS,
      signature: "0".repeat(128),
    });
  });

  it("rejects malformed hex lengths", () => {
    expect(() => parseAuthTag(JSON.stringify(["auth", "abc", CONDITIONS, SPEC_SIG]))).toThrow(
      /64 lowercase hex/,
    );
    expect(() => parseAuthTag(JSON.stringify(["auth", OWNER_PUBKEY, CONDITIONS, "ff"]))).toThrow(
      /128 lowercase hex/,
    );
  });

  it("rejects uppercase hex", () => {
    // Nostr convention is lowercase; the relay compares hex strings, so an
    // uppercase pubkey would fail a comparison rather than an obvious check.
    expect(() => parseAuthTag(JSON.stringify(["auth", OWNER_PUBKEY.toUpperCase(), CONDITIONS, SPEC_SIG]))).toThrow(
      /64 lowercase hex/,
    );
  });

  it("rejects non-JSON and non-array input", () => {
    expect(() => parseAuthTag("not json")).toThrow(/not valid JSON/);
    expect(() => parseAuthTag(JSON.stringify({ auth: true }))).toThrow(/array of 4 elements/);
  });
});

describe("expiringConditions", () => {
  it("emits a single created_at clause and no kind clause", () => {
    // The absence of `kind=` is deliberate — the same tag must stay valid on the
    // kind-22242 AUTH event as well as the kind-9 messages it authorizes.
    const conditions = expiringConditions(1913957000);
    expect(conditions).toBe("created_at<1913957000");
    expect(conditions).not.toContain("kind=");
    expect(() => validateConditions(conditions)).not.toThrow();
  });

  it("produces conditions that survive a real mint/verify round trip", () => {
    const minted = computeAuthTag({
      ownerSecretKeyHex: AGENT_SECRET,
      agentPubkeyHex: OWNER_PUBKEY,
      conditions: expiringConditions(1913957000),
    });
    expect(verifyAuthTag(minted, OWNER_PUBKEY)).toBe(AGENT_PUBKEY);
  });

  it("rejects a non-integer or out-of-range expiry", () => {
    expect(() => expiringConditions(1.5)).toThrow(NipOaError);
    expect(() => expiringConditions(-1)).toThrow(NipOaError);
    expect(() => expiringConditions(4294967296)).toThrow(NipOaError);
  });
});
