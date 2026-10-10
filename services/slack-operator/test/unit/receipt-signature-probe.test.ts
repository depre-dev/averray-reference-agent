import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BADGE_RECEIPT_TYP,
  canonicalBadgeReceiptBytes,
  canonicalizeJson,
  decideReceiptProbe,
  receiptApiBase,
  receiptProbeDetail,
  runReceiptSignatureProbe,
  verifyServedReceipt,
} from "../../src/receipt-signature-probe.js";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
const published = { ...jwk, kid: "badge-1", alg: "ES256", use: "sig" };

function signed(document: Record<string, unknown>, kid = "badge-1"): Record<string, unknown> {
  const signedAt = "2026-10-09T00:00:00.000Z";
  const protectedHeader = { alg: "ES256", kid, signedAt, typ: BADGE_RECEIPT_TYP };
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
      kid,
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

  it("could not check an unreachable JWKS", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example");
    }) as typeof fetch;
    const result = await runReceiptSignatureProbe({ apiBaseUrl: "https://api.example", fetchImpl });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("could not check");
  });

  it("could not check a JWKS 5xx", async () => {
    const result = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: jsonFetch(() => ({ status: 500, body: { error: "unavailable" } })),
    });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("could not check");
    expect(result.detail).toContain("HTTP 500");
  });

  it("could not check a list 5xx", async () => {
    const result = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: jsonFetch((href) =>
        href.endsWith("/.well-known/badge-receipt-jwks.json")
          ? { status: 200, body: { keys: [published] } }
          : { status: 503, body: { error: "down" } },
      ),
    });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("could not check");
    expect(result.detail).toContain("HTTP 503");
  });

  it("could not check a per-id 404", async () => {
    const result = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: jsonFetch((href) => {
        if (href.endsWith("/.well-known/badge-receipt-jwks.json")) return { status: 200, body: { keys: [published] } };
        if (href.includes("/badges?limit=5")) {
          return { status: 200, body: { items: [{ schemaVersion: "averray.badge-list-item.v1", document: receipt }] } };
        }
        return { status: 404, body: { error: "missing" } };
      }),
    });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("could not check");
    expect(result.detail).toContain("HTTP 404");
  });

  it("could not check a per-id timeout", async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/.well-known/badge-receipt-jwks.json") || href.includes("/badges?limit=5")) {
        const body = href.includes("limit=5")
          ? { items: [{ schemaVersion: "averray.badge-list-item.v1", document: receipt }] }
          : { keys: [published] };
        return { ok: true, status: 200, json: async () => body };
      }
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;
    const result = await runReceiptSignatureProbe({ apiBaseUrl: "https://api.example", fetchImpl, timeoutMs: 20 });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("could not check");
    expect(result.detail).toContain("timed out");
  });

  it("a stalled response body times out as could not check", async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    })) as typeof fetch;
    const result = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl,
      timeoutMs: 20,
    });
    expect(result.status).toBe("degraded");
    expect(result.detail).toMatch(/could not check — .*timed out/);
  });

  it("uses two different sessions when one session lists two receipts", async () => {
    const urls: string[] = [];
    const item = (sessionId: string, receiptId: string) => ({
      schemaVersion: "averray.badge-list-item.v1",
      document: { sessionId, receiptId },
    });
    await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: (async (url: RequestInfo | URL) => {
        const href = String(url);
        urls.push(href);
        const body = href.endsWith("/.well-known/badge-receipt-jwks.json")
          ? { keys: [published] }
          : href.includes("/badges?limit=5")
            ? { items: [item("job-a", "r1"), item("job-a", "r2"), item("job-b", "r3")] }
            : {};
        return { ok: true, status: 200, json: async () => body };
      }) as typeof fetch,
    });
    const badges = urls.filter((url) => url.includes("/badges/") && !url.includes("limit"));
    expect(badges.filter((url) => url.includes("job-a"))).toHaveLength(1);
    expect(badges.some((url) => url.includes("job-b"))).toBe(true);
  });

  it("reds an unknown kid and accepts a rotation onto badge-2", async () => {
    const unknown = signed({ schemaVersion: "averray.work-receipt.v1", sessionId: "job-9:0xabc", worker: "0xabc" }, "badge-9");
    const missed = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: jsonFetch((href) => {
        if (href.endsWith("/.well-known/badge-receipt-jwks.json")) return { status: 200, body: { keys: [published] } };
        if (href.includes("/badges?limit=5")) {
          return { status: 200, body: { items: [{ schemaVersion: "averray.badge-list-item.v1", document: unknown }] } };
        }
        return { status: 200, body: unknown };
      }),
    });
    expect(missed.status).toBe("red");
    expect(missed.detail).toContain("unknown kid badge-9");

    const rotatedKey = { ...published, kid: "badge-2" };
    const first = signed({ schemaVersion: "averray.work-receipt.v1", sessionId: "job-1:0xabc", worker: "0xabc", receiptId: "rcpt-1" }, "badge-2");
    const second = signed({ schemaVersion: "averray.work-receipt.v1", sessionId: "job-2:0xdef", worker: "0xdef", receiptId: "rcpt-2" }, "badge-2");
    const urls: string[] = [];
    const rotated = await runReceiptSignatureProbe({
      apiBaseUrl: "https://api.example",
      fetchImpl: (async (url: RequestInfo | URL) => {
        const href = String(url);
        urls.push(href);
        const body = href.endsWith("/.well-known/badge-receipt-jwks.json")
          ? { keys: [rotatedKey] }
          : href.includes("/badges?limit=5")
            ? { items: [
                { schemaVersion: "averray.badge-list-item.v1", document: first },
                { schemaVersion: "averray.badge-list-item.v1", document: second },
              ] }
            : href.includes("/receipts/")
              ? { schemaVersion: "averray.receipt-envelope.v1", document: href.includes("rcpt-2") ? second : first }
              : href.includes("job-2") ? second : first;
        return { ok: true, status: 200, json: async () => body };
      }) as typeof fetch,
    });
    expect(rotated.status).toBe("ok");
    expect(urls.some((url) => url.endsWith("/receipts/rcpt-1"))).toBe(true);
    expect(urls.some((url) => url.includes("/badges/"))).toBe(true);
    expect(rotated.detail).not.toContain("badge-1");
  });

  it("an unset base URL is not configured, and a result carries its age", async () => {
    expect(receiptApiBase(undefined)).toBeNull();
    expect(receiptApiBase("  ")).toBeNull();
    const result = await runReceiptSignatureProbe({ apiBaseUrl: " ", fetchImpl: (async () => { throw new Error("should not fetch"); }) as typeof fetch });
    expect(result).toMatchObject({ status: "degraded", detail: "not configured" });
    expect(receiptProbeDetail({ detail: "verified 2 served receipt documents against the served JWKS", at: 1_000 }, 46_000)).toBe(
      "verified 2 served receipt documents against the served JWKS · 45s ago",
    );
  });
});

function jsonFetch(route: (href: string) => { status: number; body: unknown }): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const { status, body } = route(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as typeof fetch;
}
