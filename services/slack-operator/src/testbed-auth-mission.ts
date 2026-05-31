import type { TestbedMissionRun } from "./monitor-testbed-missions.js";
import type { TestbedMissionRunResult } from "./testbed-mission-runner.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type AuthRole = "agent" | "admin" | "verifier";
type FindingStatus = "pass" | "fail";

interface AuthSession {
  role: AuthRole;
  token: string;
  roles: string[];
  jwtRoles: string[];
  expiresAt?: string;
}

interface AuthFinding {
  id: string;
  label: string;
  status: FindingStatus;
  expected: string;
  actual: string;
  evidence: string[];
}

interface AuthHttpResult {
  status: number;
  json?: unknown;
  text: string;
}

export interface SiweAuthMissionDeps {
  fetchFn?: FetchLike;
}

const AUTH_ROLES: AuthRole[] = ["agent", "admin", "verifier"];
const PRIVILEGED_ROLES = new Set(["admin", "verifier"]);

export async function executeSiweAuthMission(
  mission: TestbedMissionRun,
  config: {
    signerBaseUrl?: string;
    apiBaseUrl?: string;
    appBaseUrl?: string;
    authAdminJobsPath?: string;
    authVerifierRunPath?: string;
    authProtectedPath?: string;
    timeoutMs?: number;
  },
  deps: SiweAuthMissionDeps = {},
): Promise<TestbedMissionRunResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const signerBaseUrl = config.signerBaseUrl || "http://127.0.0.1:8791";
  const apiBaseUrl = config.apiBaseUrl || config.appBaseUrl || originOf(mission.targetUrl);
  const adminJobsPath = config.authAdminJobsPath || "/admin/jobs";
  const verifierRunPath = config.authVerifierRunPath || "/verifier/run";
  const noTokenPath = config.authProtectedPath || adminJobsPath;
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 30_000, 1_000), 60_000);

  const completedPath: string[] = [];
  const findings: AuthFinding[] = [];
  const evidence: Array<{ type: string; value: string }> = [
    { type: "executor", value: "siwe_auth_role_gating" },
    { type: "mode", value: "siwe_auth" },
    { type: "mutation_boundary", value: "read-only mission; wrong-role POSTs use empty payloads and expect auth guards before mutation" },
  ];
  const mutationBoundaryNotes = [
    "SIWE auth mission is read-only: it mints sessions through the signer sidecar, then sends empty wrong-role requests that should be rejected before any product mutation.",
  ];
  const sessions = new Map<AuthRole, AuthSession>();

  for (const role of AUTH_ROLES) {
    const finding = await mintSession(role, signerBaseUrl, fetchFn, timeoutMs);
    findings.push(finding.finding);
    completedPath.push(`requested ${role} API session from signer sidecar`);
    if (finding.session) {
      sessions.set(role, finding.session);
      evidence.push({
        type: "auth_session",
        value: `${role}: roles=${formatRoles(finding.session.jwtRoles)} sidecarRoles=${formatRoles(finding.session.roles)}`,
      });
    }
  }

  const agentSession = sessions.get("agent");
  if (agentSession) {
    findings.push(await expectRoleGate({
      id: "agent_admin_jobs_forbidden",
      label: "agent token cannot create admin jobs",
      expected: "403 missing_role",
      url: joinUrl(apiBaseUrl, adminJobsPath),
      token: agentSession.token,
      fetchFn,
      timeoutMs,
    }));
    completedPath.push(`checked agent token against ${adminJobsPath}`);

    findings.push(await expectRoleGate({
      id: "agent_verifier_forbidden",
      label: "agent token cannot run verifier-only action",
      expected: "403 missing_role",
      url: joinUrl(apiBaseUrl, verifierRunPath),
      token: agentSession.token,
      fetchFn,
      timeoutMs,
    }));
    completedPath.push(`checked agent token against ${verifierRunPath}`);
  } else {
    findings.push({
      id: "agent_negative_checks_skipped",
      label: "agent negative role checks",
      status: "fail",
      expected: "agent session exists so wrong-role checks can run",
      actual: "agent session unavailable; negative role-gating checks skipped",
      evidence: ["missing agent session"],
    });
  }

  findings.push(await expectWalletSignIn({
    url: joinUrl(apiBaseUrl, noTokenPath),
    fetchFn,
    timeoutMs,
  }));
  completedPath.push(`checked no-token protected route at ${noTokenPath}`);

  for (const finding of findings) {
    evidence.push({
      type: finding.status === "pass" ? "auth_check_pass" : "auth_check_fail",
      value: `${finding.id}: ${finding.actual}`,
    });
  }

  const failed = findings.filter((finding) => finding.status === "fail");
  const verdict = failed.length > 0 ? "fail" : "pass";
  const report = {
    missionId: mission.id,
    verdict,
    confidence: verdict === "pass" ? 0.9 : 0.74,
    executor: "siwe_auth_role_gating",
    runnerMode: "siwe_auth",
    mode: "siwe_auth",
    targetUrl: mission.targetUrl,
    goal: mission.goal,
    stoppedBeforeMutation: true,
    mutationMode: "read_only",
    mutationsAttempted: [],
    mutationBoundaryNotes,
    completedPath,
    blockers: failed.map((finding) => `${finding.label}: ${finding.actual}`),
    confusingMoments: [],
    recommendations: failed.length
      ? ["Inspect signer-sidecar availability, JWT role claims, and auth middleware error payloads before rerunning the SIWE mission."]
      : [],
    evidence,
    scores: {
      roleClaims: scoreFindings(findings.filter((finding) => finding.id.startsWith("role_claims_"))),
      roleGating: scoreFindings(findings.filter((finding) => finding.id.includes("_forbidden"))),
      authNextStep: scoreFindings(findings.filter((finding) => finding.id === "no_token_wallet_sign_in")),
      evidenceQuality: 5,
    },
    findings: findings.map((finding) => ({
      ...finding,
      evidence: finding.evidence.map(redactAuthSensitive),
    })),
    roleClaims: Object.fromEntries(
      AUTH_ROLES.map((role) => {
        const session = sessions.get(role);
        return [role, session ? { jwtRoles: session.jwtRoles, sidecarRoles: session.roles, expiresAt: session.expiresAt } : null];
      }),
    ),
    summary: verdict === "pass"
      ? "siwe_auth pass: sessions minted for agent/admin/verifier, wrong-role requests returned missing_role, and no-token flow asks for wallet sign-in"
      : `siwe_auth fail: ${failed[0]?.actual ?? "one or more auth checks failed"}`,
  };

  return {
    exitCode: 0,
    stdout: `SIWE auth mission completed for ${mission.id}: ${verdict}\n`,
    stderr: "",
    reportText: `${JSON.stringify(report, null, 2)}\n`,
    summary: report.summary,
  };
}

async function mintSession(
  role: AuthRole,
  signerBaseUrl: string,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<{ finding: AuthFinding; session?: AuthSession }> {
  try {
    const result = await fetchJson(fetchFn, joinUrl(signerBaseUrl, `/session/${role}?type=api`), { method: "GET" }, timeoutMs);
    if (result.status !== 200 || !isRecord(result.json)) {
      return {
        finding: {
          id: `role_claims_${role}`,
          label: `${role} API session`,
          status: "fail",
          expected: "signer sidecar returns 200 with a Bearer token",
          actual: `sidecar returned HTTP ${result.status}`,
          evidence: [`sidecar status ${result.status}`],
        },
      };
    }
    const token = typeof result.json.token === "string" ? result.json.token : "";
    if (!token) {
      return {
        finding: {
          id: `role_claims_${role}`,
          label: `${role} API session`,
          status: "fail",
          expected: "session response includes a token",
          actual: "sidecar response had no token",
          evidence: ["token missing"],
        },
      };
    }
    const sidecarRoles = stringArray(result.json.roles);
    const jwtRoles = extractJwtRoles(token);
    const roleOk = expectedRoleClaims(role, jwtRoles);
    const expiresAt = typeof result.json.expiresAt === "string" ? result.json.expiresAt : undefined;
    return {
      finding: {
        id: `role_claims_${role}`,
        label: `${role} JWT role claims`,
        status: roleOk ? "pass" : "fail",
        expected: expectedRoleText(role),
        actual: `jwtRoles=${formatRoles(jwtRoles)} sidecarRoles=${formatRoles(sidecarRoles)}`,
        evidence: [`expiresAt=${expiresAt ?? "unknown"}`],
      },
      session: {
        role,
        token,
        roles: sidecarRoles,
        jwtRoles,
        ...(expiresAt ? { expiresAt } : {}),
      },
    };
  } catch (error) {
    return {
      finding: {
        id: `role_claims_${role}`,
        label: `${role} API session`,
        status: "fail",
        expected: "signer sidecar reachable and returns a session",
        actual: redactAuthSensitive(error instanceof Error ? error.message : String(error)),
        evidence: ["sidecar fetch failed"],
      },
    };
  }
}

async function expectRoleGate(input: {
  id: string;
  label: string;
  expected: string;
  url: string;
  token: string;
  fetchFn: FetchLike;
  timeoutMs: number;
}): Promise<AuthFinding> {
  const result = await fetchJson(input.fetchFn, input.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: "{}",
  }, input.timeoutMs);
  const code = errorCode(result.json);
  const ok = result.status === 403 && code === "missing_role";
  return {
    id: input.id,
    label: input.label,
    status: ok ? "pass" : "fail",
    expected: input.expected,
    actual: `HTTP ${result.status}${code ? ` ${code}` : ""}`,
    evidence: [`payload=${redactAuthSensitive(shortJson(result.json) || result.text || "[empty]")}`],
  };
}

async function expectWalletSignIn(input: {
  url: string;
  fetchFn: FetchLike;
  timeoutMs: number;
}): Promise<AuthFinding> {
  const result = await fetchJson(input.fetchFn, input.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, input.timeoutMs);
  const requiredAction = requiredActionValue(result.json);
  const ok = result.status === 401 && requiredAction === "wallet_sign_in";
  return {
    id: "no_token_wallet_sign_in",
    label: "no token on protected route",
    status: ok ? "pass" : "fail",
    expected: '401 with requiredAction "wallet_sign_in"',
    actual: `HTTP ${result.status}${requiredAction ? ` requiredAction=${requiredAction}` : ""}`,
    evidence: [`payload=${redactAuthSensitive(shortJson(result.json) || result.text || "[empty]")}`],
  };
}

async function fetchJson(fetchFn: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<AuthHttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return {
      status: response.status,
      text: redactAuthSensitive(clip(text, 600)),
      json: parseJson(text),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function expectedRoleClaims(role: AuthRole, jwtRoles: string[]): boolean {
  if (role === "agent") return !jwtRoles.some((claim) => PRIVILEGED_ROLES.has(claim));
  return jwtRoles.includes(role);
}

function expectedRoleText(role: AuthRole): string {
  if (role === "agent") return "no admin/verifier role claims";
  return `JWT includes ${role}`;
}

function extractJwtRoles(token: string): string[] {
  const [, payload] = token.split(".");
  if (!payload) return [];
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return [];
    return uniqueStrings([
      ...stringArray(parsed.roles),
      ...stringArray(parsed.role),
      ...(isRecord(parsed.claims) ? stringArray(parsed.claims.roles) : []),
      ...(isRecord(parsed.auth) ? stringArray(parsed.auth.roles) : []),
    ]).map((role) => role.toLowerCase());
  } catch {
    return [];
  }
}

function errorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["error", "code", "reason"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function requiredActionValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.requiredAction === "string") return value.requiredAction;
  for (const nested of Object.values(value)) {
    const found = requiredActionValue(nested);
    if (found) return found;
  }
  return undefined;
}

function scoreFindings(findings: AuthFinding[]): number {
  if (!findings.length) return 0;
  const passed = findings.filter((finding) => finding.status === "pass").length;
  return Math.round((passed / findings.length) * 5);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatRoles(roles: string[]): string {
  return roles.length ? roles.join(",") : "none";
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "http://127.0.0.1:8790";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function shortJson(value: unknown): string {
  if (value === undefined) return "";
  return clip(JSON.stringify(value), 600);
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function redactAuthSensitive(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [redacted]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[redacted private key]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
