import { describe, expect, it } from "vitest";

import { getGithubOperatorBrief, getGithubOperatorStatus } from "../../packages/averray-mcp/src/operator-github.js";

describe("github operator status", () => {
  it("reports setup blockers when token or repo config is missing", async () => {
    const status = await getGithubOperatorStatus({
      env: {},
      now: new Date("2026-05-08T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      configured: false,
      authConfigured: false,
      health: "degraded",
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "github_token_missing" }),
        expect.objectContaining({ code: "github_repos_missing" }),
      ]),
    });
  });

  it("summarizes read-only repository, PR, issue, and CI state", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent")) {
        return jsonResponse({
          full_name: "averray-agent/agent",
          default_branch: "main",
          private: true,
          html_url: "https://github.com/averray-agent/agent",
        });
      }
      if (text.includes("/pulls?")) {
        return jsonResponse([
          {
            number: 182,
            title: "Add GitHub operator digest views",
            html_url: "https://github.com/averray-agent/agent/pull/182",
            user: { login: "codex" },
            draft: false,
            updated_at: "2026-05-08T10:00:00.000Z",
            state: "open",
          },
        ]);
      }
      if (text.includes("/issues?")) {
        return jsonResponse([
          {
            number: 10,
            title: "Operator should explain CI failures",
            html_url: "https://github.com/averray-agent/agent/issues/10",
            user: { login: "pkuriger" },
            updated_at: "2026-05-08T09:00:00.000Z",
            state: "open",
            labels: [{ name: "ops" }],
          },
          {
            number: 182,
            title: "PR should be filtered from issues",
            pull_request: {},
          },
        ]);
      }
      if (text.includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "CI",
              status: "completed",
              conclusion: "failure",
              head_branch: "main",
              event: "push",
              html_url: "https://github.com/averray-agent/agent/actions/runs/1",
              updated_at: "2026-05-08T11:00:00.000Z",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const status = await getGithubOperatorStatus({
      view: "digest",
      env: {
        GITHUB_TOKEN: "ghp_readonly",
        GITHUB_DEFAULT_REPO: "https://github.com/averray-agent/agent.git",
      },
      fetchFn,
      now: new Date("2026-05-08T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      configured: true,
      authConfigured: true,
      view: "digest",
      health: "attention",
      repoCount: 1,
      totals: {
        openPullRequests: 1,
        openIssues: 1,
        failingWorkflowRuns: 1,
        activeWorkflowRuns: 0,
      },
    });
    expect(status.views.prs[0]).toMatchObject({ repo: "averray-agent/agent", number: 182 });
    expect(status.views.issues[0]).toMatchObject({ repo: "averray-agent/agent", number: 10 });
    expect(status.views.digest.some((item) => item.title.includes("CI failure"))).toBe(true);
  });

  it("uses owner-specific tokens for repositories under different owners", async () => {
    const seenAuthByRepo = new Map<string, string | undefined>();
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      const auth = headersObject(init?.headers).authorization;
      if (text.endsWith("/repos/averray-agent/agent")) {
        seenAuthByRepo.set("averray-agent/agent", auth);
        return githubRepoResponse("averray-agent/agent");
      }
      if (text.endsWith("/repos/depre-dev/averray-reference-agent")) {
        seenAuthByRepo.set("depre-dev/averray-reference-agent", auth);
        return githubRepoResponse("depre-dev/averray-reference-agent");
      }
      if (text.includes("/pulls?") || text.includes("/issues?")) return jsonResponse([]);
      if (text.includes("/actions/runs?")) return jsonResponse({ workflow_runs: [] });
      return new Response("not found", { status: 404 });
    };

    const status = await getGithubOperatorStatus({
      env: {
        GITHUB_TOKEN: "token-averray-agent",
        GITHUB_OWNER_TOKENS: "depre-dev=token-depre-dev",
        GITHUB_HELPER_REPOS: "averray-agent/agent,depre-dev/averray-reference-agent",
      },
      fetchFn,
      now: new Date("2026-05-08T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      configured: true,
      authConfigured: true,
      health: "ok",
      repoCount: 2,
    });
    expect(seenAuthByRepo.get("averray-agent/agent")).toBe("Bearer token-averray-agent");
    expect(seenAuthByRepo.get("depre-dev/averray-reference-agent")).toBe("Bearer token-depre-dev");
  });

  it("builds a since-last-time brief and persists a local checkpoint", async () => {
    const writes: unknown[][] = [];
    const query = async <T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]> => {
      if (text.includes("select value from operator_state_snapshots")) {
        return [{ value: { generatedAt: "2026-05-08T10:00:00.000Z", repos: ["averray-agent/agent"] } } as T];
      }
      if (text.includes("insert into operator_state_snapshots")) {
        writes.push(values ?? []);
        return [];
      }
      return [];
    };
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent")) return githubRepoResponse("averray-agent/agent");
      if (text.includes("/pulls?state=open")) {
        return jsonResponse([
          {
            number: 185,
            title: "Record testnet deployment manifest",
            html_url: "https://github.com/averray-agent/agent/pull/185",
            user: { login: "depre-dev" },
            draft: false,
            updated_at: "2026-05-08T11:30:00.000Z",
            state: "open",
          },
        ]);
      }
      if (text.includes("/pulls?state=closed")) {
        return jsonResponse([
          {
            number: 184,
            title: "Reconcile testnet checklists",
            html_url: "https://github.com/averray-agent/agent/pull/184",
            user: { login: "codex" },
            draft: false,
            merged_at: "2026-05-08T11:00:00.000Z",
            updated_at: "2026-05-08T11:00:00.000Z",
            state: "closed",
          },
        ]);
      }
      if (text.includes("/issues?state=open")) return jsonResponse([]);
      if (text.includes("/issues?state=closed")) return jsonResponse([]);
      if (text.includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Deploy Production",
              status: "completed",
              conclusion: "success",
              head_branch: "main",
              event: "push",
              html_url: "https://github.com/averray-agent/agent/actions/runs/2",
              updated_at: "2026-05-08T11:15:00.000Z",
            },
            {
              id: 3,
              name: "CI",
              status: "completed",
              conclusion: "failure",
              head_branch: "feature",
              event: "pull_request",
              html_url: "https://github.com/averray-agent/agent/actions/runs/3",
              updated_at: "2026-05-08T11:20:00.000Z",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const brief = await getGithubOperatorBrief({
      env: {
        GITHUB_TOKEN: "ghp_readonly",
        GITHUB_DEFAULT_REPO: "averray-agent/agent",
      },
      fetchFn,
      query,
      now: new Date("2026-05-08T12:00:00.000Z"),
    });

    expect(brief).toMatchObject({
      configured: true,
      authConfigured: true,
      since: "2026-05-08T10:00:00.000Z",
      isFirstBrief: false,
      summary: {
        changed: 1,
        merged: 1,
        deployed: 1,
        failed: 1,
        attention: 2,
      },
      persistsLocalSnapshot: true,
    });
    expect(brief.sections.merged[0]).toMatchObject({ title: "PR #184: Reconcile testnet checklists" });
    expect(brief.sections.deployed[0]).toMatchObject({ title: "Deploy Production" });
    expect(brief.sections.failed[0]).toMatchObject({ title: "CI" });
    expect(writes).toHaveLength(1);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function githubRepoResponse(fullName: string): Response {
  return jsonResponse({
    full_name: fullName,
    default_branch: "main",
    private: true,
    html_url: `https://github.com/${fullName}`,
  });
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}
