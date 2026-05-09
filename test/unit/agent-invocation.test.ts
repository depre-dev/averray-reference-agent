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
      "validate",
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
      "validate",
    ]));
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
      deps(calls, githubFetch())
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
      "validate",
    ]));
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
});

function deps(calls: string[], githubFetchFn?: typeof fetch, events?: HandoffEventInput[]) {
  return {
    githubEnv: { GITHUB_TOKEN: "ghp_readonly" },
    ...(githubFetchFn ? { githubFetchFn } : {}),
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
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
