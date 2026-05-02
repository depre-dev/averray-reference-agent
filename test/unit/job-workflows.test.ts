import { describe, expect, it } from "vitest";

import {
  readPageTitle,
  readRevisionId,
  runWikipediaCitationRepairWorkflow,
  type WorkflowDeps,
} from "../../packages/averray-mcp/src/job-workflows.js";

const jobId = "wiki-en-45188030-citation-repair-album";
const sessionId = `${jobId}:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05`;

const definition = {
  source: {
    type: "wikipedia_article",
    taskType: "citation_repair",
    pageTitle: "Album",
    revisionId: "123456789",
  },
  verifierMode: "schema",
  claimStatus: { claimable: true },
};

const evidence = {
  pageTitle: "Album",
  revisionId: "123456789",
  revisionUrl: "https://en.wikipedia.org/w/index.php?title=Album&oldid=123456789",
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

describe("runWikipediaCitationRepairWorkflow", () => {
  it("blocks when no claimable jobs are available", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow({}, deps({ calls, jobs: [] }));

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("no_claimable_wikipedia_citation_repair_jobs");
    expect(calls).not.toContain("claim");
    expect(calls).not.toContain("submit");
  });

  it("blocks wallet mismatch before selecting or mutating", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow(
      { expectedWallet: "0xDifferent", dryRun: false },
      deps({ calls })
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("wallet_mismatch");
    expect(calls).toEqual(["walletStatus"]);
  });

  it("blocks policy rejection before claim", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false },
      deps({ calls, policyAllowed: false })
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("policy_rejected_claim");
    expect(calls).not.toContain("claim");
  });

  it("claims, saves, validates, and submits on the happy path", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-1" },
      deps({ calls, records })
    );

    expect(result).toMatchObject({
      status: "submitted",
      runId: "run-1",
      jobId,
      sessionId,
      draftId: "draft-1",
      confidence: 0.72,
    });
    expect(calls).toEqual([
      "walletStatus",
      "getDefinition",
      "policyCheckClaim",
      "fetchEvidence",
      "claim",
      "saveDraft",
      "validate",
      "submit",
    ]);
    expect(records.claim[0]).toMatchObject({ runId: "run-1", jobId });
    expect(records.saveDraft[0]).toMatchObject({ runId: "run-1", jobId, sessionId });
    expect(records.validate[0]).toMatchObject({ runId: "run-1", jobId, sessionId, draftId: "draft-1" });
    expect(records.submit[0]).toMatchObject({ runId: "run-1", jobId, sessionId, draftId: "draft-1" });
  });

  it("generates a runId before mutations and carries it through submit", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false },
      deps({ calls, records, generatedRunId: "generated-run-1" })
    );

    expect(result.status).toBe("submitted");
    expect(result.runId).toBe("generated-run-1");
    expect(records.policyCheckClaim[0]).toMatchObject({ runId: "generated-run-1", jobId });
    expect(records.claim[0]).toMatchObject({ runId: "generated-run-1", jobId });
    expect(records.saveDraft[0]).toMatchObject({ runId: "generated-run-1", jobId, sessionId });
    expect(records.validate[0]).toMatchObject({ runId: "generated-run-1", jobId, sessionId, draftId: "draft-1" });
    expect(records.submit[0]).toMatchObject({ runId: "generated-run-1", jobId, sessionId, draftId: "draft-1" });
  });

  it("fails closed before submit when an explicit runId is blank", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "   " },
      deps({ calls, records })
    );

    expect(result).toMatchObject({
      status: "blocked",
      reason: "invalid_run_id",
      runId: null,
    });
    expect(calls).toEqual([]);
    expect(records.submit).toHaveLength(0);
  });

  it("re-saves and re-validates after a schema-only validation failure", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false },
      deps({ calls, validationSequence: [false, true] })
    );

    expect(result.status).toBe("submitted");
    expect(result.draftId).toBe("draft-2");
    expect(calls.filter((call) => call === "saveDraft")).toHaveLength(2);
    expect(calls.filter((call) => call === "validate")).toHaveLength(2);
  });

  it("reports submit blocked without pretending success", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false },
      deps({ calls, submitBlocked: true })
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("max_submit_attempts_exceeded");
    expect(calls).toContain("submit");
  });

  it("dry run validates evidence and never mutates", async () => {
    const calls: string[] = [];
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: true },
      deps({ calls })
    );

    expect(result.status).toBe("needs_review");
    expect(result.dryRun).toBe(true);
    expect(result.proposalPreview).toBeDefined();
    expect(calls).toEqual([
      "walletStatus",
      "getDefinition",
      "policyCheckClaim",
      "fetchEvidence",
      "validate",
    ]);
  });

  it("reads page title and pinned revision id from Wikipedia URLs", () => {
    const urlDefinition = {
      source: {
        type: "wikipedia_article",
        taskType: "citation_repair",
        articleUrl: "https://en.wikipedia.org/wiki/Album",
        pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Album&oldid=987654321",
      },
    };

    expect(readPageTitle(urlDefinition)).toBe("Album");
    expect(readRevisionId(urlDefinition)).toBe("987654321");
  });
});

function deps(options: {
  calls: string[];
  records?: WorkflowCallRecords;
  generatedRunId?: string;
  jobs?: Array<{ jobId: string; definition?: unknown }>;
  policyAllowed?: boolean;
  validationSequence?: boolean[];
  submitBlocked?: boolean;
}): WorkflowDeps {
  let draftCounter = 0;
  const validationSequence = [...(options.validationSequence ?? [true])];
  const workflowDeps: WorkflowDeps = {
    async listJobs() {
      options.calls.push("listJobs");
      return options.jobs ?? [{ jobId, definition }];
    },
    async getDefinition() {
      options.calls.push("getDefinition");
      return definition;
    },
    async walletStatus() {
      options.calls.push("walletStatus");
      return { configured: true, address: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05" };
    },
    async policyCheckClaim(input) {
      options.calls.push("policyCheckClaim");
      options.records?.policyCheckClaim.push(input);
      return options.policyAllowed === false
        ? { allowed: false, reason: "policy_rejected_claim" }
        : { allowed: true };
    },
    async claim(input) {
      options.calls.push("claim");
      options.records?.claim.push(input);
      return { sessionId, claimDeadline: "2026-05-02T13:36:37.224Z" };
    },
    async fetchEvidence() {
      options.calls.push("fetchEvidence");
      return evidence;
    },
    async saveDraft(input) {
      options.calls.push("saveDraft");
      options.records?.saveDraft.push(input);
      draftCounter += 1;
      return { draftId: `draft-${draftCounter}`, outputHash: `hash-${draftCounter}` };
    },
    async validate(input) {
      options.calls.push("validate");
      options.records?.validate.push(input);
      const valid = validationSequence.length > 1 ? validationSequence.shift()! : validationSequence[0] ?? true;
      return valid
        ? { valid: true, validator: "wikipedia", taskType: "citation_repair" }
        : {
            valid: false,
            validator: "wikipedia",
            taskType: "citation_repair",
            errors: [{ path: "citation_findings.0.extra", code: "unrecognized_keys", message: "extra" }],
          };
    },
    async submit(input) {
      options.calls.push("submit");
      options.records?.submit.push(input);
      return options.submitBlocked
        ? { blocked: true, reason: "max_submit_attempts_exceeded" }
        : { response: { status: "submitted" } };
    },
  };
  if (options.generatedRunId) {
    workflowDeps.generateRunId = () => options.generatedRunId!;
  }
  return workflowDeps;
}

interface WorkflowCallRecords {
  policyCheckClaim: Array<Parameters<WorkflowDeps["policyCheckClaim"]>[0]>;
  claim: Array<Parameters<WorkflowDeps["claim"]>[0]>;
  saveDraft: Array<Parameters<WorkflowDeps["saveDraft"]>[0]>;
  validate: Array<Parameters<WorkflowDeps["validate"]>[0]>;
  submit: Array<Parameters<WorkflowDeps["submit"]>[0]>;
}

function callRecords(): WorkflowCallRecords {
  return {
    policyCheckClaim: [],
    claim: [],
    saveDraft: [],
    validate: [],
    submit: [],
  };
}
