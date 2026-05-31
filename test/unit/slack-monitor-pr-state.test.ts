import { describe, expect, it } from "vitest";

import { enrichMonitorWithGithubPrState } from "../../services/slack-operator/src/github-pr-state.js";
import { buildHermesBoardSnapshotFromMonitor } from "../../services/slack-operator/src/monitor-hermes-board.js";

describe("monitor GitHub PR state enrichment", () => {
  it("adds live GitHub PR state to matching monitor entries", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        {
          correlationId: "github-pr-123-abc-456",
          repo: "averray-agent/agent",
          pullRequestNumber: 123,
          summary: { finalVerdict: "needs_review" },
        },
      ],
    }, {
      env: { GITHUB_TOKEN: "ghp_readonly" },
      now: new Date("2026-05-16T10:00:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        return new Response(JSON.stringify({
          number: 123,
          title: "Ship monitor state",
          html_url: "https://github.com/averray-agent/agent/pull/123",
          user: { login: "codex" },
          state: "closed",
          merged: true,
          draft: false,
          mergeable_state: "clean",
          head: { sha: "abc123" },
          updated_at: "2026-05-16T09:55:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["https://api.github.com/repos/averray-agent/agent/pulls/123"]);
    expect(monitor.recent?.[0]).toMatchObject({
      summary: {
        finalVerdict: "needs_review",
        currentPullRequest: {
          repo: "averray-agent/agent",
          number: 123,
          state: "closed",
          merged: true,
          draft: false,
          mergeableState: "clean",
          headSha: "abc123",
          checkedAt: "2026-05-16T10:00:00.000Z",
          source: "github_live",
        },
      },
    });
  });

  it("uses owner-specific tokens and leaves entries unchanged without a token", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        { repo: "depre-dev/averray-reference-agent", pullRequestNumber: 88, summary: {} },
        { repo: "unknown-owner/repo", pullRequestNumber: 99, summary: {} },
      ],
    }, {
      env: { GITHUB_OWNER_TOKENS: "depre-dev=owner-token" },
      now: new Date("2026-05-16T10:05:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer owner-token" });
        return new Response(JSON.stringify({
          number: 88,
          state: "open",
          draft: false,
          merged: false,
        }), { status: 200 });
      },
    });

    expect(calls).toEqual(["https://api.github.com/repos/depre-dev/averray-reference-agent/pulls/88"]);
    expect(monitor.recent?.[0]).toMatchObject({
      summary: {
        currentPullRequest: {
          repo: "depre-dev/averray-reference-agent",
          number: 88,
          state: "open",
        },
      },
    });
    expect(monitor.recent?.[1]).toEqual({ repo: "unknown-owner/repo", pullRequestNumber: 99, summary: {} });
  });

  it("adds live open GitHub PRs even when no Hermes handoff event exists", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({ recent: [] }, {
      env: {
        GITHUB_DEFAULT_REPO: "averray-agent/agent",
        GITHUB_TOKEN: "ghp_readonly",
      },
      now: new Date("2026-05-17T10:00:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        const href = String(url);
        if (href.endsWith("/pulls?state=open&sort=updated&direction=desc&per_page=20")) {
          return new Response(JSON.stringify([
            {
              number: 395,
              title: "Surface observability env vars",
              html_url: "https://github.com/averray-agent/agent/pull/395",
              user: { login: "depre-dev" },
              state: "open",
              draft: false,
              created_at: "2026-05-17T09:50:00.000Z",
              updated_at: "2026-05-17T09:58:00.000Z",
              head: { sha: "abc123", ref: "codex/live-pr" },
              base: { ref: "main" },
            },
          ]), { status: 200 });
        }
        if (href.endsWith("/pulls/395/files?per_page=100")) {
          return new Response(JSON.stringify([
            { filename: "services/slack-operator/src/monitor.ts" },
            { filename: "test/unit/slack-monitor.test.ts" },
          ]), { status: 200 });
        }
        if (href.endsWith("/commits/abc123/check-runs?per_page=100")) {
          return new Response(JSON.stringify({
            check_runs: [
              { name: "Backend - node --test", status: "completed", conclusion: "success" },
              { name: "Indexer - typecheck", status: "completed", conclusion: "failure" },
            ],
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(calls.sort()).toEqual([
      "https://api.github.com/repos/averray-agent/agent/commits/abc123/check-runs?per_page=100",
      "https://api.github.com/repos/averray-agent/agent/pulls/395/files?per_page=100",
      "https://api.github.com/repos/averray-agent/agent/pulls?state=open&sort=updated&direction=desc&per_page=20",
    ].sort());
    expect(monitor.recent?.[0]).toMatchObject({
      correlationId: "github-live-pr-averray-agent-agent-395",
      requester: "github-live",
      intent: "github_open_pr",
      repo: "averray-agent/agent",
      pullRequestNumber: 395,
      reason: "pr_checks_failed",
      summary: {
        source: "github_live",
        finalVerdict: "hold",
        mergeRecommendation: "hold",
        currentPullRequest: {
          repo: "averray-agent/agent",
          number: 395,
          state: "open",
          draft: false,
          headSha: "abc123",
          baseBranch: "main",
          headBranch: "codex/live-pr",
        },
        checks: [
          { name: "Backend - node --test", status: "completed", conclusion: "success" },
          { name: "Indexer - typecheck", status: "completed", conclusion: "failure" },
        ],
      },
    });
    expect((monitor.recent?.[0] as any).summary.reviewReasons).toEqual(expect.arrayContaining([
      { severity: "high", code: "pr_checks_failed", message: "1 PR check(s) failed." },
    ]));
  });

  it("treats a young head commit with queued Actions as pending, not missing", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithGithubPrState({ recent: [] }, {
      env: {
        GITHUB_DEFAULT_REPO: "depre-dev/queued-actions",
        GITHUB_TOKEN: "ghp_readonly",
        GITHUB_MONITOR_PR_CHECKS_GRACE_MINUTES: "10",
      },
      now: new Date("2026-05-17T10:06:00.000Z"),
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        const href = String(url);
        if (href.endsWith("/pulls?state=open&sort=updated&direction=desc&per_page=20")) {
          return new Response(JSON.stringify([
            {
              number: 12,
              title: "Fresh PR waiting for Actions",
              html_url: "https://github.com/depre-dev/queued-actions/pull/12",
              user: { login: "codex" },
              state: "open",
              draft: false,
              created_at: "2026-05-17T10:00:00.000Z",
              updated_at: "2026-05-17T10:00:00.000Z",
              head: { sha: "queued123", ref: "codex/fresh-pr" },
              base: { ref: "main" },
            },
          ]), { status: 200 });
        }
        if (href.endsWith("/pulls/12/files?per_page=100")) {
          return new Response(JSON.stringify([
            { filename: "docs/fresh-pr.md" },
          ]), { status: 200 });
        }
        if (href.endsWith("/commits/queued123/check-runs?per_page=100")) {
          return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        }
        if (href.endsWith("/actions/runs?head_sha=queued123&per_page=100")) {
          return new Response(JSON.stringify({
            workflow_runs: [
              { name: "CI", status: "queued", head_sha: "queued123", html_url: "https://github.com/runs/1" },
            ],
          }), { status: 200 });
        }
        if (href.endsWith("/commits/queued123")) {
          return new Response(JSON.stringify({
            commit: { committer: { date: "2026-05-17T10:00:00.000Z" } },
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(calls).toEqual(expect.arrayContaining([
      "https://api.github.com/repos/depre-dev/queued-actions/commits/queued123/check-runs?per_page=100",
      "https://api.github.com/repos/depre-dev/queued-actions/actions/runs?head_sha=queued123&per_page=100",
      "https://api.github.com/repos/depre-dev/queued-actions/commits/queued123",
    ]));
    expect(monitor.recent?.[0]).toMatchObject({
      reason: "pr_checks_pending",
      status: "running",
      summary: {
        finalVerdict: "pending",
        mergeRecommendation: "pending",
        githubLive: {
          checksPending: true,
          pendingReason: "workflow_run_active",
          checkTotals: { total: 1, pending: 1, passed: 0, failed: 0, active: 0 },
        },
      },
    });
    expect((monitor.recent?.[0] as any).summary.reviewReasons).toEqual(expect.arrayContaining([
      { severity: "low", code: "pr_checks_pending", message: "PR checks have not reported yet; waiting for GitHub Actions to start or finish." },
    ]));
    expect((monitor.recent?.[0] as any).summary.reviewReasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "pr_checks_missing" }),
    ]));
    const board = buildHermesBoardSnapshotFromMonitor(monitor);
    expect(board?.items?.[0]).toMatchObject({
      lane: "Hermes Checking",
      owner: "Hermes",
      verdict: "checks pending",
    });
  });

  it("emits checks-missing only after the grace window when no check or workflow exists", async () => {
    const monitor = await enrichMonitorWithGithubPrState({ recent: [] }, {
      env: {
        GITHUB_DEFAULT_REPO: "depre-dev/no-actions",
        GITHUB_TOKEN: "ghp_readonly",
        GITHUB_MONITOR_PR_CHECKS_GRACE_MINUTES: "10",
      },
      now: new Date("2026-05-17T10:15:01.000Z"),
      fetchFn: async (url, init) => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        const href = String(url);
        if (href.endsWith("/pulls?state=open&sort=updated&direction=desc&per_page=20")) {
          return new Response(JSON.stringify([
            {
              number: 13,
              title: "PR with missing workflow",
              html_url: "https://github.com/depre-dev/no-actions/pull/13",
              user: { login: "codex" },
              state: "open",
              draft: false,
              created_at: "2026-05-17T10:00:00.000Z",
              updated_at: "2026-05-17T10:00:00.000Z",
              head: { sha: "missing123", ref: "codex/missing-ci" },
              base: { ref: "main" },
            },
          ]), { status: 200 });
        }
        if (href.endsWith("/pulls/13/files?per_page=100")) {
          return new Response(JSON.stringify([
            { filename: "docs/ci.md" },
          ]), { status: 200 });
        }
        if (href.endsWith("/commits/missing123/check-runs?per_page=100")) {
          return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        }
        if (href.endsWith("/actions/runs?head_sha=missing123&per_page=100")) {
          return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
        }
        if (href.endsWith("/commits/missing123")) {
          return new Response(JSON.stringify({
            commit: { committer: { date: "2026-05-17T10:00:00.000Z" } },
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(monitor.recent?.[0]).toMatchObject({
      reason: "pr_checks_missing",
      summary: {
        finalVerdict: "needs_review",
        githubLive: {
          checksPending: false,
          checkTotals: { total: 0, pending: 0 },
        },
      },
    });
    expect((monitor.recent?.[0] as any).summary.reviewReasons).toEqual(expect.arrayContaining([
      { severity: "medium", code: "pr_checks_missing", message: "No PR check runs were found for the head commit." },
    ]));
    const board = buildHermesBoardSnapshotFromMonitor(monitor);
    expect(board?.items?.[0]).toMatchObject({
      lane: "Operator Review",
      owner: "Operator",
      verdict: "needs review",
    });
  });
});
