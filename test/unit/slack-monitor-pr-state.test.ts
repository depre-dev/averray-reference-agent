import { describe, expect, it } from "vitest";

import { enrichMonitorWithGithubPrState, enrichMonitorWithDeployCheckRuns, deployTargetFromEntry } from "../../services/slack-operator/src/github-pr-state.js";
import { buildHermesBoardSnapshotFromMonitor } from "../../services/slack-operator/src/monitor-hermes-board.js";
import { buildV2BoardSnapshot } from "../../services/slack-operator/src/monitor-v2.js";
import { isDecision } from "../../packages/monitor-ui/src/lib/monitor/lane-rules.js";

/** A 403 that GitHub only marks as a rate-limit via X-RateLimit-Remaining: 0. */
function rateLimitResponse(resetEpochSeconds?: number): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      ...(resetEpochSeconds ? { "x-ratelimit-reset": String(resetEpochSeconds) } : {}),
    },
  });
}

/** A unique token per test isolates the module-global rate-limit breaker (keyed by token prefix). */
let tokenSeq = 0;
function freshToken(): string {
  tokenSeq += 1;
  return `ghp_test_${tokenSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

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

describe("monitor deploy check-run enrichment", () => {
  it("extracts {repo, sha} from a post-deploy verification entry's correlationId", () => {
    expect(deployTargetFromEntry({ correlationId: "github-deploy-456-abc1234", repo: "averray-agent/agent" }))
      .toEqual({ repo: "averray-agent/agent", sha: "abc1234" });
    // Not a deploy handoff → ignored (PR entries are handled by the PR enrich).
    expect(deployTargetFromEntry({ correlationId: "github-pr-123-abc-456", repo: "averray-agent/agent" })).toBeUndefined();
    // No resolvable SHA → ignored.
    expect(deployTargetFromEntry({ correlationId: "github-deploy-456", repo: "averray-agent/agent" })).toBeUndefined();
  });

  it("attaches the deployed SHA's check-runs as summary.checks (so the stepper lights up)", async () => {
    const calls: string[] = [];
    const monitor = await enrichMonitorWithDeployCheckRuns({
      recent: [
        { correlationId: "github-deploy-456-abc1234", repo: "averray-agent/agent", summary: { phase: "deploy" } },
      ],
    }, {
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_readonly" });
        return new Response(JSON.stringify({
          check_runs: [
            { name: "deploy production", status: "completed", conclusion: "success" },
            { name: "unit tests", status: "in_progress", conclusion: null },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(calls).toEqual(["https://api.github.com/repos/averray-agent/agent/commits/abc1234/check-runs?per_page=100"]);
    expect((monitor.recent?.[0] as any).summary.checks).toEqual([
      { name: "deploy production", status: "completed", conclusion: "success" },
      { name: "unit tests", status: "in_progress" }, // null conclusion dropped
    ]);
  });

  it("leaves the entry unchanged when the deploy SHA has no check-runs (honest 'awaiting')", async () => {
    const monitor = await enrichMonitorWithDeployCheckRuns({
      recent: [
        { correlationId: "github-deploy-456-abc1234", repo: "averray-agent/agent", summary: { phase: "deploy" } },
      ],
    }, {
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn: async () => new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect((monitor.recent?.[0] as any).summary.checks).toBeUndefined();
  });

  it("never fetches for non-deploy entries", async () => {
    const calls: string[] = [];
    await enrichMonitorWithDeployCheckRuns({
      recent: [
        { correlationId: "github-pr-123-abc-456", repo: "averray-agent/agent", pullRequestNumber: 123, summary: {} },
      ],
    }, {
      env: { GITHUB_TOKEN: "ghp_readonly" },
      fetchFn: async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); },
    });
    expect(calls).toEqual([]);
  });
});

describe("monitor GitHub PR state — fail-stale on unrefreshable fetch (truth-boundary)", () => {
  it("marks a frozen PR card stale (githubLive.fetchError) when its refresh is rate-limited", async () => {
    const token = freshToken();
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        {
          // A card frozen in its last-seen (pre-merge) lane. On the live board
          // this is a MERGED PR still showing as "waiting on operator".
          correlationId: "github-pr-711-abc",
          repo: "averray-agent/agent",
          pullRequestNumber: 711,
          summary: { finalVerdict: "needs_review" },
        },
      ],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: async () => rateLimitResponse(),
    });

    const summary = (monitor.recent?.[0] as any).summary;
    // The frozen pre-merge fields are NOT overwritten, but the card now carries a
    // fetch-error marker so monitor-v2 demotes it to a degraded/stale state.
    expect(summary.finalVerdict).toBe("needs_review");
    expect(summary.currentPullRequest).toBeUndefined();
    expect(summary.githubLive.fetchError).toMatchObject({
      code: "403",
      checkedAt: "2026-07-01T10:00:00.000Z",
    });
    expect(String(summary.githubLive.fetchError.message)).toMatch(/rate limit/i);
  });

  it("a rate-limited frozen decision drops OUT of the live Decision Inbox but stays visible (degraded)", async () => {
    const token = freshToken();
    // A frozen card the classifier had promoted to the operator decision lane.
    const monitor = await enrichMonitorWithGithubPrState({
      active: [
        {
          correlationId: "github-pr-708-def",
          repo: "averray-agent/agent",
          pullRequestNumber: 708,
          owner: "Operator",
          lane: "Operator Review",
          title: "agent #708",
          status: "blocked",
          summary: {
            finalVerdict: "needs_review",
            pullRequest: { repo: "averray-agent/agent", number: 708, state: "open" },
          },
        },
      ],
      recent: [],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: async () => rateLimitResponse(),
    });

    const snap = buildV2BoardSnapshot(monitor, { now: () => new Date("2026-07-01T10:00:05.000Z") });
    const card = snap.cards.find((c) => c.repo === "averray-agent/agent");
    expect(card).toBeDefined();
    // Truth-boundary: unverifiable → degraded, and NOT a live operator decision.
    expect(card!.state).toBe("failed-fetch");
    expect(card!.sourceFailure?.source).toBe("github");
    expect(isDecision(card!)).toBe(false);
    // But it is NOT hidden — it still renders as a card on the board.
    expect(snap.cards.some((c) => c.id === card!.id)).toBe(true);
  });

  it("a genuinely-open PR that refreshes successfully stays a live decision (not demoted)", async () => {
    const token = freshToken();
    const monitor = await enrichMonitorWithGithubPrState({
      active: [
        {
          correlationId: "github-pr-712-open",
          repo: "averray-agent/agent",
          pullRequestNumber: 712,
          owner: "Operator",
          lane: "Operator Review",
          title: "agent #712",
          status: "blocked",
          summary: {
            finalVerdict: "needs_review",
            pullRequest: { repo: "averray-agent/agent", number: 712, state: "open" },
          },
        },
      ],
      recent: [],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: async () => new Response(JSON.stringify({
        number: 712,
        state: "open",
        draft: false,
        merged: false,
        mergeable_state: "dirty",
        head: { sha: "open712", ref: "codex/open" },
        base: { ref: "main" },
        updated_at: "2026-07-01T09:59:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const summary = (monitor.active?.[0] as any).summary;
    expect(summary.githubLive?.fetchError).toBeUndefined();
    expect(summary.currentPullRequest).toMatchObject({ number: 712, state: "open", merged: false });

    const snap = buildV2BoardSnapshot(monitor, { now: () => new Date("2026-07-01T10:00:05.000Z") });
    const card = snap.cards.find((c) => c.repo === "averray-agent/agent");
    expect(card).toBeDefined();
    expect(card!.state).not.toBe("failed-fetch");
    // A verifiable operator-owned card is still a live decision.
    expect(isDecision(card!)).toBe(true);
  });

  it("a definitive 404 (deleted PR) is NOT treated as stale — the card is left un-enriched, not degraded", async () => {
    const token = freshToken();
    const monitor = await enrichMonitorWithGithubPrState({
      recent: [
        {
          correlationId: "github-pr-999-gone",
          repo: "averray-agent/agent",
          pullRequestNumber: 999,
          summary: { finalVerdict: "needs_review" },
        },
      ],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: async () => new Response("Not Found", { status: 404 }),
    });

    const summary = (monitor.recent?.[0] as any).summary;
    // 404 is a definitive answer (gone), not an unverifiable refresh failure.
    expect(summary.githubLive?.fetchError).toBeUndefined();
    expect(summary.currentPullRequest).toBeUndefined();
    expect(summary.finalVerdict).toBe("needs_review");
  });
});

describe("monitor GitHub PR state — rate-limit resilience (root-cause mitigation)", () => {
  it("opens a circuit breaker after a rate-limit answer: later reads for the same token skip the network", async () => {
    const token = freshToken();
    let networkCalls = 0;
    const fetchFn = async (url: string | URL | Request) => {
      networkCalls += 1;
      void url;
      return rateLimitResponse();
    };

    const base = {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: fetchFn as unknown as typeof fetch,
    };
    // First refresh trips the breaker (one real network call).
    await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "github-pr-1-a", repo: "averray-agent/agent", pullRequestNumber: 1, summary: {} }],
    }, base);
    expect(networkCalls).toBe(1);

    // A second refresh, still inside the cool-off window, must NOT hit GitHub
    // again — it short-circuits and still yields a stale marker.
    const second = await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "github-pr-1-a", repo: "averray-agent/agent", pullRequestNumber: 1, summary: {} }],
    }, { ...base, now: new Date("2026-07-01T10:00:10.000Z") });
    expect(networkCalls).toBe(1); // unchanged — breaker suppressed the call
    expect((second.recent?.[0] as any).summary.githubLive.fetchError.code).toBe("403");
  });

  it("sends If-None-Match and serves the cached body on 304 (conditional request saves rate-limit budget)", async () => {
    const token = freshToken();
    const repo = "averray-agent/etag-demo";
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    let served = 0;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push(init?.headers as Record<string, string> | undefined);
      served += 1;
      if (served === 1) {
        return new Response(JSON.stringify({ number: 5, state: "open", draft: false, merged: false }), {
          status: 200,
          headers: { "content-type": "application/json", etag: 'W/"etag-abc"' },
        });
      }
      // Second read: caller sent If-None-Match, GitHub answers 304 (free).
      expect((init?.headers as Record<string, string>)["if-none-match"]).toBe('W/"etag-abc"');
      return new Response(null, { status: 304 });
    };

    const first = await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "e-1", repo, pullRequestNumber: 5, summary: {} }],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect((first.recent?.[0] as any).summary.currentPullRequest).toMatchObject({ number: 5, state: "open" });

    // Advance beyond the 60s per-PR value cache so the fetch layer is exercised
    // again; the ETag cache should turn it into a 304.
    const second = await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "e-1", repo, pullRequestNumber: 5, summary: {} }],
    }, {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:05:00.000Z"),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(served).toBe(2);
    // The 304 was resolved from the ETag cache into real state (still merged:false).
    expect((second.recent?.[0] as any).summary.currentPullRequest).toMatchObject({ number: 5, state: "open" });
    expect((second.recent?.[0] as any).summary.githubLive?.fetchError).toBeUndefined();
  });

  it("a permission 403 (no rate-limit signal) does NOT open the breaker (retrying later won't help)", async () => {
    const token = freshToken();
    let networkCalls = 0;
    const fetchFn = async () => {
      networkCalls += 1;
      // 403 with no X-RateLimit-Remaining:0 / Retry-After → a scope/permission
      // problem, NOT a rate limit. Must not trip the cool-off.
      return new Response("Forbidden", { status: 403 });
    };
    const base = {
      env: { GITHUB_TOKEN: token },
      now: new Date("2026-07-01T10:00:00.000Z"),
      fetchFn: fetchFn as unknown as typeof fetch,
    };
    await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "p-1", repo: "averray-agent/perm", pullRequestNumber: 2, summary: {} }],
    }, base);
    await enrichMonitorWithGithubPrState({
      recent: [{ correlationId: "p-1", repo: "averray-agent/perm", pullRequestNumber: 2, summary: {} }],
    }, { ...base, now: new Date("2026-07-01T10:00:10.000Z") });
    // Both refreshes hit the network — the breaker stayed closed.
    expect(networkCalls).toBe(2);
  });
});
