// L2-PR2 — the Hermes analysis brain for citation-repair missions.
//
// Browser missions get testbedMissionSelfHealingDisposition(); citation-repair
// runs get THIS. It is quality-aware: a run can pass the permissive platform
// benchmark and still be a FAIL — it missed the dead links it was hired to fix,
// sliced garbled mid-<ref> claims, flagged live sources as "weak", or proposed
// prose that no editor can apply. That judgement is the "analyzed by Hermes"
// step.
//
// Two layers:
//   Layer A — a CHEAP, DETERMINISTIC quality gate (no LLM) over the real #407
//             report fields. It alone decides PASS / NEEDS_REVIEW / FAIL.
//   Layer B — Hermes's own LLM (reused monitor-hermes-voice transport) writes
//             the operator-facing verdict prose. It may NOT overturn a
//             deterministic PASS into a fabricated FAIL.
//
// TRUTH-BOUNDARY (critical): an honest empty proposal (citation_findings: [])
// with a justified review note — genuinely no dead links — is a PASS. We never
// manufacture a defect to create work.
//
// On FAIL the disposition emits exactly one FailureSignal { source:
// "citation_repair", … }. It does NOT dispatch — L2-PR3 wires the signal into
// self-healing. This module only defines + emits the signal.

import type { FailureSignal } from "./self-healing.js";

/** Confidence below this floor is at least a needs_review. */
export const CITATION_REPAIR_CONFIDENCE_FLOOR = 0.7;

/** The citation-repair adapter files a fix would target. */
export const CITATION_REPAIR_ADAPTER_AREA = "citation-repair-adapter";
const ADAPTER_FILES = "packages/averray-mcp/src/wiki-evidence.ts (citation/<ref> extraction) and packages/averray-mcp/src/job-workflows.ts (buildWikipediaCitationRepairProposal)";

export type CitationRepairVerdict = "pass" | "needs_review" | "fail";

export type CitationRepairFailReason =
  | "missed_dead_links"
  | "garbled_extraction"
  | "live_source_noise"
  | "non_applyable_fix"
  | "workflow_blocked";

export type CitationRepairReason = CitationRepairFailReason | "low_confidence" | "unanalyzable" | "clean";

export interface CitationRepairFinding {
  section?: string;
  problem?: string;
  current_claim?: string;
  evidence_url?: string;
}

export interface CitationRepairChange {
  change_type?: string;
  target_text?: string;
  replacement_text?: string;
  source_url?: string;
}

/** The structured citation-repair signal the gate reads — derived from the
 *  #407 dry-run workflow result (evidenceSummary + proposalPreview + readiness). */
export interface CitationRepairAnalysis {
  status: string;
  confidence: number;
  reason?: string;
  totalCitations?: number;
  flaggedCitations?: number;
  deadLinkCitations?: number;
  findings: CitationRepairFinding[];
  changes: CitationRepairChange[];
  reviewNotes: string[];
  /** proposalPreview.review_notes — the proposal's own justification. */
  reviewNotesText?: string;
  validatedBeforeClaim?: boolean;
  jobId?: string;
  runId?: string;
  pageTitle?: string;
  revisionId?: string;
}

/** What the gate knows about the job it was hired for. */
export interface CitationRepairJobDefinition {
  taskType?: string;
  categories?: string[];
  jobId?: string;
  pageTitle?: string;
}

export interface CitationRepairQualityResult {
  verdict: CitationRepairVerdict;
  /** FAIL reasons (empty unless verdict === "fail"). */
  reasons: CitationRepairFailReason[];
  /** Human-readable, per-reason explanations for the operator. */
  notes: string[];
  honestEmpty: boolean;
  lowConfidence: boolean;
}

export interface CitationRepairDisposition {
  verdict: CitationRepairVerdict;
  /** A citation FAIL points at a concrete code target, so it IS auto-fixable. */
  autoFixable: boolean;
  reason: CitationRepairReason;
  fixPrompt?: string;
  /** Operator-facing verdict prose posted to the card. */
  verdictText: string;
  /** Exactly one FailureSignal on FAIL; empty otherwise. */
  signals: FailureSignal[];
  /** True when Layer B (the LLM) authored the verdict prose. */
  layerBUsed: boolean;
}

/** A Hermes-attributed card comment (structurally compatible with
 *  recordCollaborationMessage's input). */
export interface CitationRepairCardComment {
  author: "hermes";
  kind: "status" | "proposal";
  addressedTo: "operator" | "everyone";
  relatedCorrelationId: string;
  text: string;
  hermesMode: "live" | "templated";
}

export interface CitationRepairDispositionDeps {
  /** Layer B: author the verdict prose. Injected so tests need no network. */
  llm?: (prompt: { system: string; user: string }) => Promise<string | null>;
  /** Post the Hermes-attributed verdict to the mission card. */
  postComment?: (comment: CitationRepairCardComment) => void;
  /** Repo a fix would target (so L2-PR3 can route the signal). */
  repo?: string;
  /** Board URL for the evidence deep-link. */
  boardUrl?: string;
}

// ── extraction ──────────────────────────────────────────────────────

/**
 * Map a raw #407 dry-run workflow result (or an already-structured analysis)
 * into a CitationRepairAnalysis. Pure + defensive — the workflow returns a
 * union of shapes and older runs may carry only a subset.
 */
export function toCitationRepairAnalysis(raw: unknown): CitationRepairAnalysis {
  const r = isRec(raw) ? raw : {};
  // Already a structured analysis (carries findings/changes) → normalize in place.
  if (Array.isArray(r.findings) || Array.isArray(r.changes)) {
    return normalizeAnalysis(r);
  }
  const summary = isRec(r.evidenceSummary) ? r.evidenceSummary : {};
  const preview = isRec(r.proposalPreview) ? r.proposalPreview : {};
  const readiness = isRec(r.readiness) ? r.readiness : {};
  return normalizeAnalysis({
    status: r.status,
    confidence: r.confidence,
    reason: r.reason,
    totalCitations: summary.totalCitations,
    flaggedCitations: summary.flaggedCitations,
    deadLinkCitations: summary.deadLinkCitations,
    findings: preview.citation_findings,
    changes: preview.proposed_changes,
    reviewNotes: r.reviewNotes,
    reviewNotesText: preview.review_notes,
    validatedBeforeClaim: readiness.validatedBeforeClaim,
    jobId: r.jobId,
    runId: r.runId,
    pageTitle: preview.page_title ?? summary.pageTitle,
    revisionId: preview.revision_id ?? summary.revisionId,
  });
}

/** Read the structured citation analysis off a recorded mission run.
 *  PR #407 attaches `run.result.citationRepair`; we also fall back to raw
 *  result fields. Returns undefined when there is nothing to analyze. */
export function citationRepairAnalysisFromRun(run: unknown): CitationRepairAnalysis | undefined {
  const r = isRec(run) ? run : {};
  const result = isRec(r.result) ? r.result : undefined;
  if (!result) return undefined;
  const block = isRec(result.citationRepair) ? result.citationRepair : undefined;
  const source = block
    ?? (isRec(result.proposalPreview) || isRec(result.evidenceSummary) || str(result.status) ? result : undefined);
  if (!source) return undefined;
  const analysis = toCitationRepairAnalysis(source);
  return {
    ...analysis,
    jobId: analysis.jobId ?? str(r.jobId),
    runId: analysis.runId ?? str(r.id),
    pageTitle: analysis.pageTitle ?? str(r.targetUrl),
  };
}

function normalizeAnalysis(r: Record<string, unknown>): CitationRepairAnalysis {
  return {
    status: (str(r.status) ?? "unknown").toLowerCase(),
    confidence: clamp01(num(r.confidence) ?? 0),
    ...(str(r.reason) ? { reason: str(r.reason) } : {}),
    ...(num(r.totalCitations) !== undefined ? { totalCitations: num(r.totalCitations) } : {}),
    ...(num(r.flaggedCitations) !== undefined ? { flaggedCitations: num(r.flaggedCitations) } : {}),
    ...(num(r.deadLinkCitations) !== undefined ? { deadLinkCitations: num(r.deadLinkCitations) } : {}),
    findings: arr(r.findings).map(toFinding).filter((f): f is CitationRepairFinding => f !== undefined),
    changes: arr(r.changes).map(toChange).filter((c): c is CitationRepairChange => c !== undefined),
    reviewNotes: strArr(r.reviewNotes),
    ...(str(r.reviewNotesText) ? { reviewNotesText: str(r.reviewNotesText) } : {}),
    ...(typeof r.validatedBeforeClaim === "boolean" ? { validatedBeforeClaim: r.validatedBeforeClaim } : {}),
    ...(str(r.jobId) ? { jobId: str(r.jobId) } : {}),
    ...(str(r.runId) ? { runId: str(r.runId) } : {}),
    ...(str(r.pageTitle) ? { pageTitle: str(r.pageTitle) } : {}),
    ...(str(r.revisionId) ? { revisionId: str(r.revisionId) } : {}),
  };
}

function toFinding(value: unknown): CitationRepairFinding | undefined {
  const r = isRec(value) ? value : undefined;
  if (!r) return undefined;
  return {
    ...(str(r.section) ? { section: str(r.section) } : {}),
    ...(str(r.problem) ? { problem: str(r.problem) } : {}),
    ...(str(r.current_claim) ? { current_claim: str(r.current_claim) } : {}),
    ...(str(r.evidence_url) ? { evidence_url: str(r.evidence_url) } : {}),
  };
}

function toChange(value: unknown): CitationRepairChange | undefined {
  const r = isRec(value) ? value : undefined;
  if (!r) return undefined;
  return {
    ...(str(r.change_type) ? { change_type: str(r.change_type) } : {}),
    ...(str(r.target_text) ? { target_text: str(r.target_text) } : {}),
    ...(str(r.replacement_text) ? { replacement_text: str(r.replacement_text) } : {}),
    ...(str(r.source_url) ? { source_url: str(r.source_url) } : {}),
  };
}

// ── Layer A — deterministic quality gate ────────────────────────────

/**
 * Decide PASS / NEEDS_REVIEW / FAIL from the structured analysis alone. Pure,
 * no LLM. This is the ONLY authority on the verdict; Layer B writes prose.
 */
export function citationRepairQualityGate(
  analysis: CitationRepairAnalysis,
  definition?: CitationRepairJobDefinition
): CitationRepairQualityResult {
  const status = analysis.status;
  const lowConfidence = analysis.confidence < CITATION_REPAIR_CONFIDENCE_FLOOR;

  // The workflow itself blocked/failed — a fail, but not a quality defect.
  if (status === "blocked" || status === "failed") {
    return {
      verdict: "fail",
      reasons: ["workflow_blocked"],
      notes: [analysis.reason ? `Workflow ${status}: ${analysis.reason}` : `Workflow ${status} before producing a reviewable proposal.`],
      honestEmpty: false,
      lowConfidence,
    };
  }

  const { findings, changes } = analysis;
  const hasJustification =
    Boolean(analysis.reviewNotesText && analysis.reviewNotesText.trim().length > 0) ||
    analysis.reviewNotes.some((n) => n.trim().length > 0);
  const honestEmpty = findings.length === 0 && changes.length === 0 && hasJustification;
  const isDeadLinkJob = jobImpliesDeadLinkRepair(definition);

  // TRUTH-BOUNDARY: an honest empty proposal with a justified note is a PASS.
  // Never manufacture a defect. (Still subject to the confidence floor.)
  if (honestEmpty) {
    return {
      verdict: lowConfidence ? "needs_review" : "pass",
      reasons: [],
      notes: lowConfidence
        ? [`No repair proposed (justified), but confidence ${pct(analysis.confidence)} is below the ${pct(CITATION_REPAIR_CONFIDENCE_FLOOR)} floor — operator review.`]
        : ["No dead links found and the empty result is justified — nothing to repair."],
      honestEmpty: true,
      lowConfidence,
    };
  }

  const reasons: CitationRepairFailReason[] = [];
  const notes: string[] = [];

  // 1) Missed dead links: hired for dead-link repair, produced work, yet reports
  //    zero dead-link citations — it missed the links it was hired to fix.
  if (isDeadLinkJob && analysis.deadLinkCitations === 0) {
    reasons.push("missed_dead_links");
    notes.push("Dead-link repair job, but the proposal reports 0 dead-link citations while still producing findings/changes — it missed the dead links it was hired to fix.");
  }

  // 2) Garbled extraction: a claim/target is a raw mid-string slice —
  //    unbalanced <ref>/template/brackets, or broken leading markup.
  const garbled = [
    ...findings.map((f) => f.current_claim),
    ...changes.map((c) => c.target_text),
  ].filter(isNonEmpty).filter(looksGarbled);
  if (garbled.length > 0) {
    reasons.push("garbled_extraction");
    notes.push(`Extraction is garbled (unbalanced <ref>/template/brackets or broken markup): "${truncate(garbled[0]!, 120)}".`);
  }

  // 3) Live-source noise: the adapter assigns problem="weak_source" ONLY to
  //    citations with no dead-link marker (i.e. LIVE). So a weak_source finding
  //    on a dead-link job == flagging a live source as weak (and any change that
  //    replaces it with an archive is archiving a live source) — noise.
  const weakSourceFindings = findings.filter((f) => /weak[_\s-]?source/i.test(f.problem ?? ""));
  if (isDeadLinkJob && weakSourceFindings.length > 0) {
    reasons.push("live_source_noise");
    const archiving = changes.some((c) => /replace/i.test(c.change_type ?? "") && isArchiveUrl(c.replacement_text) );
    notes.push(
      archiving
        ? `Flags ${weakSourceFindings.length} live source(s) as weak_source and proposes replacing a live source with an archive of itself — scope-creep noise, not dead-link repair.`
        : `Flags ${weakSourceFindings.length} live source(s) as weak_source instead of repairing dead links — false-positive noise.`
    );
  }

  // 4) Non-applyable fix: a replacement that is prose ("Use archived source …
  //    after editor review.") rather than applyable wikitext (<ref>…</ref> /
  //    {{cite …}} / [http…]).
  const nonApplyable = changes.filter(
    (c) => /replace/i.test(c.change_type ?? "") && isNonEmpty(c.replacement_text) && isProseNotWikitext(c.replacement_text!)
  );
  if (nonApplyable.length > 0) {
    reasons.push("non_applyable_fix");
    notes.push(`replacement_text is prose, not applyable wikitext: "${truncate(nonApplyable[0]!.replacement_text!, 120)}".`);
  }

  if (reasons.length > 0) {
    return { verdict: "fail", reasons, notes, honestEmpty: false, lowConfidence };
  }
  if (lowConfidence) {
    return {
      verdict: "needs_review",
      reasons: [],
      notes: [`Proposal looks clean, but confidence ${pct(analysis.confidence)} is below the ${pct(CITATION_REPAIR_CONFIDENCE_FLOOR)} floor — operator review.`],
      honestEmpty: false,
      lowConfidence: true,
    };
  }
  return { verdict: "pass", reasons: [], notes: ["Proposal repairs dead links with applyable, coherent citations."], honestEmpty: false, lowConfidence: false };
}

function jobImpliesDeadLinkRepair(definition?: CitationRepairJobDefinition): boolean {
  if (!definition) return true; // a citation_repair mission is, by mode, dead-link repair
  if (definition.taskType && definition.taskType.toLowerCase() === "citation_repair") return true;
  if ((definition.categories ?? []).some((c) => /dead[\s_-]?(external\s+)?link/i.test(c))) return true;
  // No explicit signal either way — treat a citation-repair disposition as a
  // dead-link job (the mode that routed here implies it).
  return definition.taskType === undefined && (definition.categories ?? []).length === 0;
}

/** Structural-only garbled detector. Deliberately avoids "starts lowercase"
 *  heuristics — context slices legitimately start mid-sentence, and flagging
 *  those would manufacture defects. We only trip on unbalanced wiki delimiters
 *  or broken leading markup, which are unambiguous. */
export function looksGarbled(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const openRefs = (t.match(/<ref\b/gi) ?? []).length;
  const closeRefs = (t.match(/<\/ref\s*>/gi) ?? []).length + (t.match(/\/\s*>/g) ?? []).length;
  if (openRefs > closeRefs) return true; // dangling <ref … >
  if (count(t, "{{") !== count(t, "}}")) return true; // unbalanced template
  if (count(t, "[") !== count(t, "]")) return true; // unbalanced brackets
  if (/^(?:\}\}|\]|\||\/?>|<\/)/.test(t)) return true; // broken leading markup
  return false;
}

/** Replacement text with no wiki markup that reads like an editor instruction
 *  — i.e. not applyable as-is. */
export function isProseNotWikitext(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const hasWikiMarkup = /<ref\b|<\/ref>|\{\{|\[https?:\/\/|\|\s*(url|title|website|publisher)\s*=/i.test(t);
  if (hasWikiMarkup) return false;
  return /\b(use|editor|review|verify|should|replace|consider|recommend|please)\b/i.test(t) || /[.!?]$/.test(t);
}

function isArchiveUrl(text?: string): boolean {
  return Boolean(text && /web\.archive\.org\/|archive\.org\/web\//i.test(text));
}

// ── fix-spec + verdict prose ────────────────────────────────────────

/**
 * Deterministic, build-handoff fix-spec (root cause → required behavior →
 * acceptance → tests), ALWAYS file-scoped to the adapter. Guarantees a
 * non-empty fixPrompt for the signal regardless of the LLM.
 */
export function buildCitationRepairFixSpec(
  gate: CitationRepairQualityResult,
  analysis: CitationRepairAnalysis,
  definition?: CitationRepairJobDefinition
): string {
  const page = analysis.pageTitle ?? definition?.pageTitle ?? analysis.jobId ?? "the article";
  const rootCauses: string[] = [];
  const required: string[] = [];
  const acceptance: string[] = [];
  const tests: string[] = [];

  for (const reason of gate.reasons) {
    switch (reason) {
      case "missed_dead_links":
        rootCauses.push("wiki-evidence.ts dead-link detection misses the article's actually-dead citations (deadLinkMarkers under-populated), so the proposal reports 0 dead links.");
        required.push("Extend deadLinkMarkers detection in wiki-evidence.ts (url-status=dead/unfit/usurped, {{dead link}}, dead-url=yes, 404/'not found' context) and have buildWikipediaCitationRepairProposal prioritize dead-link citations.");
        acceptance.push("A revision with known dead links yields deadLinkCitations > 0 and dead_link findings for each.");
        tests.push("wiki-evidence unit: a fixture revision with a {{dead link}} / url-status=dead citation populates deadLinkMarkers.");
        break;
      case "garbled_extraction":
        rootCauses.push("wiki-evidence.ts context extraction slices mid-<ref> / mid-template, producing current_claim/target_text that are raw mid-string fragments with unbalanced markup.");
        required.push("Extract claim text on <ref>…</ref> (and template) BOUNDARIES only in wiki-evidence.ts — never a raw character-window slice. Balance <ref>/{{}}/[] before emitting.");
        acceptance.push("Every current_claim / target_text has balanced <ref>/template/bracket delimiters and starts at a token boundary.");
        tests.push("wiki-evidence unit: extraction of a citation inside a sentence returns a balanced, boundary-aligned claim.");
        break;
      case "live_source_noise":
        rootCauses.push("job-workflows.ts buildWikipediaCitationRepairProposal flags every non-dead citation as problem=weak_source, so live (HTTP 200) sources get flagged/'archived' as noise on a dead-link job.");
        required.push("Gate weak_source on actual source liveness in job-workflows.ts — do not flag a live source as weak, and do not replace a live source with an archive of itself. Scope the proposal to dead-link citations.");
        acceptance.push("A live (200) source produces no weak_source finding and no archive-of-itself change.");
        tests.push("job-workflows unit: an evidence bundle of all-live sources yields zero weak_source findings.");
        break;
      case "non_applyable_fix":
        rootCauses.push("job-workflows.ts emits prose replacement_text ('Use archived source … after editor review.') instead of applyable wikitext.");
        required.push("Emit applyable wikitext in replacement_text (a complete <ref>…</ref> / {{cite web …}}) in job-workflows.ts, or mark the change as flag_for_editor_review rather than a replace_citation.");
        acceptance.push("Every replace_citation replacement_text is valid, applyable wikitext (contains <ref>/{{cite}}).");
        tests.push("job-workflows unit: a replace_citation change's replacement_text parses as a citation template, not a sentence.");
        break;
      case "workflow_blocked":
        rootCauses.push(`the citation-repair workflow ended ${analysis.status}${analysis.reason ? ` (${analysis.reason})` : ""} before producing a reviewable proposal.`);
        required.push("Diagnose why the dry-run workflow blocked/failed (evidence fetch, schema validation, or policy) in job-workflows.ts and surface a recoverable path.");
        acceptance.push("The same job runs to a needs_review dry-run proposal.");
        tests.push("job-workflows unit: the blocking condition is handled or reported with a clear reason.");
        break;
    }
  }

  return [
    `Fix the Averray citation-repair adapter for job ${analysis.jobId ?? "(unknown)"} (${page}).`,
    `Files: ${ADAPTER_FILES}.`,
    "",
    "Root cause:",
    ...rootCauses.map((r) => `- ${r}`),
    "",
    "Required behavior:",
    ...required.map((r) => `- ${r}`),
    "",
    "Acceptance:",
    ...acceptance.map((a) => `- ${a}`),
    "",
    "Tests:",
    ...tests.map((t) => `- ${t}`),
    "",
    "Keep the change narrow and the proposal Averray-attributed (read-only; no Wikipedia edit). Do not weaken the dry-run/no-claim boundary.",
  ].join("\n");
}

const HERMES_CITATION_PERSONA =
  "You are Hermes, the analysis brain for an autonomous agent platform. You judge whether a Wikipedia citation-repair proposal is genuinely good — not whether it passed a permissive benchmark. Be concise, concrete, and honest: if the deterministic gate found no defect, do not invent one. Write for an operator.";

export function buildHermesVerdictPrompt(
  gate: CitationRepairQualityResult,
  analysis: CitationRepairAnalysis,
  definition?: CitationRepairJobDefinition
): { system: string; user: string } {
  const lines = [
    `Job: ${definition?.taskType ?? "citation_repair"} on ${analysis.pageTitle ?? definition?.pageTitle ?? analysis.jobId ?? "an article"}.`,
    `Deterministic gate verdict: ${gate.verdict.toUpperCase()}${gate.reasons.length ? ` (${gate.reasons.join(", ")})` : ""}.`,
    `Counts: total=${analysis.totalCitations ?? "?"}, flagged=${analysis.flaggedCitations ?? "?"}, dead-link=${analysis.deadLinkCitations ?? "?"}. Confidence: ${pct(analysis.confidence)}.`,
    "",
    "Gate findings:",
    ...gate.notes.map((n) => `- ${n}`),
    "",
    "Proposal preview:",
    ...analysis.findings.slice(0, 5).map((f) => `- finding [${f.problem ?? "?"}]: ${truncate(f.current_claim ?? "", 140)}`),
    ...analysis.changes.slice(0, 5).map((c) => `- change [${c.change_type ?? "?"}]: ${truncate(c.target_text ?? "", 70)} → ${truncate(c.replacement_text ?? "", 90)}`),
    analysis.reviewNotesText ? `\nProposal review_notes: ${truncate(analysis.reviewNotesText, 200)}` : "",
    "",
    `Write ONE short paragraph: state the verdict (${gate.verdict}) and name the concrete defect(s) an operator must see. Do NOT change the verdict. Do not restate the fix-spec; just the verdict + defect.`,
  ];
  return { system: HERMES_CITATION_PERSONA, user: lines.filter((l) => l !== undefined).join("\n") };
}

export function buildDeterministicVerdictText(
  verdict: CitationRepairVerdict,
  gate: CitationRepairQualityResult,
  analysis: CitationRepairAnalysis
): string {
  const head =
    verdict === "pass"
      ? "PASS — the citation-repair proposal looks good."
      : verdict === "needs_review"
        ? "NEEDS REVIEW — the citation-repair proposal needs an operator look."
        : `FAIL — the citation-repair proposal is not good enough (${gate.reasons.join(", ")}).`;
  const deadLink = analysis.deadLinkCitations !== undefined ? ` ${analysis.deadLinkCitations} dead-link citation(s),` : "";
  const meta = `Analyzed ${analysis.totalCitations ?? "?"} citation(s);${deadLink} confidence ${pct(analysis.confidence)}.`;
  return [head, meta, ...gate.notes].join(" ");
}

// ── signal ──────────────────────────────────────────────────────────

export function buildCitationRepairFailureSignal(input: {
  run: { id?: string; jobId?: string; targetUrl?: string };
  analysis: CitationRepairAnalysis;
  gate: CitationRepairQualityResult;
  fixPrompt: string;
  repo?: string;
  boardUrl?: string;
}): FailureSignal {
  const { run, analysis, gate, fixPrompt, repo, boardUrl } = input;
  const jobId = analysis.jobId ?? str(run.jobId);
  const runId = analysis.runId ?? str(run.id);
  const page = analysis.pageTitle ?? str(run.targetUrl) ?? jobId ?? runId ?? "unknown";
  return {
    surface: `citation-repair:${jobId ?? runId ?? "unknown"}`,
    source: "citation_repair",
    summary: `Citation-repair proposal for ${page} failed Hermes's quality gate: ${gate.reasons.join(", ")}.`,
    area: CITATION_REPAIR_ADAPTER_AREA,
    // A citation FAIL has a concrete code target (the adapter), so it is
    // auto-fixable — unlike a browser-mission product blocker.
    autoFixable: true,
    fixPrompt,
    ...(repo ? { repo } : {}),
    ...(jobId ? { jobId } : {}),
    ...(runId ? { runId } : {}),
    ...(boardUrl && runId ? { evidence: `${boardUrl}?mission=${encodeURIComponent(runId)}` } : runId ? { evidence: runId } : {}),
  };
}

// ── orchestrator ────────────────────────────────────────────────────

/**
 * The full citation-repair disposition: Layer A decides the verdict, Layer B
 * (LLM, FAIL/needs_review only) writes the operator prose, the verdict is
 * posted to the card, and exactly one FailureSignal is emitted on FAIL. Layer B
 * can never overturn a deterministic PASS.
 */
export async function citationRepairDisposition(
  run: { id?: string; jobId?: string; targetUrl?: string; result?: unknown },
  definition?: CitationRepairJobDefinition,
  deps: CitationRepairDispositionDeps = {}
): Promise<CitationRepairDisposition> {
  const runId = str(run.id) ?? "unknown";
  const analysis = citationRepairAnalysisFromRun(run);

  // Nothing structured to analyze → needs_review, never a fabricated FAIL.
  if (!analysis) {
    const verdictText =
      "I could not analyze this citation-repair run — no structured proposal was attached to the report. Operator review before any follow-up.";
    deps.postComment?.({ author: "hermes", kind: "status", addressedTo: "operator", relatedCorrelationId: runId, text: verdictText, hermesMode: "templated" });
    return { verdict: "needs_review", autoFixable: false, reason: "unanalyzable", verdictText, signals: [], layerBUsed: false };
  }

  const gate = citationRepairQualityGate(analysis, definition);
  let layerBUsed = false;
  let verdictText: string;
  let fixPrompt: string | undefined;

  if (gate.verdict === "pass") {
    verdictText = buildDeterministicVerdictText("pass", gate, analysis);
  } else {
    // Layer B is invoked ONLY for fail/needs_review. The deterministic,
    // file-scoped fix-spec is the signal payload (always non-empty).
    fixPrompt = buildCitationRepairFixSpec(gate, analysis, definition);
    let prose: string | null = null;
    if (deps.llm) {
      try {
        prose = await deps.llm(buildHermesVerdictPrompt(gate, analysis, definition));
      } catch {
        prose = null;
      }
    }
    layerBUsed = Boolean(prose && prose.trim().length > 0);
    // Layer B writes prose; it MUST NOT overturn Layer A's verdict.
    const proseText = layerBUsed ? prose!.trim() : buildDeterministicVerdictText(gate.verdict, gate, analysis);
    verdictText = `${proseText}\n\nProposed fix-spec (Codex):\n${fixPrompt}`;
  }

  deps.postComment?.({
    author: "hermes",
    kind: gate.verdict === "fail" ? "proposal" : "status",
    addressedTo: "operator",
    relatedCorrelationId: runId,
    text: verdictText,
    hermesMode: layerBUsed ? "live" : "templated",
  });

  const signals =
    gate.verdict === "fail"
      ? [buildCitationRepairFailureSignal({ run, analysis, gate, fixPrompt: fixPrompt!, ...(deps.repo ? { repo: deps.repo } : {}), ...(deps.boardUrl ? { boardUrl: deps.boardUrl } : {}) })]
      : [];

  const reason: CitationRepairReason =
    gate.verdict === "fail" ? gate.reasons[0]! : gate.verdict === "needs_review" ? "low_confidence" : "clean";

  return {
    verdict: gate.verdict,
    autoFixable: gate.verdict === "fail",
    reason,
    ...(fixPrompt ? { fixPrompt } : {}),
    verdictText,
    signals,
    layerBUsed,
  };
}

// ── defensive readers ───────────────────────────────────────────────

function isRec(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strArr(value: unknown): string[] {
  return arr(value).map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
