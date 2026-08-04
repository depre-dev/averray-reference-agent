import { describe, expect, test } from "vitest";

import {
  credentialExpiryProbe,
  daysUntil,
  expiryLine,
  jwtExpiryMs,
  type CredentialExpiry,
} from "../../src/credential-expiry.js";

const NOW = 1_785_900_000_000; // 2026-08-04-ish
const DAY = 24 * 60 * 60 * 1000;

/** A real JWT shape — header.payload.signature, payload base64url with `exp`. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64(claims)}.c2ln`;
}

const cred = (over: Partial<CredentialExpiry> = {}): CredentialExpiry => ({
  label: "ADMIN_JWT",
  source: "jwt exp claim",
  expiresAtMs: NOW + 30 * DAY,
  ...over,
});

describe("expiry comes from the artefact, never from a written date", () => {
  test("a JWT's own exp is read, in SECONDS as RFC 7519 specifies", () => {
    // Treating exp as ms would put every token in 1970 and report every
    // credential as long expired — a false red on all of them at once, which is
    // the fastest way to teach an operator to ignore this probe.
    const expSeconds = Math.floor((NOW + 10 * DAY) / 1000);
    expect(jwtExpiryMs(jwt({ exp: expSeconds }))).toBe(expSeconds * 1000);
  });

  test("base64url payloads decode — real tokens use - and _", () => {
    const expSeconds = Math.floor((NOW + 5 * DAY) / 1000);
    const token = jwt({ exp: expSeconds, sub: "a+b/c?", scope: "ops~admin" });
    expect(jwtExpiryMs(token)).toBe(expSeconds * 1000);
  });

  test("a token with no exp, a non-JWT, and garbage all read as null — never as fine", () => {
    expect(jwtExpiryMs(jwt({ sub: "nobody" }))).toBeNull();
    expect(jwtExpiryMs("ghp_notajsonwebtokenatall")).toBeNull();
    expect(jwtExpiryMs("a.b.c")).toBeNull();
    expect(jwtExpiryMs("")).toBeNull();
  });

  test("a non-numeric exp is refused rather than coerced", () => {
    expect(jwtExpiryMs(jwt({ exp: "1785900000" }))).toBeNull();
    expect(jwtExpiryMs(jwt({ exp: null }))).toBeNull();
  });
});

describe("the two thresholds are about how long the fix takes", () => {
  test("inside 3 days is RED — rotating an admin credential is a ceremony", () => {
    const v = expiryLine({ credential: cred({ expiresAtMs: NOW + 2 * DAY }), nowMs: NOW });
    expect(v.tone).toBe("red");
    expect(v.text).toContain("EXPIRES IN 2d");
  });

  test("inside 14 days is degraded — enough to schedule, not enough to become furniture", () => {
    expect(expiryLine({ credential: cred({ expiresAtMs: NOW + 10 * DAY }), nowMs: NOW }).tone).toBe("degraded");
  });

  test("beyond the window is ok and stays quiet", () => {
    expect(expiryLine({ credential: cred({ expiresAtMs: NOW + 90 * DAY }), nowMs: NOW }).tone).toBe("ok");
  });

  test("already expired reads in the PAST TENSE, not as a negative number", () => {
    // "expires in -2 days" is a number the eye slides off.
    const v = expiryLine({ credential: cred({ expiresAtMs: NOW - 2 * DAY }), nowMs: NOW });
    expect(v.tone).toBe("red");
    expect(v.text).toContain("EXPIRED 2d ago");
    expect(v.text).not.toContain("-2");
  });

  test("days round DOWN — 0d means today, and today is not tomorrow", () => {
    expect(daysUntil(NOW + DAY - 1, NOW)).toBe(0);
    expect(daysUntil(NOW + DAY + 1, NOW)).toBe(1);
  });
});

describe("cannot-read is never the same as fine", () => {
  test("an unreadable credential is awaiting, and says why", () => {
    const v = expiryLine({
      credential: cred({ expiresAtMs: null, unreadable: "TLS handshake failed" }),
      nowMs: NOW,
    });
    expect(v.tone).toBe("awaiting");
    expect(v.text).toContain("TLS handshake failed");
  });

  test("a credential that declares no expiry says so, naming the source", () => {
    const v = expiryLine({ credential: cred({ expiresAtMs: null, source: "github token header" }), nowMs: NOW });
    expect(v.tone).toBe("awaiting");
    expect(v.text).toContain("no expiry declared by github token header");
  });

  test("an unreadable credential DEGRADES the probe — unwatched is the thing this exists to stop", () => {
    const p = credentialExpiryProbe({
      credentials: [cred({ expiresAtMs: NOW + 90 * DAY }), cred({ label: "TLS", expiresAtMs: null, unreadable: "refused" })],
      nowMs: NOW,
    });
    expect(p.status).toBe("degraded");
    expect(p.detail).toContain("refused");
  });

  test("no credentials at all is DEGRADED, never ok — a check that never ran is not a pass", () => {
    const p = credentialExpiryProbe({ credentials: [], nowMs: NOW });
    expect(p.status).toBe("degraded");
    expect(p.detail).toContain("nothing is watching");
  });
});

describe("the verdict leads with what earned it", () => {
  test("worst tone wins and its credential is named first", () => {
    const p = credentialExpiryProbe({
      credentials: [
        cred({ label: "aaa-healthy", expiresAtMs: NOW + 200 * DAY }),
        cred({ label: "zzz-dying", expiresAtMs: NOW + 1 * DAY }),
        cred({ label: "mmm-soon", expiresAtMs: NOW + 9 * DAY }),
      ],
      nowMs: NOW,
    });
    expect(p.status).toBe("red");
    // Not alphabetical, not input order — the one about to expire.
    expect(p.detail.indexOf("zzz-dying")).toBe(0);
    expect(p.detail).not.toContain("aaa-healthy");
  });

  test("all healthy reports the soonest expiry, so the number is still visible", () => {
    const p = credentialExpiryProbe({
      credentials: [cred({ expiresAtMs: NOW + 200 * DAY }), cred({ expiresAtMs: NOW + 45 * DAY })],
      nowMs: NOW,
    });
    expect(p.status).toBe("ok");
    expect(p.detail).toContain("soonest expiry 45d");
  });

  test("the detail is bounded — three worst, not forty", () => {
    const many = Array.from({ length: 40 }, (_, i) => cred({ label: `c${i}`, expiresAtMs: NOW + 1 * DAY }));
    const p = credentialExpiryProbe({ credentials: many, nowMs: NOW });
    expect(p.detail.split(" · ")).toHaveLength(3);
  });
});

describe("collecting from artefacts, not from a list of dates", () => {
  const okCert = async () => ({ validToMs: NOW + 60 * DAY });

  test("a cert host that will not answer becomes UNREADABLE, never absent", async () => {
    // Dropping it would shrink the list silently and let the probe report a
    // clean bill of health over a credential nobody looked at.
    const { collectCredentialExpiries } = await import("../../src/credential-expiry.js");
    const got = await collectCredentialExpiries({
      certHosts: ["up.example", "down.example"],
      env: {},
      jwtEnvKeys: [],
      readCert: async (h) => (h === "down.example" ? { validToMs: null, error: "ECONNREFUSED" } : okCert()),
    });
    expect(got).toHaveLength(2);
    const down = got.find((c) => c.label.includes("down.example"))!;
    expect(down.unreadable).toBe("ECONNREFUSED");
    expect(credentialExpiryProbe({ credentials: got, nowMs: NOW }).status).toBe("degraded");
  });

  test("an UNSET credential is skipped entirely — not reported as unreadable", async () => {
    // "cannot read FOO" for a key nobody configured is the permanently-lit
    // panel this board keeps deleting.
    const { collectCredentialExpiries } = await import("../../src/credential-expiry.js");
    const got = await collectCredentialExpiries({
      certHosts: [],
      env: { SET_TOKEN: jwt({ exp: Math.floor((NOW + 20 * DAY) / 1000) }), EMPTY_TOKEN: "", BLANK_TOKEN: "   " },
      jwtEnvKeys: ["SET_TOKEN", "EMPTY_TOKEN", "BLANK_TOKEN", "NEVER_DEFINED"],
      readCert: okCert,
    });
    expect(got.map((c) => c.label)).toEqual(["SET_TOKEN"]);
  });

  test("an opaque non-JWT credential reports no declared expiry rather than an error", async () => {
    // A GitHub PAT legitimately carries no exp. That is a fact about the
    // credential, not a failure to read it.
    const { collectCredentialExpiries } = await import("../../src/credential-expiry.js");
    const got = await collectCredentialExpiries({
      certHosts: [],
      env: { GITHUB_TOKEN: "ghp_opaqueopaqueopaque" },
      jwtEnvKeys: ["GITHUB_TOKEN"],
      readCert: okCert,
    });
    expect(got[0]!.expiresAtMs).toBeNull();
    expect(got[0]!.unreadable ?? null).toBeNull();
    expect(expiryLine({ credential: got[0]!, nowMs: NOW }).text).toContain("no expiry declared");
  });

  test("certs come first — a lapsed one is a total outage, not a degraded feature", async () => {
    const { collectCredentialExpiries } = await import("../../src/credential-expiry.js");
    const got = await collectCredentialExpiries({
      certHosts: ["a.example"],
      env: { T: jwt({ exp: Math.floor((NOW + DAY) / 1000) }) },
      jwtEnvKeys: ["T"],
      readCert: okCert,
    });
    expect(got[0]!.label).toBe("TLS a.example");
  });
});
