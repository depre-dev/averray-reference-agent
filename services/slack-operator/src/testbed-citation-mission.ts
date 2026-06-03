// Citation-repair board mission (PR-1).
//
// A board-launched citation_repair mission reuses the existing
// request → approve → runner → report → card pipeline, but instead of driving
// a browser it runs the Wikipedia citation-repair WORKFLOW in dry-run and maps
// its result into the standard TestbedMissionStructuredReport so the board
// renders it as a mission card.
//
// Hard rule: dryRun is FORCED true here — a board citation-repair mission only
// ANALYZES (no claim, no submit). Settlement stays operator-gated elsewhere.
// The client/mission can never flip this to a mutation.

import {
  runWikipediaCitationRepairWorkflow,
  type WorkflowDeps,
} from "@avg/averray-mcp/job-workflows";
import { createDefaultWorkflowDeps } from "@avg/averray-mcp/default-workflow-runtime";
import type { TestbedMissionRun } from "./monitor-testbed-missions.js";
import type { TestbedMissionRunResult, TestbedMissionRunnerConfig } from "./testbed-mission-runner.js";
import { toCitationRepairAnalysis, type CitationRepairAnalysis } from "./citation-repair-disposition.js";

export interface CitationRepairMissionDeps {
  /** Injected for tests; defaults to the real workflow. */
  runWorkflow?: typeof runWikipediaCitationRepairWorkflow;
  /** Injected for tests; defaults to the process-wide workflow deps. */
  workflowDeps?: WorkflowDeps;
}

/** The standard structured-report shape the mission pipeline ingests. */
interface CitationRepairMissionReport {
  verdict: "pass" | "fail";
  confidence: number;
  stoppedBeforeMutation: true;
  mutationMode: "read_only";
  mutationsAttempted: string[];
  mutationBoundaryNotes: string[];
  scores: Record<string, number>;
  completedPath: string[];
  blockers: string[];
  confusingMoments: string[];
  recommendations: string[];
  evidence: string[];
  summary: string;
  /** L2: the structured citation-repair signal, preserved so Hermes's
   *  disposition (citationRepairDisposition) can read the REAL fields
   *  (counts, findings, changes) instead of re-parsing the evidence strings.
   *  Survives ingestion into run.result via the report spread. */
  citationRepair?: CitationRepairAnalysis;
}

export async function executeCitationRepairMission(
  mission: TestbedMissionRun,
  _config: TestbedMissionRunnerConfig,
  deps: CitationRepairMissionDeps = {},
): Promise<TestbedMissionRunResult> {
  const runWorkflow = deps.runWorkflow ?? runWikipediaCitationRepairWorkflow;
  const workflowDeps = deps.workflowDeps ?? createDefaultWorkflowDeps();
  const jobId = typeof mission.jobId === "string" && mission.jobId.trim() ? mission.jobId.trim() : undefined;

  let report: CitationRepairMissionReport;
  try {
    // dryRun is FORCED — never read from the mission/client.
    const result = await runWorkflow({ ...(jobId ? { jobId } : {}), dryRun: true }, workflowDeps);
    report = citationRepairResultToReport(result as Record<string, unknown>);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    report = citationRepairResultToReport({ status: "failed", reason, reviewNotes: [reason] });
  }

  return {
    exitCode: 0,
    stdout: report.summary,
    stderr: "",
    reportText: JSON.stringify({ kind: "testbed_mission_report", report }),
    summary: report.summary,
  };
}

/**
 * Map a Wikipedia citation-repair workflow result → the standard mission report.
 * Pure + defensive (the workflow returns a union of object shapes).
 *
 * verdict: blocked/failed → "fail"; needs_review/submitted (a clean dry-run
 * that produced a reviewable proposal) → "pass" (the MISSION ran successfully;
 * the proposal still needs operator review — surfaced in summary/recommendations,
 * and quality-judged downstream). dryRun is analysis-only, so it never claims a
 * "verified" outcome on its own.
 */
export function citationRepairResultToReport(result: Record<string, unknown>): CitationRepairMissionReport {
  const status = str(result.status) ?? "unknown";
  const failed = status === "blocked" || status === "failed";
  const confidence = clamp01(num(result.confidence));
  const reviewNotes = strArray(result.reviewNotes);
  const reason = str(result.reason);

  const summaryRec = rec(result.evidenceSummary);
  const totalCitations = num(summaryRec?.totalCitations);
  const flaggedCitations = num(summaryRec?.flaggedCitations);
  const deadLinkCitations = num(summaryRec?.deadLinkCitations);

  const readiness = rec(result.readiness);
  const validatedBeforeClaim = readiness?.validatedBeforeClaim === true;
  const wrapperProbe = rec(rec(readiness?.invalidWrappedOutput)?.probeResult);
  const wrapperRejected = wrapperProbe ? wrapperProbe.valid !== true : undefined;

  const evidence: string[] = [`status: ${status}`];
  if (status !== "unknown") evidence.push(`verdict: ${failed ? "fail" : "pass (dry-run; needs operator review)"}`);
  if (deadLinkCitations !== undefined) evidence.push(`dead-link citations: ${deadLinkCitations}`);
  if (totalCitations !== undefined) evidence.push(`total citations: ${totalCitations}`);
  if (flaggedCitations !== undefined) evidence.push(`flagged citations: ${flaggedCitations}`);
  if (readiness) evidence.push(`validated before claim: ${validatedBeforeClaim ? "yes" : "no"}`);
  if (wrapperRejected !== undefined) evidence.push(`invalid-wrapper probe: ${wrapperRejected ? "rejected (good)" : "accepted (unsafe)"}`);
  if (reason) evidence.push(`reason: ${reason}`);
  evidence.push(...renderProposalPreview(rec(result.proposalPreview)));
  if (evidence.length === 0) evidence.push("Citation-repair workflow returned no detail.");

  const deadLinkLabel = deadLinkCitations !== undefined ? `${deadLinkCitations} dead-link citation(s)` : "no dead-link count";
  const summary = failed
    ? `Citation-repair dry run blocked (${status})${reason ? `: ${reason}` : ""}.`
    : `Citation-repair dry run — needs operator review before claim/submit · ${deadLinkLabel} · confidence ${Math.round(confidence * 100)}%.`;

  return {
    verdict: failed ? "fail" : "pass",
    confidence,
    stoppedBeforeMutation: true,
    mutationMode: "read_only",
    mutationsAttempted: [],
    mutationBoundaryNotes: [
      "Dry run — no Averray claim or submit was attempted. Board citation-repair runs are analysis-only; settlement stays operator-gated.",
    ],
    scores: {},
    completedPath: failed
      ? []
      : [
        "Selected a claimable Wikipedia citation-repair job",
        "Fetched the article's citations and evidence",
        "Built the citation-repair proposal",
        "Validated the submission against the platform schema before any claim (no mutation)",
      ],
    blockers: failed
      ? [reason ?? `Citation-repair workflow ended with status "${status}".`, ...reviewNotes]
      : [],
    confusingMoments: [],
    recommendations: reviewNotes,
    evidence,
    summary,
    // Preserve the structured signal for Hermes's downstream quality gate.
    citationRepair: toCitationRepairAnalysis(result),
  };
}

function renderProposalPreview(preview: Record<string, unknown> | undefined): string[] {
  if (!preview) return [];
  const lines: string[] = [];
  const findings = arr(preview.citation_findings);
  for (const f of findings.slice(0, 8)) {
    const r = rec(f);
    if (!r) continue;
    const problem = str(r.problem) ?? "finding";
    const claim = str(r.current_claim) ?? str(r.target_text) ?? "";
    lines.push(`finding · ${problem}: ${truncate(claim, 160)}`);
  }
  const changes = arr(preview.proposed_changes);
  for (const c of changes.slice(0, 8)) {
    const r = rec(c);
    if (!r) continue;
    const from = truncate(str(r.target_text) ?? "", 80);
    const to = truncate(str(r.replacement_text) ?? "", 80);
    lines.push(`change · ${from} → ${to}`);
  }
  const notes = str(preview.review_notes);
  if (notes) lines.push(`proposal notes: ${truncate(notes, 200)}`);
  return lines;
}

// ── defensive readers ───────────────────────────────────────────────
function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function strArray(value: unknown): string[] {
  return arr(value).map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function clamp01(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.max(0, Math.min(1, value));
}
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
