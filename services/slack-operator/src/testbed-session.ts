// Hermes e2e tester — T2 pre-seeded session.
//
// Wires a real auth session into the surface sweep so the per-deploy tester can
// reach the AUTHED operator app, not just public pages. READ-ONLY: the session
// only authenticates navigation; nothing is mutated.
//
// Two session sources, decoupled for landing (per the auth design):
//   (a) the T3 signer sidecar — GET /session/:role?type=browser → storageState
//       (and ?type=api → Bearer JWT); the key never enters this process.
//   (b) a manually-provided storageState (a file path) and/or Bearer token, so
//       authed sweep works before the sidecar is wired in a given env.
//
// Graceful by design: with NO session configured, resolution returns undefined
// and the sweep runs public-only. A malformed/unreachable source degrades to
// undefined too — never throws, never fails the sweep just because a session is
// absent. Secrets (storageState cookies, Bearer tokens) are NEVER logged.

export type SweepSessionRole = "agent" | "admin" | "verifier";

/** A Playwright storageState (cookies + origins). Kept structural so this module
 *  doesn't couple to the signer service's types. */
export interface SweepStorageState {
  cookies: unknown[];
  origins: unknown[];
}

/** A resolved session the sweep can use: storageState for the browser context,
 *  and/or a Bearer token for API checks. */
export interface SweepSession {
  role: SweepSessionRole;
  storageState?: SweepStorageState;
  token?: string;
}

export interface CloudflareAccessServiceToken {
  clientId: string;
  clientSecret: string;
}

export interface SweepSessionConfig {
  /** Which role's session to use (default "agent"). */
  role?: string;
  /** "browser" (storageState, default) or "api" (Bearer) when pulling from the sidecar. */
  sessionType?: "browser" | "api";
  /** T3 signer sidecar base URL, e.g. http://test-wallet-signer:8791. */
  signerBaseUrl?: string;
  /** Manual storageState file path (decoupled-for-landing source). */
  storageStatePath?: string;
  /** Manual Bearer token (secret; never logged). */
  token?: string;
}

export interface SweepSessionDeps {
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to fs/promises readFile (utf8). */
  readFileImpl?: (path: string) => Promise<string>;
  /** Non-throwing warning sink (never receives secrets). */
  warn?: (message: string, detail?: Record<string, unknown>) => void;
}

/** The default AUTHED operator routes the sweep covers once a session is present
 *  (per docs/HERMES_E2E_TESTER_DESIGN.md). Override per-mission with `routes`. */
export const DEFAULT_AUTHED_ROUTES = [
  "/overview",
  "/runs",
  "/sessions",
  "/receipts",
  "/treasury",
  "/disputes",
  "/policies",
  "/agents",
  "/audit-log",
  "/capabilities",
];

export function parseSweepSessionRole(value: string | undefined): SweepSessionRole {
  switch ((value ?? "").trim().toLowerCase()) {
    case "admin":
      return "admin";
    case "verifier":
      return "verifier";
    case "agent":
    default:
      return "agent";
  }
}

export function parseSweepSessionConfig(env: NodeJS.ProcessEnv = process.env): SweepSessionConfig {
  return {
    ...(env.TESTBED_SESSION_ROLE ? { role: env.TESTBED_SESSION_ROLE } : {}),
    sessionType: env.TESTBED_SESSION_TYPE === "api" ? "api" : "browser",
    ...(env.TESTBED_SESSION_SIGNER_URL ? { signerBaseUrl: env.TESTBED_SESSION_SIGNER_URL } : {}),
    ...(env.TESTBED_SESSION_STORAGE_STATE_PATH ? { storageStatePath: env.TESTBED_SESSION_STORAGE_STATE_PATH } : {}),
    ...(env.TESTBED_SESSION_TOKEN ? { token: env.TESTBED_SESSION_TOKEN } : {}),
  };
}

export function parseCloudflareAccessServiceToken(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareAccessServiceToken | undefined {
  const clientId = firstNonEmpty(
    env.TESTBED_CF_ACCESS_CLIENT_ID,
    env.CF_ACCESS_CLIENT_ID,
    env.CLOUDFLARE_ACCESS_CLIENT_ID,
  );
  const clientSecret = firstNonEmpty(
    env.TESTBED_CF_ACCESS_CLIENT_SECRET,
    env.CF_ACCESS_CLIENT_SECRET,
    env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
  );
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export function cloudflareAccessHeaders(
  token?: CloudflareAccessServiceToken,
): Record<string, string> {
  return token
    ? {
      "CF-Access-Client-Id": token.clientId,
      "CF-Access-Client-Secret": token.clientSecret,
    }
    : {};
}

// ── HTTP Basic Auth (the REAL edge gate on app.averray.com) ──────────
//
// app.averray.com is gated by Caddy HTTP Basic Auth (401, www-authenticate:
// Basic realm="Averray Operator") — NOT Cloudflare Access. The tester sends
// `Authorization: Basic base64(user:pass)` (fetch executors) or Playwright
// httpCredentials (browser executors) so a sweep can LOAD the gated pages.
// The credential is applied ONLY to the configured gated host(s) and is never
// logged or written to a report. (Authed gold-path flows still need the SIWE
// session on top — separate follow-up.)

export interface TestbedBasicAuthCredential {
  username: string;
  password: string;
}

export interface TestbedBasicAuth {
  credential: TestbedBasicAuthCredential;
  /** Lowercased hostnames the credential is allowed to be sent to. */
  hosts: string[];
}

/** Default gated host when TESTBED_BASIC_AUTH_HOSTS is unset (confirmed gate). */
export const DEFAULT_BASIC_AUTH_HOSTS = ["app.averray.com"];

export function parseTestbedBasicAuth(
  env: NodeJS.ProcessEnv = process.env,
): TestbedBasicAuth | undefined {
  const username = firstNonEmpty(env.TESTBED_BASIC_AUTH_USER);
  const password = firstNonEmpty(env.TESTBED_BASIC_AUTH_PASS);
  if (!username || !password) return undefined;
  const hosts = parseHostList(env.TESTBED_BASIC_AUTH_HOSTS) ?? DEFAULT_BASIC_AUTH_HOSTS;
  return { credential: { username, password }, hosts };
}

function parseHostList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/** Whether the gated-host Basic Auth applies to `targetUrl` (host allowlisted). */
export function basicAuthAppliesToUrl(
  targetUrl: string,
  basicAuth: TestbedBasicAuth | undefined,
): boolean {
  if (!basicAuth) return false;
  try {
    return basicAuth.hosts.includes(new URL(targetUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** `Basic base64(user:pass)` header value — for fetch-based executors. */
export function basicAuthHeaderValue(credential: TestbedBasicAuthCredential): string {
  const token = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/**
 * Build request headers for an allowlisted gated-host request. This mirrors
 * `curl --user` by pre-sending the Basic header, but only for configured hosts.
 * Returns undefined when the request URL is not allowlisted, so callers can
 * continue the request unchanged and never leak credentials to third parties.
 */
export function basicAuthHeadersForUrl(
  requestUrl: string,
  basicAuth: TestbedBasicAuth | undefined,
  existingHeaders: Record<string, string> = {},
): Record<string, string> | undefined {
  if (!basicAuthAppliesToUrl(requestUrl, basicAuth) || !basicAuth) return undefined;
  const next = { ...existingHeaders };
  delete next.Authorization;
  next.authorization = basicAuthHeaderValue(basicAuth.credential);
  return next;
}

/**
 * Playwright newContext() httpCredentials scoped to the gated origin, so the
 * credential is answered ONLY to a 401 from that origin and never leaks to
 * third-party origins the page might touch. Returns undefined when Basic Auth
 * doesn't apply to the target.
 */
export function basicAuthHttpCredentialsForUrl(
  targetUrl: string,
  basicAuth: TestbedBasicAuth | undefined,
): { username: string; password: string; origin: string } | undefined {
  if (!basicAuthAppliesToUrl(targetUrl, basicAuth) || !basicAuth) return undefined;
  try {
    return {
      username: basicAuth.credential.username,
      password: basicAuth.credential.password,
      origin: new URL(targetUrl).origin,
    };
  } catch {
    return undefined;
  }
}

/** Whether any session source is configured. When false, the sweep runs
 *  public-only (no fetch / no fs touched). */
export function isSweepSessionConfigured(config: SweepSessionConfig): boolean {
  return Boolean(config.signerBaseUrl || config.storageStatePath || config.token);
}

/** Validate an unknown value as a Playwright storageState ({ cookies[], origins[] }). */
export function normalizeStorageState(value: unknown): SweepStorageState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const cookies = record.cookies;
  const origins = record.origins;
  if (!Array.isArray(cookies) || !Array.isArray(origins)) return undefined;
  return { cookies, origins };
}

/**
 * Resolve a session from the configured source(s). Manual path/token take
 * precedence (no network), then the sidecar. Returns undefined when nothing is
 * configured or any source degrades — NEVER throws.
 */
export async function resolveSweepSession(
  config: SweepSessionConfig,
  deps: SweepSessionDeps = {},
): Promise<SweepSession | undefined> {
  if (!isSweepSessionConfigured(config)) return undefined;
  const warn = deps.warn ?? (() => {});
  const role = parseSweepSessionRole(config.role);

  // (b) Manual storageState file — decoupled-for-landing source.
  if (config.storageStatePath) {
    const storageState = await readManualStorageState(config.storageStatePath, deps, warn);
    if (storageState) {
      return { role, storageState, ...(config.token ? { token: config.token } : {}) };
    }
    // Fall through: a bad manual file shouldn't strand a configured token/sidecar.
  }

  // (b) Manual token only (API checks) — no storageState available.
  if (config.token && !config.signerBaseUrl) {
    return { role, token: config.token };
  }

  // (a) The T3 signer sidecar.
  if (config.signerBaseUrl) {
    return fetchSidecarSession(config, role, deps, warn);
  }

  return undefined;
}

async function readManualStorageState(
  path: string,
  deps: SweepSessionDeps,
  warn: NonNullable<SweepSessionDeps["warn"]>,
): Promise<SweepStorageState | undefined> {
  try {
    const readFileImpl = deps.readFileImpl ?? (async (p: string) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(p, "utf8");
    });
    const raw = await readFileImpl(path);
    const storageState = normalizeStorageState(JSON.parse(raw));
    if (!storageState) {
      warn("testbed_session_manual_storage_state_malformed"); // no path/secret in the log
      return undefined;
    }
    return storageState;
  } catch {
    warn("testbed_session_manual_storage_state_unreadable");
    return undefined;
  }
}

async function fetchSidecarSession(
  config: SweepSessionConfig,
  role: SweepSessionRole,
  deps: SweepSessionDeps,
  warn: NonNullable<SweepSessionDeps["warn"]>,
): Promise<SweepSession | undefined> {
  const type = config.sessionType === "api" ? "api" : "browser";
  const base = (config.signerBaseUrl ?? "").replace(/\/+$/, "");
  const url = `${base}/session/${role}?type=${type}`;
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url);
    if (!res.ok) {
      warn("testbed_session_sidecar_non_ok", { status: res.status, role });
      return undefined;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (type === "browser") {
      const storageState = normalizeStorageState(body.storageState);
      if (!storageState) {
        warn("testbed_session_sidecar_missing_storage_state", { role });
        return undefined;
      }
      return { role, storageState };
    }
    const token = typeof body.token === "string" && body.token.length > 0 ? body.token : undefined;
    if (!token) {
      warn("testbed_session_sidecar_missing_token", { role });
      return undefined;
    }
    return { role, token };
  } catch {
    // Unreachable sidecar must not fail the sweep — degrade to public-only.
    warn("testbed_session_sidecar_unreachable", { role });
    return undefined;
  }
}

/**
 * Build the Playwright newContext() options for a sweep, layering in the
 * session: storageState rehydrates the authed browser; a Bearer token is
 * attached so the page's same-origin API calls are authed too. Pure + tested.
 */
export function buildSweepContextOptions(
  session?: SweepSession,
  cloudflareAccess?: CloudflareAccessServiceToken,
  httpCredentials?: { username: string; password: string; origin?: string },
): Record<string, unknown> {
  const extraHTTPHeaders = {
    ...cloudflareAccessHeaders(cloudflareAccess),
    ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
  };
  return {
    viewport: { width: 1365, height: 900 },
    userAgent: "Averray-Hermes-Surface-Sweep/1.0",
    ...(session?.storageState ? { storageState: session.storageState } : {}),
    ...(Object.keys(extraHTTPHeaders).length > 0 ? { extraHTTPHeaders } : {}),
    // Caddy HTTP Basic Auth on the gated host — Playwright answers the 401
    // challenge with these creds, scoped to `origin` so they never leak.
    ...(httpCredentials ? { httpCredentials } : {}),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
