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
      proposalSummary: {
        citationFindings: 1,
        proposedChanges: 1,
      },
    });
    expect(calls).toEqual([
      "walletStatus",
      "getDefinition",
      "policyCheckClaim",
      "fetchEvidence",
      "validateDirectSubmission",
      "probeInvalidWrapperSubmission",
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
      "validateDirectSubmission",
      "probeInvalidWrapperSubmission",
    ]);
  });

  // Schema-native readiness gate (pre-claim) — exercises the four
  // acceptance properties from the work item: valid → claim, invalid
  // → no claim, wrapper-probe-leak → no claim, and the first mutation
  // call after validation is always exactly the intended claim call.

  it("schema-native readiness: valid direct schema object leads to claim", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-readiness-valid" },
      deps({ calls, records, directValidationValid: true, wrapperProbeValid: false })
    );

    expect(result.status).toBe("submitted");
    expect(records.claim).toHaveLength(1);
    expect(records.claim[0]).toMatchObject({ runId: "run-readiness-valid", jobId });
    expect(result.readiness).toMatchObject({
      jobId,
      schemaValidates: "payload.submission",
      validatedBeforeClaim: true,
      invalidWrappedOutput: { checkedBeforeClaim: true },
      claimAttempted: true,
    });
    expect(result.readiness.invalidWrappedOutput.probeResult?.valid).toBe(false);
  });

  it("schema-native readiness: invalid direct object never calls claim", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-readiness-invalid" },
      deps({ calls, records, directValidationValid: false, wrapperProbeValid: false })
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("pre_claim_validation_failed");
    expect(records.claim).toHaveLength(0);
    expect(records.saveDraft).toHaveLength(0);
    expect(records.submit).toHaveLength(0);
    expect(calls).not.toContain("claim");
    expect(result.readiness).toMatchObject({
      jobId,
      validatedBeforeClaim: false,
      claimAttempted: false,
    });
  });

  it("schema-native readiness: wrapper probe passing unexpectedly never calls claim", async () => {
    const calls: string[] = [];
    const records = callRecords();
    const result = await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-readiness-wrapper-leak" },
      // direct submission validates clean, but the invalid-wrapper
      // probe is also accepted by the platform — that means schema
      // enforcement is off, so we must NOT trust the direct pass.
      deps({ calls, records, directValidationValid: true, wrapperProbeValid: true })
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("invalid_wrapper_probe_unexpectedly_valid");
    expect(records.claim).toHaveLength(0);
    expect(calls).not.toContain("claim");
    expect(result.readiness).toMatchObject({
      jobId,
      validatedBeforeClaim: true,
      claimAttempted: false,
    });
    expect(result.readiness.invalidWrappedOutput.probeResult?.valid).toBe(true);
  });

  it("schema-native readiness: first mutation call after validation is exactly the intended claim call", async () => {
    const calls: string[] = [];
    const records = callRecords();
    await runWikipediaCitationRepairWorkflow(
      { jobId, dryRun: false, runId: "run-readiness-order" },
      deps({ calls, records, directValidationValid: true, wrapperProbeValid: false })
    );

    // Find the first mutation call in the recorded sequence.
    // Mutations are: claim, saveDraft, submit. validateDirectSubmission
    // and probeInvalidWrapperSubmission are read-only by contract.
    const mutationIndex = calls.findIndex(
      (call) => call === "claim" || call === "saveDraft" || call === "submit"
    );
    expect(mutationIndex).toBeGreaterThanOrEqual(0);
    expect(calls[mutationIndex]).toBe("claim");

    // Both readiness gates must have run before the first mutation.
    const directIndex = calls.indexOf("validateDirectSubmission");
    const wrapperIndex = calls.indexOf("probeInvalidWrapperSubmission");
    expect(directIndex).toBeGreaterThanOrEqual(0);
    expect(wrapperIndex).toBeGreaterThanOrEqual(0);
    expect(directIndex).toBeLessThan(mutationIndex);
    expect(wrapperIndex).toBeLessThan(mutationIndex);

    // And the intended claim call carries the run id and job id the
    // workflow committed to before validation.
    expect(records.claim).toHaveLength(1);
    expect(records.claim[0]).toMatchObject({ runId: "run-readiness-order", jobId });
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
  directValidationValid?: boolean;
  wrapperProbeValid?: boolean;
}): WorkflowDeps {
  let draftCounter = 0;
  const validationSequence = [...(options.validationSequence ?? [true])];
  const directValid = options.directValidationValid ?? true;
  const wrapperProbeValid = options.wrapperProbeValid ?? false;
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
    async validateDirectSubmission(input) {
      options.calls.push("validateDirectSubmission");
      options.records?.validateDirectSubmission.push(input);
      return directValid
        ? { valid: true, validator: "permissive", taskType: "citation_repair" }
        : {
            valid: false,
            validator: "permissive",
            taskType: "citation_repair",
            message: "platform validation rejected the submission",
            errors: [{ path: "citation_findings.0.problem", code: "invalid_enum_value", message: "unknown problem" }],
          };
    },
    async probeInvalidWrapperSubmission(input) {
      options.calls.push("probeInvalidWrapperSubmission");
      options.records?.probeInvalidWrapperSubmission.push(input);
      return wrapperProbeValid
        ? { valid: true, validator: "permissive" }
        : {
            valid: false,
            validator: "permissive",
            message: "platform rejected the invalid-wrapper probe (expected)",
          };
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
  validateDirectSubmission: Array<Parameters<WorkflowDeps["validateDirectSubmission"]>[0]>;
  probeInvalidWrapperSubmission: Array<Parameters<WorkflowDeps["probeInvalidWrapperSubmission"]>[0]>;
  claim: Array<Parameters<WorkflowDeps["claim"]>[0]>;
  saveDraft: Array<Parameters<WorkflowDeps["saveDraft"]>[0]>;
  validate: Array<Parameters<WorkflowDeps["validate"]>[0]>;
  submit: Array<Parameters<WorkflowDeps["submit"]>[0]>;
}

function callRecords(): WorkflowCallRecords {
  return {
    policyCheckClaim: [],
    validateDirectSubmission: [],
    probeInvalidWrapperSubmission: [],
    claim: [],
    saveDraft: [],
    validate: [],
    submit: [],
  };
}
