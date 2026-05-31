import { describe, expect, it, vi } from "vitest";

import type { TestbedMissionRun } from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
  executeBrowserTestbedMission,
  type TestbedMissionRunnerConfig,
} from "../../services/slack-operator/src/testbed-mission-runner.js";
import { executeSiweAuthMission } from "../../services/slack-operator/src/testbed-auth-mission.js";

const config: TestbedMissionRunnerConfig = {
  enabled: true,
  runnerId: "test",
  args: [],
  pollIntervalMs: 1,
  timeoutMs: 1000,
  outputTailBytes: 1000,
  apiBaseUrl: "https://api.example.test",
  signerBaseUrl: "http://signer.local",
  authAdminJobsPath: "/admin/jobs",
  authVerifierRunPath: "/verifier/run",
  authProtectedPath: "/admin/jobs",
};

function mission(overrides: Partial<TestbedMissionRun> = {}): TestbedMissionRun {
  return {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: "auth-1",
    status: "running",
    title: "SIWE auth role-gating mission",
    targetUrl: "https://api.example.test",
    goal: "Verify SIWE sessions and role gates",
    agentName: "Hermes",
    freshMemory: true,
    allowTestMutations: false,
    mode: "siwe_auth",
    mission: {},
    history: [],
    createdAt: "2026-05-31T00:00:00Z",
    updatedAt: "2026-05-31T00:00:00Z",
    statusReason: "running",
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function happyFetch() {
  const agentToken = jwt({ sub: "0xagent", roles: [] });
  const adminToken = jwt({ sub: "0xadmin", roles: ["admin"] });
  const verifierToken = jwt({ sub: "0xverifier", roles: ["verifier"] });
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = String(init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (url === "http://signer.local/session/agent?type=api") {
      return json({ token: agentToken, roles: ["agent"], expiresAt: "2026-05-31T01:00:00Z" });
    }
    if (url === "http://signer.local/session/admin?type=api") {
      return json({ token: adminToken, roles: ["admin"], expiresAt: "2026-05-31T01:00:00Z" });
    }
    if (url === "http://signer.local/session/verifier?type=api") {
      return json({ token: verifierToken, roles: ["verifier"], expiresAt: "2026-05-31T01:00:00Z" });
    }
    if (url === "https://api.example.test/admin/jobs" && !auth) {
      return json({ error: "unauthorized", requiredAction: "wallet_sign_in" }, 401);
    }
    if (url === "https://api.example.test/admin/jobs" && auth === `Bearer ${agentToken}`) {
      return json({ error: "missing_role", requiredRole: "admin" }, 403);
    }
    if (url === "https://api.example.test/verifier/run" && auth === `Bearer ${agentToken}`) {
      return json({ error: "missing_role", requiredRole: "verifier" }, 403);
    }
    return json({ error: "unexpected", url, auth }, 500);
  });
  return { fetchFn, agentToken, adminToken, verifierToken };
}

describe("SIWE auth mission", () => {
  it("passes when role sessions mint and protected routes enforce 401/403 boundaries", async () => {
    const { fetchFn } = happyFetch();
    const result = await executeSiweAuthMission(mission(), config, { fetchFn });
    const report = JSON.parse(result.reportText ?? "{}");

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      executor: "siwe_auth_role_gating",
      mode: "siwe_auth",
      verdict: "pass",
      mutationMode: "read_only",
      stoppedBeforeMutation: true,
      roleClaims: {
        agent: { jwtRoles: [] },
        admin: { jwtRoles: ["admin"] },
        verifier: { jwtRoles: ["verifier"] },
      },
      scores: {
        roleClaims: 5,
        roleGating: 5,
        authNextStep: 5,
      },
    });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent_admin_jobs_forbidden", status: "pass", actual: "HTTP 403 missing_role" }),
      expect.objectContaining({ id: "agent_verifier_forbidden", status: "pass", actual: "HTTP 403 missing_role" }),
      expect.objectContaining({ id: "no_token_wallet_sign_in", status: "pass", actual: "HTTP 401 requiredAction=wallet_sign_in" }),
    ]));
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.test/admin/jobs",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("routes siwe_auth through the browser mission dispatcher without launching Playwright", async () => {
    const { fetchFn } = happyFetch();
    const result = await executeBrowserTestbedMission(mission({ mode: "siwe_auth" }), config, { fetchFn });
    expect(JSON.parse(result.reportText ?? "{}").executor).toBe("siwe_auth_role_gating");
  });

  it("returns a structured failing report when a role is unavailable instead of crashing", async () => {
    const { fetchFn } = happyFetch();
    fetchFn.mockImplementationOnce(async () => json({ token: jwt({ roles: [] }), roles: ["agent"] }))
      .mockImplementationOnce(async () => json({ error: "session_unavailable" }, 503))
      .mockImplementationOnce(async () => json({ token: jwt({ roles: ["verifier"] }), roles: ["verifier"] }))
      .mockImplementation(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
        if (url.endsWith("/admin/jobs") && !auth) return json({ requiredAction: "wallet_sign_in" }, 401);
        if (url.endsWith("/admin/jobs")) return json({ error: "missing_role" }, 403);
        if (url.endsWith("/verifier/run")) return json({ error: "missing_role" }, 403);
        return json({ error: "unexpected" }, 500);
      });

    const result = await executeSiweAuthMission(mission(), config, { fetchFn });
    const report = JSON.parse(result.reportText ?? "{}");

    expect(report.verdict).toBe("fail");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("admin API session"),
    ]));
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "role_claims_admin", status: "fail", actual: "sidecar returned HTTP 503" }),
    ]));
  });

  it("never includes bearer tokens or JWTs in stdout, stderr, or report evidence", async () => {
    const { fetchFn, agentToken, adminToken, verifierToken } = happyFetch();
    const result = await executeSiweAuthMission(mission(), config, { fetchFn });
    const output = `${result.stdout}\n${result.stderr}\n${result.reportText}`;

    expect(output).not.toContain(agentToken);
    expect(output).not.toContain(adminToken);
    expect(output).not.toContain(verifierToken);
    expect(output).not.toMatch(/Bearer\s+eyJ/);
  });
});
