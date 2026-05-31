import { describe, expect, it, vi } from "vitest";

import {
  parseSweepSessionConfig,
  parseSweepSessionRole,
  isSweepSessionConfigured,
  normalizeStorageState,
  resolveSweepSession,
  buildSweepContextOptions,
  DEFAULT_AUTHED_ROUTES,
  type SweepStorageState,
} from "../../services/slack-operator/src/testbed-session.js";

const STORAGE: SweepStorageState = {
  cookies: [{ name: "session", value: "x", domain: "app.example", path: "/" }],
  origins: [],
};

function okJson(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("parseSweepSessionConfig / role", () => {
  it("reads the env source fields; defaults type=browser", () => {
    const cfg = parseSweepSessionConfig({
      TESTBED_SESSION_SIGNER_URL: "http://signer:8791",
      TESTBED_SESSION_ROLE: "admin",
    });
    expect(cfg).toMatchObject({ signerBaseUrl: "http://signer:8791", role: "admin", sessionType: "browser" });
  });
  it("role parse defaults to agent and is case-insensitive", () => {
    expect(parseSweepSessionRole(undefined)).toBe("agent");
    expect(parseSweepSessionRole("ADMIN")).toBe("admin");
    expect(parseSweepSessionRole("verifier")).toBe("verifier");
    expect(parseSweepSessionRole("nonsense")).toBe("agent");
  });
  it("isSweepSessionConfigured is false with no source (→ public-only)", () => {
    expect(isSweepSessionConfigured({})).toBe(false);
    expect(isSweepSessionConfigured({ signerBaseUrl: "http://x" })).toBe(true);
    expect(isSweepSessionConfigured({ storageStatePath: "/p" })).toBe(true);
    expect(isSweepSessionConfigured({ token: "t" })).toBe(true);
  });
});

describe("normalizeStorageState", () => {
  it("accepts {cookies[],origins[]}; rejects anything else", () => {
    expect(normalizeStorageState(STORAGE)).toEqual(STORAGE);
    expect(normalizeStorageState({ cookies: [] , origins: [] })).toEqual({ cookies: [], origins: [] });
    expect(normalizeStorageState({ cookies: [] })).toBeUndefined();
    expect(normalizeStorageState("nope")).toBeUndefined();
    expect(normalizeStorageState(null)).toBeUndefined();
  });
});

describe("resolveSweepSession — no source / fallback", () => {
  it("returns undefined when nothing is configured (no fetch / no fs touched)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const readFileImpl = vi.fn();
    const session = await resolveSweepSession({}, { fetchImpl, readFileImpl });
    expect(session).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileImpl).not.toHaveBeenCalled();
  });
});

describe("resolveSweepSession — manual source (decoupled for landing)", () => {
  it("reads a storageState file and returns it (with token if provided)", async () => {
    const readFileImpl = vi.fn(async () => JSON.stringify(STORAGE));
    const session = await resolveSweepSession(
      { storageStatePath: "/data/state.json", token: "bearer-xyz", role: "admin" },
      { readFileImpl },
    );
    expect(session).toEqual({ role: "admin", storageState: STORAGE, token: "bearer-xyz" });
  });

  it("token-only manual session (API checks, no storageState)", async () => {
    const session = await resolveSweepSession({ token: "bearer-only" }, {});
    expect(session).toEqual({ role: "agent", token: "bearer-only" });
  });

  it("malformed storageState file degrades cleanly (no throw, no session) and warns without the path", async () => {
    const warn = vi.fn();
    const readFileImpl = vi.fn(async () => "{ not json");
    const session = await resolveSweepSession({ storageStatePath: "/data/state.json" }, { readFileImpl, warn });
    expect(session).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // never log the path/secret
    expect(warn.mock.calls.flat().join(" ")).not.toContain("/data/state.json");
  });

  it("unreadable file degrades cleanly", async () => {
    const readFileImpl = vi.fn(async () => { throw new Error("ENOENT"); });
    const session = await resolveSweepSession({ storageStatePath: "/nope.json" }, { readFileImpl });
    expect(session).toBeUndefined();
  });
});

describe("resolveSweepSession — T3 sidecar source", () => {
  it("fetches GET /session/:role?type=browser and returns storageState", async () => {
    const fetchImpl = okJson({ type: "browser", role: "agent", storageState: STORAGE });
    const session = await resolveSweepSession({ signerBaseUrl: "http://signer:8791/", role: "agent" }, { fetchImpl });
    expect(session).toEqual({ role: "agent", storageState: STORAGE });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "http://signer:8791/session/agent?type=browser",
    );
  });

  it("type=api returns the Bearer token", async () => {
    const fetchImpl = okJson({ type: "api", role: "admin", token: "jwt-abc" });
    const session = await resolveSweepSession(
      { signerBaseUrl: "http://signer:8791", role: "admin", sessionType: "api" },
      { fetchImpl },
    );
    expect(session).toEqual({ role: "admin", token: "jwt-abc" });
  });

  it("a non-OK sidecar response degrades cleanly", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const session = await resolveSweepSession({ signerBaseUrl: "http://signer:8791" }, { fetchImpl });
    expect(session).toBeUndefined();
  });

  it("an unreachable sidecar (throws) degrades cleanly — never fails the sweep", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const session = await resolveSweepSession({ signerBaseUrl: "http://signer:8791" }, { fetchImpl });
    expect(session).toBeUndefined();
  });

  it("a browser session missing storageState degrades cleanly", async () => {
    const fetchImpl = okJson({ type: "browser", role: "agent" });
    const session = await resolveSweepSession({ signerBaseUrl: "http://signer:8791" }, { fetchImpl });
    expect(session).toBeUndefined();
  });
});

describe("buildSweepContextOptions", () => {
  it("no session → just viewport + UA (no storageState, no auth header)", () => {
    const opts = buildSweepContextOptions(undefined);
    expect(opts.storageState).toBeUndefined();
    expect(opts.extraHTTPHeaders).toBeUndefined();
    expect(opts.userAgent).toContain("Surface-Sweep");
  });
  it("storageState session → passed to newContext", () => {
    const opts = buildSweepContextOptions({ role: "agent", storageState: STORAGE });
    expect(opts.storageState).toEqual(STORAGE);
  });
  it("token session → Authorization Bearer attached for the page's API calls", () => {
    const opts = buildSweepContextOptions({ role: "agent", token: "jwt-abc" });
    expect(opts.extraHTTPHeaders).toEqual({ Authorization: "Bearer jwt-abc" });
  });
});

describe("DEFAULT_AUTHED_ROUTES", () => {
  it("covers the documented operator pages", () => {
    expect(DEFAULT_AUTHED_ROUTES).toEqual(
      expect.arrayContaining(["/overview", "/runs", "/sessions", "/receipts", "/treasury", "/disputes", "/policies", "/agents", "/audit-log", "/capabilities"]),
    );
  });
});
