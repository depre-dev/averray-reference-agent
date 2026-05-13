import { describe, expect, it } from "vitest";

import {
  getGithubOperatorBrief,
  getGithubOperatorStatus,
  getGithubPullRequestReview,
} from "../../packages/averray-mcp/src/operator-github.js";

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

  it("reviews a pull request and recommends merge when checks are green", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/185")) {
        return jsonResponse({
          number: 185,
          title: "Record testnet deployment manifest",
          html_url: "https://github.com/averray-agent/agent/pull/185",
          user: { login: "codex" },
          draft: false,
          state: "open",
          base: { ref: "main" },
          head: { ref: "codex/testnet", sha: "abc123" },
          additions: 24,
          deletions: 2,
          changed_files: 2,
          mergeable_state: "clean",
          updated_at: "2026-05-08T12:00:00.000Z",
        });
      }
      if (text.includes("/pulls/185/files")) {
        return jsonResponse([
          { filename: "docs/testnet.md", status: "modified", additions: 10, deletions: 0, changes: 10 },
          { filename: "scripts/verify-testnet.js", status: "modified", additions: 14, deletions: 2, changes: 16 },
        ]);
      }
      if (text.includes("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "CI", status: "completed", conclusion: "success", html_url: "https://github.com/checks/1" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      repo: "averray-agent/agent",
      pullRequestNumber: 185,
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      configured: true,
      authConfigured: true,
      health: "ok",
      pullRequest: {
        repo: "averray-agent/agent",
        number: 185,
        draft: false,
        headSha: "abc123",
      },
      checks: {
        total: 1,
        passed: 1,
        failed: 0,
        active: 0,
      },
      mergeRecommendation: "ok_to_merge",
    });
  });

  it("keeps frontend, docs, and tests PRs merge-ready when CI is green", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/187")) {
        return jsonResponse({
          number: 187,
          title: "Polish dashboard empty states",
          html_url: "https://github.com/averray-agent/agent/pull/187",
          user: { login: "codex" },
          draft: false,
          state: "open",
          base: { ref: "main" },
          head: { ref: "codex/ui-polish", sha: "ui123" },
          additions: 42,
          deletions: 8,
          changed_files: 3,
          mergeable_state: "clean",
        });
      }
      if (text.includes("/pulls/187/files")) {
        return jsonResponse([
          { filename: "app/(authed)/overview/page.tsx", status: "modified", additions: 24, deletions: 3, changes: 27 },
          { filename: "test/unit/overview-empty-state.test.ts", status: "modified", additions: 14, deletions: 5, changes: 19 },
          { filename: "docs/operator-dashboard.md", status: "modified", additions: 4, deletions: 0, changes: 4 },
        ]);
      }
      if (text.includes("/commits/ui123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "CI", status: "completed", conclusion: "success" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      repo: "averray-agent/agent",
      pullRequestNumber: 187,
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      health: "ok",
      files: {
        highRisk: [],
      },
      review: {
        touchedAreas: expect.arrayContaining(["frontend", "tests", "docs"]),
        testFilesChanged: true,
        missingTestSignals: [],
        rolloutNotesRequired: false,
      },
      mergeRecommendation: "ok_to_merge",
    });
    expect(review.riskFindings).toEqual([
      expect.objectContaining({ severity: "low", code: "pr_review_green" }),
    ]);
  });

  it("asks for human review on deploy and workflow-only risk", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/188")) {
        return jsonResponse({
          number: 188,
          title: "Tune production deploy workflow",
          html_url: "https://github.com/averray-agent/agent/pull/188",
          user: { login: "codex" },
          draft: false,
          state: "open",
          head: { ref: "codex/deploy-workflow", sha: "deploy123" },
          changed_files: 1,
          mergeable_state: "clean",
        });
      }
      if (text.includes("/pulls/188/files")) {
        return jsonResponse([
          { filename: ".github/workflows/deploy-production.yml", status: "modified", additions: 6, deletions: 2, changes: 8 },
        ]);
      }
      if (text.includes("/commits/deploy123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "CI", status: "completed", conclusion: "success" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      repo: "averray-agent/agent",
      pullRequestNumber: 188,
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      health: "attention",
      files: {
        highRisk: [
          expect.objectContaining({
            filename: ".github/workflows/deploy-production.yml",
            risk: "medium",
            category: "workflow",
          }),
        ],
      },
      review: {
        touchedAreas: expect.arrayContaining(["workflow", "config"]),
        missingTestSignals: [],
        rolloutNotesRequired: true,
        rolloutNotesPresent: false,
      },
      mergeRecommendation: "needs_review",
    });
    expect(review.riskFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "medium", code: "pr_review_risk_files" }),
      expect.objectContaining({ severity: "medium", code: "pr_rollout_notes_missing" }),
    ]));
  });

  it("flags backend changes that have no changed tests or matching check names", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/190")) {
        return jsonResponse({
          number: 190,
          title: "Adjust operator command parsing",
          html_url: "https://github.com/averray-agent/agent/pull/190",
          user: { login: "codex" },
          draft: false,
          state: "open",
          head: { ref: "codex/operator-parser", sha: "backend123" },
          changed_files: 1,
          mergeable_state: "clean",
        });
      }
      if (text.includes("/pulls/190/files")) {
        return jsonResponse([
          { filename: "packages/averray-mcp/src/operator-handler.ts", status: "modified", additions: 34, deletions: 12, changes: 46 },
        ]);
      }
      if (text.includes("/commits/backend123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "Docs", status: "completed", conclusion: "success" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      repo: "averray-agent/agent",
      pullRequestNumber: 190,
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      health: "attention",
      review: {
        touchedAreas: expect.arrayContaining(["backend"]),
        testFilesChanged: false,
        testSignals: [],
        missingTestSignals: ["backend"],
      },
      mergeRecommendation: "needs_review",
    });
    expect(review.riskFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "medium", code: "pr_test_signal_missing" }),
    ]));
  });

  it("holds PRs that touch secrets or contract surfaces even when CI is green", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/189")) {
        return jsonResponse({
          number: 189,
          title: "Update settlement contract",
          html_url: "https://github.com/averray-agent/agent/pull/189",
          user: { login: "codex" },
          draft: false,
          state: "open",
          head: { ref: "codex/settlement-contract", sha: "contract123" },
          changed_files: 1,
          mergeable_state: "clean",
        });
      }
      if (text.includes("/pulls/189/files")) {
        return jsonResponse([
          { filename: "contracts/Settlement.sol", status: "modified", additions: 12, deletions: 4, changes: 16 },
        ]);
      }
      if (text.includes("/commits/contract123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "CI", status: "completed", conclusion: "success" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      repo: "averray-agent/agent",
      pullRequestNumber: 189,
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      health: "attention",
      files: {
        highRisk: [
          expect.objectContaining({
            filename: "contracts/Settlement.sol",
            risk: "high",
            category: "contracts",
          }),
        ],
      },
      mergeRecommendation: "hold",
    });
    expect(review.riskFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "high", code: "pr_critical_files" }),
    ]));
  });

  it("holds a pull request with failing checks or active checks", async () => {
    const fetchFn = async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/repos/averray-agent/agent/pulls/186")) {
        return jsonResponse({
          number: 186,
          title: "Risky deploy change",
          html_url: "https://github.com/averray-agent/agent/pull/186",
          user: { login: "codex" },
          draft: false,
          state: "open",
          head: { ref: "codex/risky", sha: "def456" },
          changed_files: 1,
        });
      }
      if (text.includes("/pulls/186/files")) {
        return jsonResponse([
          { filename: "ops/compose.yml", status: "modified", additions: 3, deletions: 1, changes: 4 },
        ]);
      }
      if (text.includes("/commits/def456/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "CI", status: "completed", conclusion: "failure" },
            { name: "Deploy preview", status: "in_progress" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const review = await getGithubPullRequestReview({
      pullRequestUrl: "https://github.com/averray-agent/agent/pull/186",
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn,
      now: new Date("2026-05-08T12:30:00.000Z"),
    });

    expect(review).toMatchObject({
      configured: true,
      health: "attention",
      checks: {
        total: 2,
        failed: 1,
        active: 1,
      },
      files: {
        highRisk: [expect.objectContaining({ filename: "ops/compose.yml" })],
      },
      mergeRecommendation: "hold",
    });
    expect(review.riskFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "pr_checks_failed" }),
      expect.objectContaining({ code: "pr_checks_active" }),
    ]));
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
