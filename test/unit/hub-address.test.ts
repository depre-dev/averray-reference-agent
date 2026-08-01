import { describe, expect, it } from "vitest";

import {
  h160ToAccountId32,
  h160ToSs58,
} from "../../services/slack-operator/src/hub-address.js";

// CHAIN-VERIFIED VECTOR. This is the live mainnet gas signer, and the pair was
// confirmed against the chain rather than against documentation:
//
//   eth_getTransactionCount(0x5a6836c6…)                  → 222
//   state_call AccountNonceApi_account_nonce(AccountId32)  → 222
//
// Two RPCs, two encodings, one nonce. If this expectation ever fails, the
// derivation changed — not the test.
const SIGNER_H160 = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const SIGNER_ACCOUNT = "5a6836c6d4d293f6e5377e6c28054f4171915813eeeeeeeeeeeeeeeeeeeeeeee";
const SIGNER_SS58 = "133YGXLeo4Rf2aWc7JXUbq7rmDnTrFp7tLj7Q9xdCt4bcYcg";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("h160ToAccountId32", () => {
  it("appends exactly twelve 0xEE bytes", () => {
    expect(hex(h160ToAccountId32(SIGNER_H160)!)).toBe(SIGNER_ACCOUNT);
    expect(h160ToAccountId32(SIGNER_H160)!.length).toBe(32);
  });

  it("accepts mixed case and a missing 0x, since both get pasted", () => {
    expect(hex(h160ToAccountId32(SIGNER_H160.toUpperCase().replace("0X", "0x"))!)).toBe(SIGNER_ACCOUNT);
    expect(hex(h160ToAccountId32(SIGNER_H160.slice(2))!)).toBe(SIGNER_ACCOUNT);
  });

  it("returns nothing for anything that is not a well-formed H160", () => {
    // A malformed input must produce NO address, never a plausible one — the
    // only use for the result is pasting it into a wallet.
    for (const bad of ["", "0x", "0xnothex000000000000000000000000000000000000", SIGNER_H160 + "00", "0x1234"]) {
      expect(h160ToAccountId32(bad)).toBeUndefined();
    }
  });
});

describe("h160ToSs58", () => {
  it("produces the address the chain confirmed for the live signer", () => {
    expect(h160ToSs58(SIGNER_H160)).toBe(SIGNER_SS58);
  });

  it("is stable across input spellings", () => {
    expect(h160ToSs58(SIGNER_H160.toLowerCase())).toBe(SIGNER_SS58);
    expect(h160ToSs58(` ${SIGNER_H160} `)).toBe(SIGNER_SS58);
  });

  it("changes completely when one character of the address changes", () => {
    // The checksum is why a typo is caught by the wallet rather than by the
    // recipient discovering the funds never arrived.
    const off = `0x5a6836c6D4d293F6E5377E6c28054F4171915814`;
    expect(h160ToSs58(off)).not.toBe(SIGNER_SS58);
  });

  it("returns undefined rather than a partial address for bad input", () => {
    expect(h160ToSs58("not-an-address")).toBeUndefined();
  });

  it("a different SS58 format yields a different address for the same account", () => {
    // Guards the prefix actually entering the checksum: without it an address
    // from one chain would validate on another.
    expect(h160ToSs58(SIGNER_H160, 2)).not.toBe(SIGNER_SS58);
  });
});
