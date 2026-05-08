import { describe, expect, it } from "vitest";

import { getGithubOperatorStatus } from "../../packages/averray-mcp/src/operator-github.js";

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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
