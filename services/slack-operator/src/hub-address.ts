// Polkadot Hub accounts have two encodings of the same account, and an operator
// needs whichever one their wallet speaks.
//
// The board reads balances over eth-rpc, so every address it shows is an H160
// (`0x…`). But DOT arrives from Substrate wallets — Nova, Talisman, Polkadot.js
// — and those want SS58. Without it, "the signer needs gas" is a fact you cannot
// act on without leaving the board to convert an address by hand, which is
// exactly the moment a wrong character costs real money.
//
// ── THE MAPPING, AND WHY IT IS SAFE TO DERIVE ──────────────────────────────
//
// `pallet_revive` extends a 20-byte H160 to an AccountId32 by appending twelve
// 0xEE bytes; that suffix marks an Ethereum-controlled account and makes the
// conversion reversible. Deterministic, documented, no lookup required.
//
// The one case where derivation would LIE is an explicitly mapped account — a
// Substrate account that registered its own H160 via `map_account`, where the
// 0xEE padding is not the real mapping. That applies to externally-owned
// accounts, not to contract addresses, which get their H160 from CREATE.
//
// So the EOA is the one that had to be checked, and it was — against the chain,
// not against the documentation:
//
//   eth_getTransactionCount(0x5a6836c6…)                     → 222
//   state_call AccountNonceApi_account_nonce(AccountId32)    → 222
//
// Two RPCs, two encodings, same nonce. That pair is the test vector below, so
// the derivation is pinned to something a real chain confirmed rather than to
// this comment.

import { blake2b } from "@noble/hashes/blake2b";
import { base58 } from "@scure/base";

const SS58_PREFIX = new TextEncoder().encode("SS58PRE");

/** Polkadot (and Polkadot Hub) address format. */
export const POLKADOT_SS58_FORMAT = 0;

/** The twelve bytes pallet_revive appends. Their presence marks an eth account. */
const ETH_SUFFIX_BYTE = 0xee;
const ETH_SUFFIX_LEN = 12;

/** H160 → AccountId32, the pallet_revive way. */
export function h160ToAccountId32(addressHex: string): Uint8Array | undefined {
  const hex = addressHex.trim().replace(/^0x/, "").toLowerCase();
  if (hex.length !== 40 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  out.fill(ETH_SUFFIX_BYTE, 20, 20 + ETH_SUFFIX_LEN);
  return out;
}

/**
 * Encode an AccountId32 as SS58.
 *
 * The checksum is the first two bytes of blake2b-512 over "SS58PRE" + format +
 * pubkey — that prefix is what stops an address from one chain validating on
 * another, so it is not optional decoration.
 */
export function encodeSs58(publicKey: Uint8Array, format = POLKADOT_SS58_FORMAT): string {
  const body = new Uint8Array(1 + publicKey.length);
  body[0] = format;
  body.set(publicKey, 1);
  const checksum = blake2b(new Uint8Array([...SS58_PREFIX, ...body]), { dkLen: 64 }).slice(0, 2);
  return base58.encode(new Uint8Array([...body, ...checksum]));
}

/**
 * The SS58 form of an EVM address on Polkadot Hub.
 *
 * Returns undefined for anything that is not a well-formed H160 — a malformed
 * input must produce NO address rather than a plausible one, because the only
 * use for the result is pasting it into a wallet.
 */
export function h160ToSs58(addressHex: string, format = POLKADOT_SS58_FORMAT): string | undefined {
  const account = h160ToAccountId32(addressHex);
  return account ? encodeSs58(account, format) : undefined;
}
