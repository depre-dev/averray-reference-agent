import { randomUUID } from "node:crypto";
import type { SubmissionValidationResult } from "./validate-submission.js";
import type { WikipediaCitation } from "./wiki-evidence.js";

export type WorkflowStatus =
  | "submitted"
  | "no_submit"
  | "blocked"
  | "needs_review"
  | "failed";

export interface WikipediaCitationRepairWorkflowInput {
  runId?: string;
  jobId?: string;
  dryRun?: boolean;
  expectedWallet?: string;
  maxEvidenceUrls?: number;
  confidenceThreshold?: number;
}

export interface WorkflowJob {
  jobId: string;
  definition?: unknown;
}

export interface WorkflowWallet {
  configured: boolean;
  address: string | null;
}

export interface WorkflowDraft {
  draftId: string;
  outputHash?: string;
}

export interface WorkflowClaimResult {
  sessionId: string;
  claimDeadline?: string;
  response?: unknown;
}

export interface WorkflowSubmitResult {
  response?: unknown;
  blocked?: boolean;
  reason?: string;
  policy?: unknown;
}

export interface WorkflowDeps {
  generateRunId?(): string;
  listJobs(): Promise<WorkflowJob[]>;
  getDefinition(jobId: string): Promise<unknown>;
  walletStatus(): Promise<WorkflowWallet>;
  policyCheckClaim(input: {
    runId: string;
    jobId: string;
    taskType?: string;
    verifierMode?: string;
    rewardUsd: number;
  }): Promise<{ allowed: boolean; reason?: string; details?: unknown }>;
  /**
   * Schema-native readiness gate. Validates the exact `payload.submission`
   * object we *intend* to send against the platform's
   * `/jobs/validate-submission`, **before** any claim. The result is
   * recorded in the workflow's readiness report; an invalid result fails
   * closed without calling `claim`.
   */
  validateDirectSubmission(input: {
    runId: string;
    jobId: string;
    output: Record<string, unknown>;
  }): Promise<SubmissionValidationResult>;
  /**
   * Read-only schema-bypass probe. Sends an obviously-wrong wrapped
   * payload (`{ output: { wrapped_under_submission_output: true } }`)
   * to `/jobs/validate-submission` and expects the platform to reject
   * it. A `valid: true` response means the schema-native enforcement is
   * not actually gating this job, and the workflow fails closed before
   * claim instead of trusting the direct-validation pass.
   */
  probeInvalidWrapperSubmission(input: {
    runId: string;
    jobId: string;
  }): Promise<SubmissionValidationResult>;
  claim(input: { runId: string; jobId: string }): Promise<WorkflowClaimResult>;
  fetchEvidence(input: {
    definition: unknown;
    maxEvidenceUrls: number;
  }): Promise<WikipediaEvidenceBundle>;
  saveDraft(input: {
    runId: string;
    jobId: string;
    sessionId?: string;
    output: Record<string, unknown>;
  }): Promise<WorkflowDraft>;
  validate(input: {
    runId: string;
    jobId: string;
    sessionId?: string;
    draftId?: string;
    output?: Record<string, unknown>;
  }): Promise<SubmissionValidationResult>;
  submit(input: {
    runId: string;
    jobId: string;
    sessionId: string;
    draftId: string;
    outputHash?: string;
  }): Promise<WorkflowSubmitResult>;
}

export const SCHEMA_VALIDATES_PATH = "payload.submission" as const;
export const INVALID_WRAPPER_PROBE_SHAPE: Readonly<{
  output: { wrapped_under_submission_output: true };
}> = Object.freeze({ output: { wrapped_under_submission_output: true } });

/**
 * Per-job, per-run snapshot of the schema-native readiness gate. Surfaces
 * in the workflow return value and in the Slack summary so an operator
 * (or a future audit) can answer "did we actually check `payload.submission`
 * against the platform schema before claim, and did the invalid-wrapper
 * probe really fail the way it has to."
 */
export interface SchemaReadinessReport {
  jobId: string;
  schemaRef: string | null;
  schemaValidates: typeof SCHEMA_VALIDATES_PATH;
  validatedBeforeClaim: boolean;
  invalidWrappedOutput: {
    checkedBeforeClaim: boolean;
    probeShape: typeof INVALID_WRAPPER_PROBE_SHAPE;
    probeResult: SubmissionValidationResult | null;
  };
  claimAttempted: boolean;
}

export interface WikipediaEvidenceBundle {
  pageTitle: string;
  revisionId: string;
  revisionUrl?: string;
  citations: WikipediaCitation[];
  sourceChecks: Array<{
    url: string;
    status?: number;
    ok?: boolean;
    finalUrl?: string;
    archiveUrl?: string | null;
  }>;
}

export async function runWikipediaCitationRepairWorkflow(
  input: WikipediaCitationRepairWorkflowInput,
  deps: WorkflowDeps
) {
  const explicitRunId = input.runId === undefined ? undefined : normalizeRunId(input.runId);
  let runId = explicitRunId;
  const dryRun = input.dryRun ?? true;
  const maxEvidenceUrls = input.maxEvidenceUrls ?? 5;
  const confidenceThreshold = input.confidenceThreshold ?? 0.7;
  const events: string[] = [];

  try {
    if (input.runId !== undefined && !explicitRunId) {
      return {
        status: "blocked" as WorkflowStatus,
        dryRun,
        runId: null,
        reason: "invalid_run_id",
        slack: slackSummary(events),
      };
    }
    runId = runId
      ?? normalizeRunId(deps.generateRunId?.())
      ?? `wikipedia-citation-repair-${randomUUID()}`;
    const wallet = await deps.walletStatus();
    events.push("wallet_checked");
    if (!wallet.configured) {
      return blocked({ runId, dryRun, reason: "wallet_not_configured", wallet, events });
    }
    if (input.expectedWallet && !sameWallet(wallet.address, input.expectedWallet)) {
      return blocked({ runId, dryRun, reason: "wallet_mismatch", wallet, events });
    }

    const selected = await selectWikipediaCitationRepairJob(input.jobId, deps);
    if (!selected) {
      return blocked({ runId, dryRun, reason: "no_claimable_wikipedia_citation_repair_jobs", wallet, events });
    }
    events.push("job_selected");

    const definition = selected.definition ?? await deps.getDefinition(selected.jobId);
    if (!isWikipediaDefinition(definition) || readTaskType(definition) !== "citation_repair") {
      return blocked({
        runId,
        dryRun,
        jobId: selected.jobId,
        reason: "job_is_not_wikipedia_citation_repair",
        wallet,
        events,
      });
    }
    const claimState = readClaimState(definition);
    if (claimState.claimable === false) {
      return blocked({
        runId,
        dryRun,
        jobId: selected.jobId,
        reason: claimState.reason ?? "job_not_claimable",
        wallet,
        events,
      });
    }

    const policy = await deps.policyCheckClaim({
      runId,
      jobId: selected.jobId,
      taskType: readTaskType(definition),
      verifierMode: readVerifierMode(definition),
      rewardUsd: readRewardUsd(definition),
    });
    events.push("claim_policy_checked");
    if (!policy.allowed) {
      return blocked({
        runId,
        dryRun,
        jobId: selected.jobId,
        reason: policy.reason ?? "policy_rejected_claim",
        policy,
        wallet,
        events,
      });
    }

    const evidence = await deps.fetchEvidence({ definition, maxEvidenceUrls });
    events.push("evidence_fetched");
    const proposal = buildWikipediaCitationRepairProposal(definition, evidence);

    // Schema-native readiness gate — runs on every path (including
    // dry-run) so the readiness report shape never depends on whether
    // the caller wired up `dryRun: true`. The platform's
    // `/jobs/validate-submission` route is the source of truth; local
    // Zod is preserved for the post-claim flow as a fast secondary
    // check but is no longer the only line of defense.
    const schemaRef = readOutputSchemaRef(definition);
    const directValidation = await deps.validateDirectSubmission({
      runId,
      jobId: selected.jobId,
      output: proposal.output,
    });
    events.push("validated_direct_before_claim");
    const wrapperProbe = await deps.probeInvalidWrapperSubmission({
      runId,
      jobId: selected.jobId,
    });
    events.push("probed_invalid_wrapper_before_claim");

    const readiness: SchemaReadinessReport = {
      jobId: selected.jobId,
      schemaRef,
      schemaValidates: SCHEMA_VALIDATES_PATH,
      validatedBeforeClaim: directValidation.valid === true,
      invalidWrappedOutput: {
        checkedBeforeClaim: true,
        probeShape: INVALID_WRAPPER_PROBE_SHAPE,
        probeResult: wrapperProbe,
      },
      claimAttempted: false,
    };

    // Fail closed BEFORE claim if either:
    //   - the exact direct submission object is not `valid: true`
    //     against the schema-native endpoint, or
    //   - the invalid-wrapper probe passed (which would mean the
    //     schema-native enforcement is not actually gating this job).
    if (directValidation.valid !== true) {
      return {
        status: "blocked" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        wallet,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        proposalPreview: proposal.output,
        confidence: proposal.confidence,
        validation: directValidation,
        readiness,
        reason: "pre_claim_validation_failed",
        reviewNotes: [
          "Platform schema-native validation rejected the proposed payload.submission before claim.",
          "No averray_claim was attempted. Fix the highlighted JSON path and re-run.",
        ],
        slack: slackSummary(events, readiness),
      };
    }
    if (wrapperProbe.valid === true) {
      return {
        status: "blocked" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        wallet,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        proposalPreview: proposal.output,
        confidence: proposal.confidence,
        validation: directValidation,
        readiness,
        reason: "invalid_wrapper_probe_unexpectedly_valid",
        reviewNotes: [
          "Read-only invalid-wrapper probe was unexpectedly accepted by the platform.",
          "Schema-native enforcement is not actually gating this job; refusing to claim until the platform is fixed.",
        ],
        slack: slackSummary(events, readiness),
      };
    }

    if (dryRun) {
      events.push("validated_without_mutation");
      return {
        status: "needs_review" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        wallet,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        proposalPreview: proposal.output,
        confidence: proposal.confidence,
        validation: directValidation,
        readiness,
        reviewNotes: [
          "Dry run only: no Averray claim or submit was attempted.",
          "Review proposalPreview before running with dryRun=false.",
        ],
        slack: slackSummary(events, readiness),
      };
    }

    assertMutationRunId(runId, "claim");
    readiness.claimAttempted = true;
    const claim = await deps.claim({ runId, jobId: selected.jobId });
    events.push("claimed");
    if (!claim.sessionId) {
      return {
        status: "failed" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        reason: "claim_missing_session_id",
        wallet,
        readiness,
        slack: slackSummary(events, readiness),
      };
    }

    assertMutationRunId(runId, "draft");
    const draft = await deps.saveDraft({
      runId,
      jobId: selected.jobId,
      sessionId: claim.sessionId,
      output: proposal.output,
    });
    events.push("draft_saved");

    let validation = await deps.validate({ runId, jobId: selected.jobId, sessionId: claim.sessionId, draftId: draft.draftId });
    events.push("validated");
    if (!validation.valid) {
      const fixed = fixSchemaOnlyWikipediaProposal(proposal.output);
      if (fixed !== proposal.output) {
        const fixedDraft = await deps.saveDraft({
          runId,
          jobId: selected.jobId,
          sessionId: claim.sessionId,
          output: fixed,
        });
        events.push("schema_fixed_and_resaved");
        validation = await deps.validate({ runId, jobId: selected.jobId, sessionId: claim.sessionId, draftId: fixedDraft.draftId });
        if (validation.valid) {
          draft.draftId = fixedDraft.draftId;
          draft.outputHash = fixedDraft.outputHash;
        }
      }
    }

    if (!validation.valid) {
      return {
        status: "no_submit" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        sessionId: claim.sessionId,
        draftId: draft.draftId,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        validation,
        confidence: proposal.confidence,
        readiness,
        reason: "validation_failed",
        reviewNotes: ["Draft saved, but local schema validation failed. No submit attempted."],
        slack: slackSummary(events, readiness),
      };
    }

    if (proposal.confidence < confidenceThreshold) {
      return {
        status: "needs_review" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        sessionId: claim.sessionId,
        draftId: draft.draftId,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        validation,
        confidence: proposal.confidence,
        readiness,
        reason: "confidence_below_threshold",
        reviewNotes: ["Draft validated, but evidence confidence is below submit threshold. No submit attempted."],
        slack: slackSummary(events, readiness),
      };
    }

    assertMutationRunId(runId, "submit");
    const submit = await deps.submit({
      runId,
      jobId: selected.jobId,
      sessionId: claim.sessionId,
      draftId: draft.draftId,
      outputHash: draft.outputHash,
    });
    events.push("submit_attempted");
    if (submit.blocked) {
      return {
        status: "blocked" as WorkflowStatus,
        dryRun,
        runId,
        jobId: selected.jobId,
        sessionId: claim.sessionId,
        draftId: draft.draftId,
        evidenceSummary: summarizeEvidence(evidence),
        proposalSummary: summarizeProposal(proposal.output),
        validation,
        confidence: proposal.confidence,
        readiness,
        reason: submit.reason ?? "submit_blocked",
        submit,
        slack: slackSummary(events, readiness),
      };
    }

    return {
      status: "submitted" as WorkflowStatus,
      dryRun,
      runId,
      jobId: selected.jobId,
      sessionId: claim.sessionId,
      draftId: draft.draftId,
      evidenceSummary: summarizeEvidence(evidence),
      proposalSummary: summarizeProposal(proposal.output),
      validation,
      confidence: proposal.confidence,
      readiness,
      submit,
      reviewNotes: ["Submitted exactly once using the validated persisted draft."],
      slack: slackSummary(events, readiness),
    };
  } catch (error) {
    return {
      status: "failed" as WorkflowStatus,
      dryRun,
      runId,
      reason: error instanceof Error ? error.message : String(error),
      slack: slackSummary(events),
    };
  }
}

function normalizeRunId(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertMutationRunId(runId: string | undefined, phase: string): asserts runId is string {
  if (!normalizeRunId(runId)) {
    throw new Error(`workflow_missing_run_id_before_${phase}`);
  }
}

async function selectWikipediaCitationRepairJob(jobId: string | undefined, deps: WorkflowDeps) {
  if (jobId) {
    return { jobId, definition: await deps.getDefinition(jobId) };
  }
  const jobs = await deps.listJobs();
  for (const job of jobs) {
    const definition = job.definition ?? await deps.getDefinition(job.jobId);
    if (readTaskType(definition) !== "citation_repair") continue;
    if (!isWikipediaDefinition(definition)) continue;
    if (readClaimState(definition).claimable === false) continue;
    return { jobId: job.jobId, definition };
  }
  return undefined;
}

export function buildWikipediaCitationRepairProposal(
  definition: unknown,
  evidence: WikipediaEvidenceBundle
): { output: Record<string, unknown>; confidence: number } {
  const sourceByUrl = new Map<string, WikipediaEvidenceBundle["sourceChecks"][number]>();
  for (const check of evidence.sourceChecks) sourceByUrl.set(check.url, check);

  const fallbackEvidenceUrl = firstNonEmpty(evidence.revisionUrl, "https://en.wikipedia.org/");
  const anchorUrl = (citation: WikipediaCitation): string =>
    firstNonEmpty(citation.urls[0], citation.archiveUrls[0], fallbackEvidenceUrl);

  // ONLY genuinely dead links are defects. A live `<ref>` (url-status=live / 200)
  // is NOT a weak_source — flagging one and "replacing" it with an archive of
  // itself is noise, so we never emit weak_source findings. Prefer fewer real
  // findings (or an honest empty proposal) over manufactured work.
  const deadCitations = evidence.citations
    .filter((citation) => citation.deadLinkMarkers.length > 0)
    .slice(0, 10);

  const findings = deadCitations.map((citation) => ({
    section: firstNonEmpty(citation.section, "References"),
    problem: "dead_link" as const,
    current_claim: coherentCitationText(citation),
    evidence_url: anchorUrl(citation),
  }));

  const proposedChanges = deadCitations.map((citation) => {
    const target = coherentCitationText(citation);
    const primaryUrl = citation.urls[0];
    const sourceCheck = primaryUrl ? sourceByUrl.get(primaryUrl) : undefined;
    const archiveUrl = firstNonEmpty(citation.archiveUrls[0], sourceCheck?.archiveUrl ?? undefined) || undefined;
    const archiveDate = archiveUrl ? archiveDateFromWaybackUrl(archiveUrl) : undefined;

    // Applyable, HONEST fix: only when a real cite template carries the url AND a
    // Wayback snapshot whose date plausibly supports the cited content exists.
    if (archiveUrl && archiveDate && isCiteTemplate(target) && plausibleArchive(archiveDate, citation.accessDates)) {
      const replacement = addArchiveParamsToCitation(target, archiveUrl, archiveDate);
      if (replacement && replacement !== target) {
        return {
          change_type: "replace_citation" as const,
          target_text: target,
          replacement_text: replacement,
          source_url: archiveUrl,
        };
      }
    }

    // Otherwise flag for an editor — never assert an unverified / wrong-date
    // snapshot. (The output schema has no "verify_archive" change_type, so the
    // schema-valid way to say "verify before applying" is flag_for_editor_review.)
    const note = archiveUrl
      ? `Dead link. A Wayback snapshot exists (${archiveUrl}${archiveDate ? `, dated ${archiveDate}` : ""}) but it was not verified to support the cited content; an editor should confirm it covers the claim before adding |archive-url= |archive-date= |url-status=dead.`
      : "Dead link with no automatically reliable archive. An editor should find a live replacement source, or a verified Wayback snapshot that supports the cited content, before changing the citation.";
    return {
      change_type: "flag_for_editor_review" as const,
      target_text: target,
      replacement_text: note,
      source_url: anchorUrl(citation),
    };
  });

  const replaceCount = proposedChanges.filter((change) => change.change_type === "replace_citation").length;

  return {
    output: {
      page_title: firstNonEmpty(evidence.pageTitle, readPageTitle(definition), "Unknown page"),
      revision_id: firstNonEmpty(evidence.revisionId, readRevisionId(definition), "unknown"),
      citation_findings: findings,
      proposed_changes: proposedChanges,
      review_notes: citationRepairReviewNotes(deadCitations.length, replaceCount),
    },
    confidence: citationRepairConfidence(deadCitations.length, replaceCount),
  };
}

/** The full citation wikitext (coherent), never an arbitrary slice. */
function coherentCitationText(citation: WikipediaCitation): string {
  return firstNonEmpty(citation.raw, citation.context, citation.title, `Reference ${citation.index}`);
}

function isCiteTemplate(raw: string | undefined): boolean {
  return typeof raw === "string" && /\{\{\s*cite\b/i.test(raw);
}

/** Parse the snapshot date out of a Wayback URL (`/web/YYYYMMDD…/`). */
function archiveDateFromWaybackUrl(url: string): string | undefined {
  const match = url.match(/\/web\/(\d{4})(\d{2})(\d{2})/);
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** A snapshot "plausibly supports the cited date" only when there is a cited
 *  access-date to compare AND the snapshot lands in a sane window around it
 *  (≈ up to a year before, a few years after). With no cited date we cannot
 *  verify support, so we decline (→ flag for editor) rather than assert. */
function plausibleArchive(archiveDate: string, accessDates: string[]): boolean {
  const archiveMs = Date.parse(archiveDate);
  if (Number.isNaN(archiveMs)) return false;
  for (const accessDate of accessDates) {
    const accessMs = Date.parse(accessDate);
    if (Number.isNaN(accessMs)) continue;
    const days = (archiveMs - accessMs) / 86_400_000;
    if (days >= -366 && days <= 366 * 5) return true;
  }
  return false;
}

/** Insert `|archive-url= |archive-date= |url-status=dead` into the citation's
 *  cite template — applyable wikitext. Returns undefined if it already has an
 *  archive or has no cite template to augment. */
function addArchiveParamsToCitation(raw: string, archiveUrl: string, archiveDate: string): string | undefined {
  if (/\|\s*archive-?url\s*=/i.test(raw)) return undefined;
  const template = raw.match(/\{\{\s*cite\b[\s\S]*?\}\}/i)?.[0];
  if (!template) return undefined;
  const inner = template.replace(/\}\}\s*$/, "").trimEnd();
  const augmented = `${inner} |archive-url=${archiveUrl} |archive-date=${archiveDate} |url-status=dead}}`;
  return raw.replace(template, augmented);
}

function citationRepairConfidence(deadCount: number, replaceCount: number): number {
  if (deadCount === 0) return 0.6; // honest "nothing to repair"
  if (replaceCount > 0) return 0.78; // at least one applyable archive fix
  return 0.55; // dead links found, but only editor flags → needs review
}

function citationRepairReviewNotes(deadCount: number, replaceCount: number): string {
  if (deadCount === 0) {
    return "Averray-attributed analysis only. After checking both <ref> and template-embedded citations, no dead-link markers were found in this revision, so no repair is proposed. No Wikipedia edit was made.";
  }
  return `Averray-attributed proposal only. Found ${deadCount} dead-link citation(s); ${replaceCount} have an applyable archived-source fix, the rest are flagged for an editor to verify. No Wikipedia edit was made — an editor must confirm each archive supports the cited content before publishing.`;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

export function fixSchemaOnlyWikipediaProposal(output: Record<string, unknown>): Record<string, unknown> {
  const allowedTop = new Set(["page_title", "revision_id", "citation_findings", "proposed_changes", "review_notes"]);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (allowedTop.has(key)) cleaned[key] = value;
  }
  if (Array.isArray(cleaned.citation_findings)) {
    cleaned.citation_findings = cleaned.citation_findings.map((item) => pickRecord(item, [
      "section",
      "problem",
      "current_claim",
      "evidence_url",
    ]));
  }
  if (Array.isArray(cleaned.proposed_changes)) {
    cleaned.proposed_changes = cleaned.proposed_changes.map((item) => pickRecord(item, [
      "change_type",
      "target_text",
      "replacement_text",
      "source_url",
    ]));
  }
  return cleaned;
}

function blocked(input: {
  runId: string;
  dryRun: boolean;
  jobId?: string;
  reason: string;
  wallet?: WorkflowWallet;
  policy?: unknown;
  events: string[];
}) {
  return {
    status: "blocked" as WorkflowStatus,
    dryRun: input.dryRun,
    runId: input.runId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    reason: input.reason,
    ...(input.wallet ? { wallet: input.wallet } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    slack: slackSummary(input.events),
  };
}

function summarizeEvidence(evidence: WikipediaEvidenceBundle) {
  const flaggedCitations = evidence.citations.filter(
    (citation) => citation.urls.length > 0 || citation.archiveUrls.length > 0 || citation.deadLinkMarkers.length > 0
  );
  return {
    pageTitle: evidence.pageTitle,
    revisionId: evidence.revisionId,
    totalCitations: evidence.citations.length,
    flaggedCitations: flaggedCitations.length,
    deadLinkCitations: evidence.citations.filter((citation) => citation.deadLinkMarkers.length > 0).length,
    citationCount: evidence.citations.length,
    checkedSourceCount: evidence.sourceChecks.length,
    sourceUrls: evidence.sourceChecks.map((source) => source.url),
  };
}

function summarizeProposal(output: Record<string, unknown>) {
  const citationFindings = Array.isArray(output.citation_findings) ? output.citation_findings : [];
  const proposedChanges = Array.isArray(output.proposed_changes) ? output.proposed_changes : [];
  return {
    pageTitle: typeof output.page_title === "string" ? output.page_title : undefined,
    revisionId: typeof output.revision_id === "string" ? output.revision_id : undefined,
    citationFindings: citationFindings.length,
    proposedChanges: proposedChanges.length,
  };
}

function slackSummary(events: string[], readiness?: SchemaReadinessReport) {
  // Surface schema-native readiness explicitly in the Slack
  // summary. Readiness carries no secrets — schemaRef, validate /
  // probe outcomes, and a single claimAttempted boolean. We
  // deliberately omit raw validation `details`/`errors` from the
  // summary; the full validation result lives on the workflow
  // return value for log inspection.
  return {
    configured: Boolean(process.env.SLACK_WEBHOOK_URL),
    events,
    ...(readiness
      ? {
          schemaReadiness: {
            jobId: readiness.jobId,
            schemaRef: readiness.schemaRef,
            schemaValidates: readiness.schemaValidates,
            validatedBeforeClaim: readiness.validatedBeforeClaim,
            invalidWrappedOutputCheckedBeforeClaim:
              readiness.invalidWrappedOutput.checkedBeforeClaim,
            invalidWrappedOutputProbeValid:
              readiness.invalidWrappedOutput.probeResult?.valid ?? null,
            claimAttempted: readiness.claimAttempted,
          },
        }
      : {}),
  };
}

/**
 * Walk a `/jobs/definition` payload looking for the platform's
 * declared output schema reference. The platform's
 * `submissionContract.outputSchemaRef` is the canonical source; we
 * also accept the top-level `outputSchemaRef` and verifier-side
 * `evidenceSchemaRef` for older / alternate definition shapes. Returns
 * `null` when no schema ref is declared rather than guessing.
 */
function readOutputSchemaRef(definition: unknown): string | null {
  const submissionContract = recordField(definition, "submissionContract");
  const verifier = recordField(definition, "verifier");
  const verification = recordField(definition, "verification");
  const candidate =
    stringField(submissionContract, "outputSchemaRef") ??
    stringField(definition, "outputSchemaRef") ??
    stringField(verifier, "evidenceSchemaRef") ??
    stringField(verification, "evidenceSchemaRef");
  return candidate ?? null;
}

function isWikipediaDefinition(definition: unknown): boolean {
  const source = recordField(definition, "source");
  const publicDetails = recordField(definition, "publicDetails");
  const value = stringField(source, "type") ?? stringField(publicDetails, "source") ?? stringField(definition, "source");
  return value === "wikipedia_article" || value === "wikipedia";
}

function readClaimState(definition: unknown): { claimable?: boolean; reason?: string } {
  const claimStatus = recordField(definition, "claimStatus") ?? recordField(definition, "claim_state");
  const lifecycle = recordField(definition, "lifecycle");
  return {
    claimable: booleanField(claimStatus, "claimable") ?? booleanField(definition, "claimable"),
    reason:
      stringField(claimStatus, "reason") ??
      stringField(claimStatus, "claimBlockReason") ??
      stringField(lifecycle, "reason"),
  };
}

function readTaskType(definition: unknown): string | undefined {
  const source = recordField(definition, "source");
  const publicDetails = recordField(definition, "publicDetails");
  const agentContext = recordField(definition, "agentContext");
  return stringField(agentContext, "taskType") ?? stringField(source, "taskType") ?? stringField(publicDetails, "taskType");
}

function readVerifierMode(definition: unknown): string | undefined {
  return stringField(definition, "verifierMode") ?? stringField(definition, "verifier");
}

function readRewardUsd(definition: unknown): number {
  const reward = recordField(definition, "reward");
  const values = [
    numberField(definition, "rewardUsd"),
    numberField(definition, "reward_usd"),
    numberField(reward, "usd"),
    numberField(reward, "usdValue"),
  ];
  return values.find((value) => value !== undefined) ?? 0;
}

export function readPageTitle(definition: unknown): string | undefined {
  const source = recordField(definition, "source");
  const publicDetails = recordField(definition, "publicDetails");
  const urlTitle =
    titleFromWikipediaUrl(stringField(source, "articleUrl")) ??
    titleFromWikipediaUrl(stringField(source, "pinnedRevisionUrl")) ??
    titleFromWikipediaUrl(stringField(publicDetails, "articleUrl")) ??
    titleFromWikipediaUrl(stringField(publicDetails, "pinnedRevisionUrl"));
  return (
    stringField(source, "pageTitle") ??
    stringField(source, "page_title") ??
    stringField(source, "articleTitle") ??
    stringField(source, "title") ??
    stringField(publicDetails, "pageTitle") ??
    stringField(publicDetails, "articleTitle") ??
    stringField(publicDetails, "title") ??
    urlTitle
  );
}

export function readRevisionId(definition: unknown): string | undefined {
  const source = recordField(definition, "source");
  const publicDetails = recordField(definition, "publicDetails");
  const urlRevisionId =
    oldIdFromWikipediaUrl(stringField(source, "pinnedRevisionUrl")) ??
    oldIdFromWikipediaUrl(stringField(publicDetails, "pinnedRevisionUrl"));
  const numericRevisionId =
    numberField(source, "revisionId") ??
    numberField(source, "revision_id") ??
    numberField(source, "pinnedRevisionId") ??
    numberField(publicDetails, "revisionId") ??
    numberField(publicDetails, "revision_id");
  return (
    stringField(source, "revisionId") ??
    stringField(source, "revision_id") ??
    stringField(source, "pinnedRevisionId") ??
    stringField(publicDetails, "revisionId") ??
    stringField(publicDetails, "revision_id") ??
    (numericRevisionId !== undefined ? String(numericRevisionId) : undefined) ??
    urlRevisionId
  );
}

function sameWallet(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function pickRecord(value: unknown, keys: string[]): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(keys.map((key) => [key, record[key]]).filter(([, item]) => item !== undefined));
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "number") return field;
  if (typeof field === "string" && field.length > 0 && Number.isFinite(Number(field))) return Number(field);
  return undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function titleFromWikipediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const title = url.searchParams.get("title");
    if (title) return title.replace(/_/g, " ");
    const wikiPathMatch = url.pathname.match(/\/wiki\/(.+)$/);
    return wikiPathMatch ? decodeURIComponent(wikiPathMatch[1]).replace(/_/g, " ") : undefined;
  } catch {
    return undefined;
  }
}

function oldIdFromWikipediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const oldid = new URL(value).searchParams.get("oldid");
    return oldid && oldid.length > 0 ? oldid : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
