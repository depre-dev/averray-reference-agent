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

    if (dryRun) {
      const validation = await deps.validate({ runId, jobId: selected.jobId, output: proposal.output });
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
        validation,
        reviewNotes: [
          "Dry run only: no Averray claim or submit was attempted.",
          "Review proposalPreview before running with dryRun=false.",
        ],
        slack: slackSummary(events),
      };
    }

    assertMutationRunId(runId, "claim");
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
        slack: slackSummary(events),
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
        reason: "validation_failed",
        reviewNotes: ["Draft saved, but local schema validation failed. No submit attempted."],
        slack: slackSummary(events),
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
        reason: "confidence_below_threshold",
        reviewNotes: ["Draft validated, but evidence confidence is below submit threshold. No submit attempted."],
        slack: slackSummary(events),
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
        reason: submit.reason ?? "submit_blocked",
        submit,
        slack: slackSummary(events),
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
      submit,
      reviewNotes: ["Submitted exactly once using the validated persisted draft."],
      slack: slackSummary(events),
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
  const findings = evidence.citations
    .filter((citation) => citation.urls.length > 0 || citation.deadLinkMarkers.length > 0)
    .slice(0, 5)
    .map((citation) => {
      const evidenceUrl = citation.archiveUrls[0] ?? citation.urls[0] ?? evidence.revisionUrl ?? "";
      return {
        section: "References",
        problem: citation.deadLinkMarkers.length > 0 ? "dead_link" : "weak_source",
        current_claim: citation.context || citation.title || `Reference ${citation.index}`,
        evidence_url: evidenceUrl,
      };
    });
  const proposedChanges = evidence.citations
    .filter((citation) => citation.urls.length > 0 || citation.archiveUrls.length > 0)
    .slice(0, 5)
    .map((citation) => {
      const sourceUrl = citation.archiveUrls[0] ?? citation.urls[0] ?? evidence.revisionUrl ?? "";
      return {
        change_type: citation.archiveUrls.length > 0 ? "replace_citation" : "flag_for_editor_review",
        target_text: citation.context || citation.title || `Reference ${citation.index}`,
        replacement_text:
          citation.archiveUrls.length > 0
            ? `Use archived source ${citation.archiveUrls[0]} after editor review.`
            : "Editor should verify and replace this citation with a live reliable source or archive.",
        source_url: sourceUrl,
      };
    });

  if (findings.length === 0 && evidence.citations[0]) {
    const citation = evidence.citations[0];
    findings.push({
      section: "References",
      problem: "weak_source",
      current_claim: citation.context || citation.title || `Reference ${citation.index}`,
      evidence_url: citation.urls[0] ?? evidence.revisionUrl ?? "",
    });
    proposedChanges.push({
      change_type: "flag_for_editor_review",
      target_text: citation.context || citation.title || `Reference ${citation.index}`,
      replacement_text: "Editor should review this citation before publishing any change.",
      source_url: citation.urls[0] ?? evidence.revisionUrl ?? "",
    });
  }

  const hasDeadMarker = evidence.citations.some((citation) => citation.deadLinkMarkers.length > 0);
  const hasSource = evidence.citations.some((citation) => citation.urls.length > 0 || citation.archiveUrls.length > 0);
  const confidence = hasDeadMarker && hasSource ? 0.72 : hasSource ? 0.62 : 0.4;

  return {
    output: {
      page_title: evidence.pageTitle || readPageTitle(definition) || "Unknown page",
      revision_id: evidence.revisionId || readRevisionId(definition) || "unknown",
      citation_findings: findings,
      proposed_changes: proposedChanges,
      review_notes:
        "Averray-attributed proposal only. No Wikipedia edit was made. Human editor should verify the source/archive before publishing.",
    },
    confidence,
  };
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

function slackSummary(events: string[]) {
  return {
    configured: Boolean(process.env.SLACK_WEBHOOK_URL),
    events,
  };
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
