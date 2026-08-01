#!/usr/bin/env npx tsx
//
// Mint Hermes's Buzz credentials: a fresh agent keypair plus a NIP-OA `auth`
// tag proving the operator authorized it.
//
//   npx tsx scripts/ops/mint-buzz-agent-auth.ts
//
// RUN THIS ON YOUR OWN MACHINE, NEVER ON THE VPS. It needs the owner secret
// key, and the entire point of NIP-OA here is that the owner secret never
// reaches the server — only the signature it produces does. Running it on the
// box would put the key in that box's shell history, process table, and any
// scrollback, which is precisely the exposure the design avoids.
//
// The owner secret is read from stdin with terminal echo OFF. It is never taken
// as an argv value (argv is world-readable via `ps` and lands in shell history),
// never logged, and never written to disk.
//
// See services/slack-operator/src/nip-oa.ts for what the tag can and cannot do —
// in particular, the expiry is NOT enforced by the relay.

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { bech32 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1";

import {
  computeAuthTag,
  expiringConditions,
  verifyAuthTag,
} from "../../services/slack-operator/src/nip-oa.js";

const DEFAULT_VALID_DAYS = 365;

/** Accept either a bech32 `nsec1…` or raw 64-char hex. */
function normalizeSecret(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("nsec1")) {
    const { prefix, words } = bech32.decode(trimmed as `nsec1${string}`, 200);
    if (prefix !== "nsec") throw new Error(`expected an nsec key, got prefix "${prefix}"`);
    return Buffer.from(bech32.fromWords(words)).toString("hex");
  }
  if (trimmed.startsWith("npub1")) {
    throw new Error("that is an npub (public key) — minting needs the nsec (secret key)");
  }
  throw new Error("expected an nsec1… key or 64-character hex");
}

function toNpub(pubkeyHex: string): string {
  return bech32.encode("npub", bech32.toWords(Buffer.from(pubkeyHex, "hex")), 200);
}

/** Read one line with echo disabled so the secret never appears on screen. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const wasRaw = input.isTTY ? input.isRaw : false;
  process.stdout.write(prompt);
  if (input.isTTY) input.setRawMode?.(true);

  const rl = createInterface({ input, terminal: true });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const ETX = 3; // Ctrl-C
      const EOT = 4; // Ctrl-D
      const BACKSPACE = 8;
      const DELETE = 127;
      const onData = (chunk: Buffer) => {
        for (const code of chunk) {
          if (code === 13 || code === 10) {
            input.off("data", onData);
            resolve(buffer);
            return;
          }
          // Abort paths still have to restore the terminal, which is why the
          // reset lives in the finally block below and not here.
          if (code === ETX || code === EOT) {
            input.off("data", onData);
            reject(new Error("aborted"));
            return;
          }
          if (code === BACKSPACE || code === DELETE) {
            buffer = buffer.slice(0, -1);
            continue;
          }
          buffer += String.fromCharCode(code);
        }
      };
      input.on("data", onData);
    });
    return line;
  } finally {
    if (input.isTTY) input.setRawMode?.(wasRaw);
    rl.close();
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const days = Number(process.env.BUZZ_AUTH_VALID_DAYS ?? DEFAULT_VALID_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`BUZZ_AUTH_VALID_DAYS must be a positive number, got ${process.env.BUZZ_AUTH_VALID_DAYS}`);
  }

  console.log("Minting Buzz agent credentials for Hermes.\n");
  console.log("  The owner secret is used once, in memory, to sign one capability.");
  console.log("  It is not stored, not logged, and not deployed anywhere.\n");

  const ownerSecret = normalizeSecret(await readSecret("Owner nsec (input hidden): "));

  // Fresh agent identity. Distinct from the owner key by construction, so
  // narration is attributable to Hermes and a leak of it cannot touch the owner.
  const agentSecret = Buffer.from(randomBytes(32)).toString("hex");
  const agentPubkey = Buffer.from(schnorr.getPublicKey(agentSecret)).toString("hex");
  const ownerPubkey = Buffer.from(schnorr.getPublicKey(ownerSecret)).toString("hex");

  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const conditions = expiringConditions(expiresAt);
  const authTag = computeAuthTag({ ownerSecretKeyHex: ownerSecret, agentPubkeyHex: agentPubkey, conditions });

  // Verify before printing. A tag that does not verify locally will not verify
  // at the relay either, and finding that out here beats finding it out as an
  // auth failure that looks like a bad key.
  const provenOwner = verifyAuthTag(authTag, agentPubkey);
  if (provenOwner !== ownerPubkey) {
    throw new Error("minted tag verified to a different owner — refusing to emit it");
  }

  console.log("Verified locally: the tag proves this owner authorized this agent.\n");
  console.log(`  owner npub    ${toNpub(ownerPubkey)}`);
  console.log(`  agent npub    ${toNpub(agentPubkey)}`);
  console.log(`  capability    expires ${new Date(expiresAt * 1000).toISOString()} (${days}d)`);
  console.log(`                NOT enforced by the relay — see nip-oa.ts. Rotation is the real control.\n`);
  console.log("Add to .env.prod on the VPS (both lines), then redeploy slack-operator:\n");
  console.log(`BUZZ_AGENT_SECRET_KEY=${agentSecret}`);
  console.log(`BUZZ_OWNER_AUTH_TAG=${authTag}`);
  console.log("\nPaste the tag line EXACTLY as printed. It is a JSON array, so it carries");
  console.log("quotes and commas: do not wrap it in outer quotes, and do not let an editor");
  console.log("reflow it onto two lines. A stray wrapping quote is tolerated by the reader;");
  console.log("a line break is not, and produces a parse error rather than a warning.\n");
  console.log("BUZZ_AGENT_SECRET_KEY is a credential: store it in 1Password alongside the");
  console.log("other production secrets. Anyone holding it can post as Hermes.");
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
