import { describe, expect, it } from "vitest";

import { invokeAgentTask } from "../../packages/averray-mcp/src/agent-invocation.js";
import type { HandoffEventInput } from "../../packages/averray-mcp/src/handoff-events.js";
import type { WorkflowDeps } from "../../packages/averray-mcp/src/job-workflows.js";

const jobId = "wiki-en-58158792-citation-repair-r9";
const definition = {
  source: {
    type: "wikipedia_article",
    taskType: "citation_repair",
    pageTitle: "(+ +)",
    revisionId: "1351905437",
  },
  publicDetails: { title: "Wikipedia citation repair: (+ +)" },
  state: "open",
  claimStatus: { claimable: true },
};

describe("agent invocation hook", () => {
  it("records handoff monitor events around an invocation", async () => {
    const calls: string[] = [];
    const events: HandoffEventInput[] = [];
    const result = await invokeAgentTask(
      {
        requester: "github-actions",
        intent: "testbed_case",
        testCaseId: "TBE2E-004",
        correlationId: "github-pr-123",
        reason: "post-CI PR handoff",
      },
      deps(calls, undefined, events)
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      correlationId: "github-pr-123",
      requester: "github-actions",
      intent: "testbed_case",
      phase: "started",
      status: "running",
      testCaseId: "TBE2E-004",
      reason: "post-CI PR handoff",
    });
    expect(events[1]).toMatchObject({
      correlationId: "github-pr-123",
      phase: "completed",
      status: "completed",
      summary: {
        kind: "agent_invocation",
        status: "completed",
        summary: {
          totalCases: 1,
          executed: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
        },
      },
      safety: {
        wouldMutate: false,
        wouldWriteLocalCheckpoint: false,
      },
    });
  });

  it("runs one read-only testbed testcase with agent metadata", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      {
        requester: "codex",
        intent: "testbed_case",
        testCaseId: "tbe2e-004",
        correlationId: "deploy-123",
        reason: "post-deploy smoke",
      },
      deps(calls)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "codex",
        intent: "testbed_case",
        testCaseId: "TBE2E-004",
        correlationId: "deploy-123",
        reason: "post-deploy smoke",
      },
      safety: {
        source: "agent",
        wouldMutate: false,
        wouldWriteLocalCheckpoint: false,
        freeFormHermesPromptUsed: false,
      },
      result: {
        kind: "testbed_e2e_read_only_run",
        requestedCaseIds: ["TBE2E-004"],
        summary: {
          totalCases: 1,
          executed: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
        },
      },
    });
    expect(calls).toEqual(expect.arrayContaining([
      "walletStatus",
      "listJobs",
      "policyCheckClaim",
      "fetchEvidence",
      "validateDirectSubmission",
    ]));
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("saveDraft");
    expect(calls).not.toContain("submit");
  });

  it("accepts the post-deploy testbed_suite intent and skips mutation-bound cases", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      {
        requester: "github-actions",
        intent: "testbed_suite",
        testCaseIds: ["TBE2E-001", "TBE2E-004", "TBE2E-010"],
        correlationId: "github-deploy-123",
      },
      deps(calls)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "github-actions",
        intent: "testbed_suite",
        testCaseIds: ["TBE2E-001", "TBE2E-004", "TBE2E-010"],
        correlationId: "github-deploy-123",
      },
      result: {
        kind: "testbed_e2e_read_only_run",
        requestedCaseIds: ["TBE2E-001", "TBE2E-004", "TBE2E-010"],
        summary: {
          totalCases: 3,
          executed: 2,
          passed: 2,
          failed: 0,
          skipped: 1,
        },
      },
    });
    expect(calls).toEqual(expect.arrayContaining([
      "walletStatus",
      "listJobs",
      "policyCheckClaim",
      "fetchEvidence",
      "validateDirectSubmission",
    ]));
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("submit");
  });

  it("runs post-deploy verification with suite, hosted health, GitHub, and ops signals", async () => {
    const calls: string[] = [];
    const events: HandoffEventInput[] = [];
    const result = await invokeAgentTask(
      {
        requester: "github-actions",
        intent: "post_deploy_verification",
        repo: "averray-agent/agent",
        sha: "abc1234",
        testCaseIds: ["TBE2E-001", "TBE2E-008", "TBE2E-009"],
        healthUrls: ["https://app.averray.test/health"],
        correlationId: "github-deploy-123",
        reason: "post-production-deploy verification",
      },
      deps(calls, githubStatusFetch(), events, healthFetch({ ok: true }))
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "github-actions",
        intent: "post_deploy_verification",
        repo: "averray-agent/agent",
        sha: "abc1234",
        testCaseIds: ["TBE2E-001", "TBE2E-008", "TBE2E-009"],
      },
      result: {
        kind: "agent_post_deploy_verification",
        finalVerdict: "pass",
        finalReason: "post_deploy_healthy",
        deploymentHealth: {
          suite: { failed: 0 },
          hosted: {
            status: "ok",
            checks: [expect.objectContaining({ status: "ok", httpStatus: 200 })],
          },
          github: {
            health: "ok",
            totals: {
              failingWorkflowRuns: 0,
              activeWorkflowRuns: 0,
            },
          },
          ops: {
            recentErrors: 0,
          },
        },
      },
    });
    expect(events.at(-1)).toMatchObject({
      correlationId: "github-deploy-123",
      sha: "abc1234",
      phase: "completed",
      summary: {
        finalVerdict: "pass",
        finalReason: "post_deploy_healthy",
        deploymentHealth: {
          hostedStatus: "ok",
          githubFailingWorkflowRuns: 0,
          opsRecentErrors: 0,
        },
      },
    });
    expect(calls).toEqual(expect.arrayContaining(["walletStatus", "listJobs"]));
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("submit");
  });

  it("blocks the post-deploy verdict when hosted health fails", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      {
        requester: "github-actions",
        intent: "post_deploy_verification",
        repo: "averray-agent/agent",
        sha: "abc1234",
        testCaseIds: ["TBE2E-001"],
        healthUrls: ["https://app.averray.test/health"],
      },
      deps(calls, githubStatusFetch(), undefined, healthFetch({ ok: false }))
    );

    expect(result).toMatchObject({
      status: "completed",
      result: {
        kind: "agent_post_deploy_verification",
        finalVerdict: "block",
        finalReason: "hosted_health_failed",
        deploymentHealth: {
          hosted: {
            status: "failed",
            checks: [expect.objectContaining({ status: "failed", httpStatus: 503 })],
          },
        },
      },
      safety: {
        wouldMutate: false,
        wouldWriteLocalCheckpoint: false,
      },
    });
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("submit");
  });

  it("blocks mutation-bound testcase invocations unless explicitly allowed", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      { requester: "deploy-agent", intent: "testbed_case", testCaseId: "TBE2E-005" },
      deps(calls)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "blocked",
      reason: "mutation_case_requires_allow_mutations",
      mutates: false,
      safety: {
        freeFormHermesPromptUsed: false,
      },
    });
    expect(calls).toEqual([]);
  });

  it("routes explicit safe operator commands through the operator handler", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      { requester: "backend-agent", command: "operator status", correlationId: "ci-456" },
      deps(calls)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "backend-agent",
        intent: "operator_command",
        command: "operator status",
        correlationId: "ci-456",
      },
      result: {
        kind: "operator_status",
        source: "agent",
        status: {
          mutates: false,
          agent: { walletReady: true },
        },
      },
    });
    expect(calls).toEqual(["walletStatus", "listJobs"]);
  });

  it("blocks free-form live repair commands by default", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      { requester: "codex", command: "run one wikipedia citation repair if safe" },
      deps(calls)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "blocked",
      reason: "mutation_requires_allow_mutations",
      mutates: false,
      safety: {
        wouldMutate: true,
        freeFormHermesPromptUsed: false,
      },
    });
    expect(calls).toEqual([]);
  });

  it("runs a PR handoff review and requested read-only testcase", async () => {
    const calls: string[] = [];
    const events: HandoffEventInput[] = [];
    const result = await invokeAgentTask(
      {
        requester: "codex",
        intent: "pr_handoff",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        testCaseIds: ["TBE2E-004"],
        correlationId: "handoff-789",
        reason: "pre-merge check",
      },
      deps(calls, githubFetch(), events)
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "codex",
        intent: "pr_handoff",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        testCaseIds: ["TBE2E-004"],
        correlationId: "handoff-789",
      },
      safety: {
        source: "agent",
        wouldMutate: false,
        wouldWriteLocalCheckpoint: false,
        freeFormHermesPromptUsed: false,
      },
      result: {
        kind: "agent_pr_handoff",
        finalVerdict: "ok_to_merge",
        codeReview: {
          mode: "read_only_recommendation",
          verifierLane: {
            currentRuntime: "structured_github_review",
            plannedRuntime: "codex_app_server",
            codexRuntimeUsed: false,
          },
          finalVerdict: "ok_to_merge",
          mergeRecommendation: "ok_to_merge",
          riskCategory: "docs",
          highestRisk: "low",
          tests: {
            matchedTouchedAreas: true,
          },
          safety: {
            githubMutated: false,
            mergePerformed: false,
            deployTriggered: false,
            codexRuntimeUsed: false,
          },
        },
        github: {
          mergeRecommendation: "ok_to_merge",
          checks: { failed: 0, active: 0 },
        },
        tests: [
          expect.objectContaining({
            kind: "agent_invocation",
            status: "completed",
            result: expect.objectContaining({
              kind: "testbed_e2e_read_only_run",
              requestedCaseIds: ["TBE2E-004"],
            }),
          }),
        ],
        safety: {
          githubMutated: false,
          mergePerformed: false,
          mergeRecommendationOnly: true,
        },
      },
    });
    expect(calls).toEqual(expect.arrayContaining([
      "walletStatus",
      "listJobs",
      "policyCheckClaim",
      "fetchEvidence",
      "validateDirectSubmission",
    ]));
    expect(events.at(-1)?.summary).toMatchObject({
      pullRequest: {
        repo: "averray-agent/agent",
        number: 185,
        state: "open",
        draft: false,
        mergeableState: "clean",
      },
    });
  });

  it("posts an idempotent PR handoff comment when enabled", async () => {
    const calls: string[] = [];
    const commentRequests: Array<{ method?: string; body?: string }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      if (text.includes("/repos/averray-agent/agent/issues/185/comments")) {
        commentRequests.push({ method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
        if (init?.method === "POST") {
          return jsonResponse({ id: 10, html_url: "https://github.com/averray-agent/agent/pull/185#issuecomment-10" });
        }
        return jsonResponse([]);
      }
      return githubFetch()(url, init);
    }) as typeof fetch;

    const result = await invokeAgentTask(
      {
        requester: "github-actions",
        intent: "pr_handoff",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        testCaseIds: ["TBE2E-004"],
        correlationId: "handoff-comment-123",
      },
      deps(calls, fetchFn, undefined, undefined, {
        GITHUB_TOKEN: "ghp_comment",
        GITHUB_PR_HANDOFF_COMMENTS_ENABLED: "1",
      })
    );

    expect(result).toMatchObject({
      status: "completed",
      safety: {
        wouldMutate: true,
      },
      result: {
        kind: "agent_pr_handoff",
        safety: {
          githubMutated: true,
          mergePerformed: false,
        },
        prComment: {
          status: "posted",
          mutatesGithub: true,
          commentUrl: "https://github.com/averray-agent/agent/pull/185#issuecomment-10",
        },
      },
    });
    expect(commentRequests.map((request) => request.method)).toEqual(["GET", "POST"]);
    const postedBody = JSON.parse(commentRequests[1]?.body ?? "{}").body as string;
    expect(postedBody).toContain("<!-- averray-hermes-pr-handoff -->");
    expect(postedBody).toContain("**Verdict:** PASS");
    expect(postedBody).toContain("Correlation: `handoff-comment-123`");
    expect(postedBody).toContain("Hermes did not merge, deploy, rerun CI, or edit Wikipedia");
  });

  it("holds PR handoff and skips tests when GitHub checks are not merge-ready", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      {
        requester: "codex",
        intent: "pr_handoff",
        pullRequestUrl: "https://github.com/averray-agent/agent/pull/186",
        testCaseIds: ["TBE2E-004"],
      },
      deps(calls, githubFetch({ failing: true }))
    );

    expect(result).toMatchObject({
      status: "completed",
      result: {
        kind: "agent_pr_handoff",
        finalVerdict: "hold",
        finalReason: "pr_review_hold",
        github: {
          mergeRecommendation: "hold",
        },
        tests: [],
      },
    });
    expect(calls).toEqual([]);
  });

  it("runs a standalone read-only PR code review verifier", async () => {
    const calls: string[] = [];
    const result = await invokeAgentTask(
      {
        requester: "codex",
        intent: "pr_code_review",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        correlationId: "review-123",
      },
      deps(calls, githubFetch())
    );

    expect(result).toMatchObject({
      kind: "agent_invocation",
      status: "completed",
      invocation: {
        requester: "codex",
        intent: "pr_code_review",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        correlationId: "review-123",
      },
      result: {
        kind: "agent_pr_code_review",
        status: "completed",
        repo: "averray-agent/agent",
        pullRequestNumber: 185,
        finalVerdict: "ok_to_merge",
        finalReason: "github_ok_to_merge",
        mergeRecommendation: "ok_to_merge",
        codeReview: {
          mode: "read_only_recommendation",
          riskCategory: "docs",
          highestRisk: "low",
          changedFiles: 1,
          checks: {
            total: 1,
            failed: 0,
            active: 0,
          },
          tests: {
            matchedTouchedAreas: true,
            missingTestSignals: [],
          },
          verifierLane: {
            purpose: "independent_pr_verification",
            currentRuntime: "structured_github_review",
            plannedRuntime: "codex_app_server",
            codexRuntimeUsed: false,
          },
          safety: {
            readOnly: true,
            githubMutated: false,
            mergePerformed: false,
            deployTriggered: false,
            freeFormHermesPromptUsed: false,
            codexRuntimeUsed: false,
          },
        },
      },
    });
    expect(calls).toEqual([]);
  });
});

function deps(
  calls: string[],
  githubFetchFn?: typeof fetch,
  events?: HandoffEventInput[],
  healthFetchFn?: typeof fetch,
  githubEnv: NodeJS.ProcessEnv = { GITHUB_TOKEN: "ghp_readonly" }
) {
  return {
    githubEnv,
    ...(githubFetchFn ? { githubFetchFn } : {}),
    ...(healthFetchFn ? { healthFetchFn } : {}),
    handoffEventRecorder: async (event: HandoffEventInput) => { events?.push(event); },
    now: new Date("2026-05-09T12:00:00.000Z"),
    async query(text: string) {
      if (text.includes("from budgets")) return [{ usd_spent: "0" }];
      if (text.includes("from submissions")) return [];
      if (text.includes("from draft_submissions")) return [];
      return [];
    },
    workflowDeps: workflowDeps(calls),
  };
}

function githubFetch(options: { failing?: boolean } = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const text = String(url);
    const prNumber = options.failing ? 186 : 185;
    const sha = options.failing ? "def456" : "abc123";
    if (text.endsWith(`/repos/averray-agent/agent/pulls/${prNumber}`)) {
      return jsonResponse({
        number: prNumber,
        title: options.failing ? "Risky PR" : "Safe PR",
        html_url: `https://github.com/averray-agent/agent/pull/${prNumber}`,
        user: { login: "codex" },
        draft: false,
        state: "open",
        base: { ref: "main" },
        head: { ref: "codex/pr", sha },
        additions: 10,
        deletions: 1,
        changed_files: 1,
        mergeable_state: "clean",
        updated_at: "2026-05-09T11:00:00.000Z",
      });
    }
    if (text.includes(`/pulls/${prNumber}/files`)) {
      return jsonResponse([
        { filename: "docs/change.md", status: "modified", additions: 10, deletions: 1, changes: 11 },
      ]);
    }
    if (text.includes(`/commits/${sha}/check-runs`)) {
      return jsonResponse({
        check_runs: [
          options.failing
            ? { name: "CI", status: "completed", conclusion: "failure" }
            : { name: "CI", status: "completed", conclusion: "success" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function githubStatusFetch(options: { failing?: boolean; active?: boolean } = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.endsWith("/repos/averray-agent/agent")) {
      return jsonResponse({
        default_branch: "main",
        private: true,
        html_url: "https://github.com/averray-agent/agent",
      });
    }
    if (text.includes("/repos/averray-agent/agent/pulls?")) {
      return jsonResponse([]);
    }
    if (text.includes("/repos/averray-agent/agent/issues?")) {
      return jsonResponse([]);
    }
    if (text.includes("/repos/averray-agent/agent/actions/runs?")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 123,
            name: "Deploy Production",
            status: options.active ? "in_progress" : "completed",
            conclusion: options.failing ? "failure" : "success",
            head_branch: "main",
            event: "push",
            html_url: "https://github.com/averray-agent/agent/actions/runs/123",
            updated_at: "2026-05-09T11:30:00.000Z",
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function healthFetch(options: { ok: boolean }): typeof fetch {
  return (async () => jsonResponse(
    { status: options.ok ? "ok" : "unavailable" },
    options.ok ? 200 : 503
  )) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workflowDeps(calls: string[]): WorkflowDeps {
  return {
    async walletStatus() {
      calls.push("walletStatus");
      return { configured: true, address: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05" };
    },
    async listJobs() {
      calls.push("listJobs");
      return [{ jobId, definition }];
    },
    async getDefinition() {
      calls.push("getDefinition");
      return definition;
    },
    async policyCheckClaim() {
      calls.push("policyCheckClaim");
      return { allowed: true };
    },
    async claim() {
      calls.push("claim");
      throw new Error("agent invocation test must not claim");
    },
    async fetchEvidence() {
      calls.push("fetchEvidence");
      return {
        pageTitle: "(+ +)",
        revisionId: "1351905437",
        revisionUrl: "https://en.wikipedia.org/w/index.php?title=%28%2B_%2B%29&oldid=1351905437",
        citations: [
          {
            index: 1,
            referenceId: "review",
            templateNames: ["cite web"],
            urls: ["https://dead.example/review"],
            archiveUrls: ["https://web.archive.org/web/20200101000000/https://dead.example/review"],
            deadLinkMarkers: ["url_status_dead"],
            accessDates: ["2020-01-02"],
            title: "Review",
            context: "A review citation with a dead source.",
          },
        ],
        sourceChecks: [
          {
            url: "https://dead.example/review",
            status: 404,
            ok: false,
            finalUrl: "https://dead.example/review",
            archiveUrl: "https://web.archive.org/web/20200101000000/https://dead.example/review",
          },
        ],
      };
    },
    async saveDraft() {
      calls.push("saveDraft");
      throw new Error("agent invocation test must not save drafts");
    },
    async validateDirectSubmission() {
      calls.push("validateDirectSubmission");
      return { valid: true, validator: "permissive", taskType: "citation_repair" };
    },
    async probeInvalidWrapperSubmission() {
      calls.push("probeInvalidWrapperSubmission");
      return { valid: false, validator: "permissive" };
    },
    async validate() {
      calls.push("validate");
      return { valid: true, validator: "wikipedia", taskType: "citation_repair" };
    },
    async submit() {
      calls.push("submit");
      throw new Error("agent invocation test must not submit");
    },
  };
}
