// Nostr event construction and signing for Buzz — the pure half of the
// narration transport. No sockets, no clock, no config: everything here is a
// function of its arguments, so the parts that are easy to get subtly wrong are
// the parts that are cheap to test.
//
// WHY THIS IS SPLIT OUT: a mis-serialized event is rejected by the relay with
// `["OK", <id>, false, "invalid: bad signature"]` and nothing else. There is no
// way to tell from that message whether the secret key is wrong, the id was
// computed over the wrong bytes, or a tag was ordered differently than signed.
// Testing the bytes directly is the only cheap way to know.
//
// Event ids are defined by NIP-01 as the SHA-256 of a compact JSON array:
//
//   [0, <pubkey>, <created_at>, <kind>, <tags>, <content>]
//
// with no whitespace and only the escapes JSON already produces. JSON.stringify
// matches that definition — it emits \", \\, \b, \f, \n, \r, \t for exactly the
// characters NIP-01 names, \uXXXX for other control characters, and leaves
// non-ASCII as literal UTF-8. Hand-rolling the serializer would be the more
// obvious way to introduce a bug here, not avoid one.

import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";

/** NIP-29 group chat message. What Buzz renders as an ordinary channel message. */
export const KIND_STREAM_MESSAGE = 9;
/** NIP-42 client authentication. Carries the NIP-OA tag on closed relays. */
export const KIND_CLIENT_AUTH = 22242;

/** Upstream's builder caps message content here (`check_content(content, 64 * 1024)`). */
export const MAX_CONTENT_BYTES = 64 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

export class BuzzEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuzzEventError";
  }
}

/** The exact byte sequence an event id is computed over. */
export function serializeForId(event: UnsignedEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function computeEventId(event: UnsignedEvent): string {
  return createHash("sha256").update(serializeForId(event), "utf8").digest("hex");
}

/**
 * Sign an event. The id is computed here rather than accepted from the caller —
 * an id that disagrees with the content is the single most confusing failure in
 * this protocol, and making it unrepresentable is cheaper than detecting it.
 */
export function signEvent(event: UnsignedEvent, secretKeyHex: string): NostrEvent {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
    throw new BuzzEventError("agent secret key must be 64 lowercase hex characters");
  }
  const derived = Buffer.from(schnorr.getPublicKey(secretKeyHex)).toString("hex");
  if (derived !== event.pubkey) {
    throw new BuzzEventError(
      `event pubkey ${event.pubkey.slice(0, 16)}… does not match the signing key ${derived.slice(0, 16)}…`,
    );
  }
  const id = computeEventId(event);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), secretKeyHex)).toString("hex");
  return { ...event, id, sig };
}

/** Derive the agent's x-only pubkey from its secret. */
export function agentPubkey(secretKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
    throw new BuzzEventError("agent secret key must be 64 lowercase hex characters");
  }
  return Buffer.from(schnorr.getPublicKey(secretKeyHex)).toString("hex");
}

/**
 * Parse a NIP-OA auth tag from config into tag form.
 *
 * Tolerates one layer of wrapping quotes because the value is a JSON array
 * pasted into a .env file, and wrapping it is the natural instinct. A line break
 * is NOT tolerated — it produces a parse error here rather than a mystery at the
 * relay.
 */
export function authTagFromConfig(raw: string): string[] {
  const unwrapped = raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new BuzzEventError(
      "BUZZ_OWNER_AUTH_TAG is not valid JSON — paste it on ONE line, exactly as the mint script printed it",
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((p) => typeof p === "string")) {
    throw new BuzzEventError("BUZZ_OWNER_AUTH_TAG must be a JSON array of 4 strings");
  }
  if (parsed[0] !== "auth") {
    throw new BuzzEventError('BUZZ_OWNER_AUTH_TAG must start with "auth"');
  }
  return parsed as string[];
}

/**
 * Build a channel message. Mirrors upstream `build_message`: kind 9 with an
 * `["h", <channel uuid>]` tag.
 *
 * The channel is addressed by UUID, not by name — a name would be a moving
 * target, and a wrong-but-well-formed one would post somewhere unintended
 * rather than fail.
 */
export function buildStreamMessage(input: {
  agentPubkeyHex: string;
  channelId: string;
  content: string;
  createdAt: number;
  authTag?: string[];
}): UnsignedEvent {
  if (!UUID_PATTERN.test(input.channelId)) {
    throw new BuzzEventError(
      `channel id must be a lowercase UUID, got ${JSON.stringify(input.channelId)} — Buzz addresses channels by UUID, not by name`,
    );
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes === 0) throw new BuzzEventError("refusing to publish an empty message");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new BuzzEventError(`content is ${bytes} bytes, over the ${MAX_CONTENT_BYTES} limit`);
  }
  const tags: string[][] = [["h", input.channelId]];
  // Provenance on the message itself, so a client can render "authorized by
  // <owner>" — distinct from authorship, which stays the agent's.
  if (input.authTag) tags.push(input.authTag);
  return {
    pubkey: input.agentPubkeyHex,
    created_at: input.createdAt,
    kind: KIND_STREAM_MESSAGE,
    tags,
    content: input.content,
  };
}

/** NIP-01 profile metadata. Replaceable: publishing again supersedes. */
export const KIND_PROFILE = 0;

export interface AgentProfile {
  displayName?: string;
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
}

/**
 * Build the agent's profile. Mirrors upstream `build_profile`: kind 0, no tags,
 * a JSON object of the set fields.
 *
 * WHY IT MATTERS: without this, clients have nothing to show but the pubkey, so
 * narration arrives authored by `775a0f0a…a1af`. An alert read at 3am should say
 * who is speaking. This is the difference between a message that reads like a
 * colleague and one that reads like a hash.
 *
 * Fields are emitted in a fixed order because the content string is part of the
 * signed event id — not because any reader depends on it, but because a stable
 * input makes a republished profile diffable.
 */
export function buildProfileEvent(input: {
  agentPubkeyHex: string;
  profile: AgentProfile;
  createdAt: number;
  authTag?: string[];
}): UnsignedEvent {
  const fields: Array<[string, string | undefined]> = [
    ["display_name", input.profile.displayName],
    ["name", input.profile.name],
    ["picture", input.profile.picture],
    ["about", input.profile.about],
    ["nip05", input.profile.nip05],
  ];
  const map: Record<string, string> = {};
  for (const [key, value] of fields) {
    if (typeof value === "string" && value.length > 0) map[key] = value;
  }
  if (Object.keys(map).length === 0) {
    throw new BuzzEventError("refusing to publish an empty profile — it would erase the current one");
  }
  return {
    pubkey: input.agentPubkeyHex,
    created_at: input.createdAt,
    kind: KIND_PROFILE,
    // Provenance here too: the profile is where a reader looks to find out what
    // this key is, so "authorized by <owner>" belongs on it.
    tags: input.authTag ? [input.authTag] : [],
    content: JSON.stringify(map),
  };
}

/**
 * Build the NIP-42 AUTH event. On this closed relay the NIP-OA tag rides HERE —
 * upstream extracts it from the signed AUTH event and uses it to prove the
 * agent's owner is a member (`enforce_relay_membership` with NIP-OA fallback).
 *
 * Without the tag, a non-member agent is refused, so omitting it is a
 * configuration error rather than a degraded mode.
 */
export function buildAuthEvent(input: {
  agentPubkeyHex: string;
  relayUrl: string;
  challenge: string;
  createdAt: number;
  authTag: string[];
}): UnsignedEvent {
  if (!input.challenge) throw new BuzzEventError("relay sent an empty AUTH challenge");
  return {
    pubkey: input.agentPubkeyHex,
    created_at: input.createdAt,
    kind: KIND_CLIENT_AUTH,
    tags: [
      ["relay", input.relayUrl],
      ["challenge", input.challenge],
      input.authTag,
    ],
    content: "",
  };
}
