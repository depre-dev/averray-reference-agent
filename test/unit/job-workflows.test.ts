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
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-1" },
      deps({ calls })
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
  jobs?: Array<{ jobId: string; definition?: unknown }>;
  policyAllowed?: boolean;
  validationSequence?: boolean[];
  submitBlocked?: boolean;
}): WorkflowDeps {
  let draftCounter = 0;
  const validationSequence = [...(options.validationSequence ?? [true])];
  return {
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
    async policyCheckClaim() {
      options.calls.push("policyCheckClaim");
      return options.policyAllowed === false
        ? { allowed: false, reason: "policy_rejected_claim" }
        : { allowed: true };
    },
    async claim() {
      options.calls.push("claim");
      return { sessionId, claimDeadline: "2026-05-02T13:36:37.224Z" };
    },
    async fetchEvidence() {
      options.calls.push("fetchEvidence");
      return evidence;
    },
    async saveDraft() {
      options.calls.push("saveDraft");
      draftCounter += 1;
      return { draftId: `draft-${draftCounter}`, outputHash: `hash-${draftCounter}` };
    },
    async validate() {
      options.calls.push("validate");
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
    async submit() {
      options.calls.push("submit");
      return options.submitBlocked
        ? { blocked: true, reason: "max_submit_attempts_exceeded" }
        : { response: { status: "submitted" } };
    },
  };
}
