// NIP-OA — Owner Attestation. The credential that lets Hermes speak on Buzz
// without the monitor ever holding the operator's key.
//
// WHY THIS EXISTS: buzz.averray.com runs closed —
// `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` with a single member, the operator. A bot
// that just connects and posts is rejected. NIP-OA is the relay's answer: an
// agent presents a tag proving its OWNER is a member, and gets session-scoped
// access on that basis (`BUZZ_ALLOW_NIP_OA_AUTH=true`).
//
// The property that makes this worth implementing rather than working around:
// the owner signs ONCE, offline. The spec calls the tag "a reusable capability:
// the same tag MAY appear on multiple events by the same agent key". So the
// operator mints a tag on their own machine and we deploy the resulting
// SIGNATURE. The owner secret never reaches the VPS, never enters an env file,
// and is not what an attacker gets by reading `.env.prod`.
//
// Authorship stays honest, which is the other reason not to fake this with a
// shared key: `event.pubkey` remains the agent's. The spec is explicit that
// relays "MUST NOT rewrite event authorship" and clients "MUST NOT display the
// owner key as the author". Narration reads as Hermes speaking with the
// operator's authorization — never as the operator.
//
// ── WHAT THE CONDITIONS DO NOT DO ──────────────────────────────────────────
// Read this before treating `created_at<…` as an expiry.
//
// The relay's verifier is `verify_auth_tag(auth_tag_json, agent_pubkey)` — it
// takes the tag and the agent key and NO EVENT. It validates the conditions
// SYNTACTICALLY and checks the signature over the preimage. It never evaluates
// a clause against an event. On Buzz's membership path the conditions are part
// of the signed string and nothing more.
//
// So a `created_at<` clause is not enforced by this relay at all. The spec is
// separately clear that even a compliant verifier gets little from it: the
// clause "constrains the event's self-declared created_at field, which the agent
// controls", so "a misbehaving agent can backdate". It bounds an honest agent.
//
// The real control is bot-key hygiene: if the agent key leaks, rotate the agent
// key — there is no revocation. "Owners MAY revoke future authorization by
// refusing to issue new auth tags" is the whole revocation story. We still set
// an expiry, because a capability with a stated lifetime is easier to reason
// about than one without, but nothing here should be sold as enforcement.
//
// Reference: docs/nips/NIP-OA.md and crates/buzz-sdk/src/nip_oa.rs at tag
// relay-v0.2.0 — the exact ref of the image running in production
// (ghcr.io/block/buzz:0.2.0). Validation below mirrors that implementation
// clause for clause, so a tag we mint and a tag the relay accepts cannot drift.

import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";

/** Domain separator. Exact bytes — it is inside the signed preimage. */
export const AUTH_TAG_DOMAIN = "nostr:agent-auth:";

const KIND_MAX = 65535;
const TIMESTAMP_MAX = 4294967295;

export class NipOaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NipOaError";
  }
}

/** A parsed `auth` tag. `conditions` is kept verbatim — see verifyAuthTag. */
export interface AuthTag {
  ownerPubkey: string;
  conditions: string;
  signature: string;
}

function assertLowercaseHex(value: string, length: number, label: string): void {
  if (value.length !== length || !/^[0-9a-f]*$/.test(value)) {
    throw new NipOaError(`${label} must be ${length} lowercase hex characters`);
  }
}

/**
 * Canonical base-10, mirroring `validate_canonical_decimal`. "01" and "" are
 * rejected: the conditions string is signed verbatim, so two spellings of the
 * same number are two different credentials, and allowing both would let a
 * verifier and a signer disagree about what was authorized.
 */
function validateCanonicalDecimal(value: string, max: number, label: string): void {
  if (value.length === 0) throw new NipOaError(`${label} value must not be empty`);
  if (value.length > 1 && value.startsWith("0")) {
    throw new NipOaError(`${label} value has a leading zero: ${JSON.stringify(value)}`);
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new NipOaError(`${label} value is not a valid decimal: ${JSON.stringify(value)}`);
  }
  if (Number(value) > max) {
    throw new NipOaError(`${label} value ${value} is out of range [0, ${max}]`);
  }
}

function validateClause(clause: string): void {
  if (clause.startsWith("kind=")) {
    validateCanonicalDecimal(clause.slice("kind=".length), KIND_MAX, "kind");
  } else if (clause.startsWith("created_at<")) {
    validateCanonicalDecimal(clause.slice("created_at<".length), TIMESTAMP_MAX, "created_at<");
  } else if (clause.startsWith("created_at>")) {
    validateCanonicalDecimal(clause.slice("created_at>".length), TIMESTAMP_MAX, "created_at>");
  } else {
    throw new NipOaError(`unsupported clause: ${JSON.stringify(clause)}`);
  }
}

/**
 * Validate a conditions string. Empty is valid and imposes no constraints.
 *
 * Splitting on "&" and rejecting empty parts is what makes a leading, trailing,
 * or doubled "&" an error rather than a silently-ignored one — all three appear
 * in the spec's invalid-vector list.
 */
export function validateConditions(conditions: string): void {
  if (conditions.length === 0) return;
  if (/\s/.test(conditions)) {
    throw new NipOaError("conditions must not contain whitespace");
  }
  for (const clause of conditions.split("&")) {
    if (clause.length === 0) {
      throw new NipOaError("empty clause in conditions (leading, trailing, or doubled '&')");
    }
    validateClause(clause);
  }
}

/** `nostr:agent-auth:<agent-pubkey>:<conditions>` — signed verbatim. */
export function buildAuthPreimage(agentPubkeyHex: string, conditions: string): string {
  return `${AUTH_TAG_DOMAIN}${agentPubkeyHex}:${conditions}`;
}

/** SHA-256 of the preimage. This 32-byte digest is the signed message. */
export function authTagDigest(agentPubkeyHex: string, conditions: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(buildAuthPreimage(agentPubkeyHex, conditions)).digest());
}

/**
 * Mint an `auth` tag. THIS TAKES THE OWNER SECRET KEY — it runs on the
 * operator's machine, never on a server. The deployable output is the returned
 * JSON string.
 */
export function computeAuthTag(input: {
  ownerSecretKeyHex: string;
  agentPubkeyHex: string;
  conditions: string;
}): string {
  assertLowercaseHex(input.ownerSecretKeyHex, 64, "owner secret key");
  assertLowercaseHex(input.agentPubkeyHex, 64, "agent pubkey");
  validateConditions(input.conditions);

  const ownerPubkey = Buffer.from(schnorr.getPublicKey(input.ownerSecretKeyHex)).toString("hex");
  // Self-attestation proves nothing — an agent asserting its own authority.
  if (ownerPubkey === input.agentPubkeyHex) {
    throw new NipOaError("owner and agent pubkeys must differ (self-attestation rejected)");
  }

  const digest = authTagDigest(input.agentPubkeyHex, input.conditions);
  const signature = Buffer.from(schnorr.sign(digest, input.ownerSecretKeyHex)).toString("hex");
  return JSON.stringify(["auth", ownerPubkey, input.conditions, signature]);
}

/**
 * Verify an `auth` tag against the agent key that will author events with it.
 * Returns the owner pubkey on success; throws otherwise.
 *
 * Deliberately mirrors the relay: no event is taken, and conditions are checked
 * for FORM only. See the header — this function cannot tell you a tag has
 * expired, because nothing in this protocol path can.
 */
export function verifyAuthTag(authTagJson: string, agentPubkeyHex: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authTagJson);
  } catch {
    throw new NipOaError("auth tag is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new NipOaError("auth tag must be a JSON array");
  if (parsed.length !== 4) {
    throw new NipOaError(`auth tag must have 4 elements, got ${parsed.length}`);
  }
  if (!parsed.every((element): element is string => typeof element === "string")) {
    throw new NipOaError("every auth tag element must be a string");
  }
  const [label, ownerPubkey, conditions, signature] = parsed;
  if (label !== "auth") {
    throw new NipOaError(`first element must be "auth", got ${JSON.stringify(label)}`);
  }
  assertLowercaseHex(ownerPubkey, 64, "owner pubkey");
  assertLowercaseHex(signature, 128, "signature");
  assertLowercaseHex(agentPubkeyHex, 64, "agent pubkey");
  validateConditions(conditions);
  if (ownerPubkey === agentPubkeyHex) {
    throw new NipOaError("owner and agent pubkeys must differ (self-attestation rejected)");
  }

  // The conditions string from the tag is used EXACTLY as it appears. The spec
  // forbids reordering, deduplicating, or canonicalizing it before hashing —
  // any of those would compute a different preimage and reject a valid tag.
  const digest = authTagDigest(agentPubkeyHex, conditions);
  if (!schnorr.verify(signature, digest, ownerPubkey)) {
    throw new NipOaError("signature verification failed");
  }
  return ownerPubkey;
}

/**
 * Structural check with no crypto — the cheap startup path, so a malformed tag
 * in config fails at boot with a clear message instead of at the first attempt
 * to speak.
 */
export function parseAuthTag(authTagJson: string): AuthTag {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authTagJson);
  } catch {
    throw new NipOaError("auth tag is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new NipOaError("auth tag must be a JSON array of 4 elements");
  }
  const [label, ownerPubkey, conditions, signature] = parsed as unknown[];
  if (label !== "auth") throw new NipOaError('first element must be "auth"');
  if (typeof ownerPubkey !== "string" || typeof conditions !== "string" || typeof signature !== "string") {
    throw new NipOaError("owner pubkey, conditions, and signature must be strings");
  }
  assertLowercaseHex(ownerPubkey, 64, "owner pubkey");
  assertLowercaseHex(signature, 128, "signature");
  validateConditions(conditions);
  return { ownerPubkey, conditions, signature };
}

/**
 * Conditions for a capability that stops being claimable after `expiresAt`.
 *
 * No `kind=` clause, on purpose. The same tag rides on the NIP-42 AUTH event
 * (kind 22242) AND on the kind-9 messages it authorizes; a `kind=9` clause would
 * make the tag formally invalid on the AUTH event for any verifier stricter than
 * today's relay. It also buys nothing real — a clause constrains provenance
 * claims, never what the agent is able to publish.
 */
export function expiringConditions(expiresAtUnixSeconds: number): string {
  if (!Number.isInteger(expiresAtUnixSeconds) || expiresAtUnixSeconds < 0 || expiresAtUnixSeconds > TIMESTAMP_MAX) {
    throw new NipOaError(`expiry must be an integer in [0, ${TIMESTAMP_MAX}]`);
  }
  return `created_at<${expiresAtUnixSeconds}`;
}
