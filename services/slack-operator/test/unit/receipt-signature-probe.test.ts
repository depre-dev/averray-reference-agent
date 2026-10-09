import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BADGE_RECEIPT_KID,
  BADGE_RECEIPT_TYP,
  canonicalBadgeReceiptBytes,
  canonicalizeJson,
  decideReceiptProbe,
  runReceiptSignatureProbe,
  verifyServedReceipt,
} from "../../src/receipt-signature-probe.js";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
const published = { ...jwk, kid: BADGE_RECEIPT_KID, alg: "ES256", use: "sig" };

function signed(document: Record<string, unknown>): Record<string, unknown> {
  const signedAt = "2026-10-09T00:00:00.000Z";
  const protectedHeader = { alg: "ES256", kid: BADGE_RECEIPT_KID, signedAt, typ: BADGE_RECEIPT_TYP };
  const protectedB64 = Buffer.from(canonicalizeJson(protectedHeader), "utf8").toString("base64url");
  const bytes = canonicalBadgeReceiptBytes(document);
  const payloadB64 = bytes.toString("base64url");
  const raw = sign("sha256", Buffer.from(`${protectedB64}.${payloadB64}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return {
    ...document,
    signature: {
      alg: "ES256",
      kid: BADGE_RECEIPT_KID,
      signedAt,
      sig: `${protectedB64}..${Buffer.from(raw).toString("base64url")}`,
    },
  };
}

const receipt = signed({ schemaVersion: "averray.work-receipt.v1", sessionId: "job-1:0xabc", worker: "0xabc" });

describe("published receipt canonicalization", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalizeJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  it("verifies a served document and rejects a mutated one", () => {
    expect(() => verifyServedReceipt(receipt, published)).not.toThrow();
    const other = signed({ schemaVersion: "averray.work-receipt.v1", sessionId: "job-1:0xabc", worker: "0xother" });
    expect(() => verifyServedReceipt({ ...receipt, worker: "0xother" }, published)).toThrow(/does not match/);
    expect(() => verifyServedReceipt(other, published)).not.toThrow();
  });
});

describe("decideReceiptProbe", () => {
  it("is red when any served document fails", () => {
    expect(decideReceiptProbe({ checked: 2, ids: 2, failures: ["badges/a: signature does not match"] }).status).toBe("red");
  });

  it("is ok when two per-id receipts verify", () => {
    expect(decideReceiptProbe({ checked: 4, ids: 2, failures: [] })).toMatchObject({ status: "ok", checked: 4 });
  });
});

describe("runReceiptSignatureProbe", () => {
  it("fetches the list and two per-id receipts, and reds when one fails", async () => {
    const good = receipt;
    const bad = { ...receipt, worker: "0xtampered" };
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      const json = async () => {
        if (href.endsWith("/.well-known/badge-receipt-jwks.json")) return { keys: [published] };
        if (href.includes("/badges?limit=5")) {
          return {
            items: [
              { schemaVersion: "averray.badge-list-item.v1", document: good },
              { schemaVersion: "averray.badge-list-item.v1", document: { ...good, sessionId: "job-2:0xdef" } },
            ],
          };
        }
        if (href.includes("job-2")) return bad;
        return good;
      };
      return { ok: true, status: 200, json };
    }) as typeof fetch;

    const result = await runReceiptSignatureProbe({ apiBaseUrl: "https://api.averray.com", fetchImpl });
    expect(urls.some((url) => url.endsWith("/badges?limit=5"))).toBe(true);
    expect(urls.filter((url) => url.includes("/badges/"))).toHaveLength(2);
    expect(result.status).toBe("red");
    expect(result.detail).toContain("does not match");
  });
});
