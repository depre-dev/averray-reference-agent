import { describe, expect, it } from "vitest";

import { invokeAgentTask } from "../../packages/averray-mcp/src/agent-invocation.js";
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
});

function deps(calls: string[]) {
  return {
    async query(text: string) {
      if (text.includes("from budgets")) return [{ usd_spent: "0" }];
      if (text.includes("from submissions")) return [];
      if (text.includes("from draft_submissions")) return [];
      return [];
    },
    workflowDeps: workflowDeps(calls),
  };
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
