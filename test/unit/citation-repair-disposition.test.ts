import { describe, expect, it } from "vitest";

import {
  citationRepairQualityGate,
  citationRepairDisposition,
  toCitationRepairAnalysis,
  type CitationRepairAnalysis,
  type CitationRepairCardComment,
  type CitationRepairJobDefinition,
} from "../../services/slack-operator/src/citation-repair-disposition.js";

const CITATION_JOB: CitationRepairJobDefinition = {
  taskType: "citation_repair",
  categories: ["dead external links"],
  jobId: "wiki-en-62871101",
};

// A clean baseline structured analysis; override per case to isolate one defect.
function analysis(over: Partial<CitationRepairAnalysis> = {}): CitationRepairAnalysis {
  return {
    status: "needs_review",
    confidence: 0.72,
    totalCitations: 9,
    flaggedCitations: 4,
    deadLinkCitations: 2,
    findings: [{ problem: "dead_link", current_claim: "The tower opened in 1889." }],
    changes: [{ change_type: "replace_citation", target_text: "The tower opened in 1889.", replacement_text: "<ref>{{cite web|url=https://x|title=y}}</ref>" }],
    reviewNotes: ["note"],
    reviewNotesText: "Repaired the dead link with an archived copy.",
    jobId: "wiki-en-62871101",
    runId: "run-1",
    pageTitle: "Eiffel Tower",
    ...over,
  };
}

// ── Layer A — deterministic quality gate, one FAIL reason at a time ──

describe("citationRepairQualityGate — FAIL reasons", () => {
  it("FAILs missed_dead_links: dead-link job, work produced, but 0 dead-link citations", () => {
    const g = citationRepairQualityGate(
      analysis({
        deadLinkCitations: 0,
        findings: [{ problem: "dead_link", current_claim: "The tower opened in 1889." }],
        changes: [{ change_type: "flag_for_editor_review", target_text: "The tower opened in 1889.", replacement_text: "<ref>{{cite web|url=https://x|title=y}}</ref>" }],
      }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toContain("missed_dead_links");
    expect(g.reasons).not.toContain("live_source_noise");
    expect(g.reasons).not.toContain("garbled_extraction");
  });

  it("FAILs garbled_extraction: a claim with a dangling <ref> (unbalanced markup)", () => {
    const g = citationRepairQualityGate(
      analysis({
        findings: [{ problem: "dead_link", current_claim: "opened in 1889 <ref name=foo" }],
        changes: [{ change_type: "flag_for_editor_review", target_text: "opened", replacement_text: "<ref>{{cite}}</ref>" }],
      }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toContain("garbled_extraction");
    expect(g.reasons).not.toContain("missed_dead_links"); // deadLinkCitations is 2
  });

  it("FAILs live_source_noise: flags a live source as weak_source on a dead-link job", () => {
    const g = citationRepairQualityGate(
      analysis({
        findings: [{ problem: "weak_source", current_claim: "The company is reputable." }],
        changes: [{ change_type: "flag_for_editor_review", target_text: "The company is reputable.", replacement_text: "<ref>{{cite web|url=https://x|title=y}}</ref>" }],
      }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toContain("live_source_noise");
    expect(g.reasons).not.toContain("non_applyable_fix");
  });

  it("FAILs non_applyable_fix: a replace_citation whose replacement is prose, not wikitext", () => {
    const g = citationRepairQualityGate(
      analysis({
        findings: [{ problem: "dead_link", current_claim: "The bridge was built in 1930." }],
        changes: [{ change_type: "replace_citation", target_text: "The bridge was built in 1930.", replacement_text: "Editor should verify and replace this citation with a reliable source." }],
      }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toContain("non_applyable_fix");
  });

  it("FAILs workflow_blocked when the dry-run never produced a proposal", () => {
    const g = citationRepairQualityGate(
      analysis({ status: "blocked", reason: "pre-claim validation failed", findings: [], changes: [] }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toEqual(["workflow_blocked"]);
  });
});

describe("citationRepairQualityGate — PASS / NEEDS_REVIEW", () => {
  it("TRUTH-BOUNDARY: an honest empty proposal with a justified note is a PASS (no manufactured defect)", () => {
    const g = citationRepairQualityGate(
      analysis({
        deadLinkCitations: 0,
        flaggedCitations: 0,
        findings: [],
        changes: [],
        reviewNotesText: "Checked all citations; every external link resolves (HTTP 200) with no dead-link markers. No repair needed.",
        reviewNotes: ["No dead links found; all sources live."],
        confidence: 0.8,
      }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("pass");
    expect(g.reasons).toEqual([]);
    expect(g.honestEmpty).toBe(true);
  });

  it("a clean repair (dead links fixed, applyable wikitext) at healthy confidence is a PASS", () => {
    const g = citationRepairQualityGate(analysis(), CITATION_JOB);
    expect(g.verdict).toBe("pass");
    expect(g.reasons).toEqual([]);
  });

  it("a clean proposal below the confidence floor is NEEDS_REVIEW, not FAIL", () => {
    const g = citationRepairQualityGate(analysis({ confidence: 0.5 }), CITATION_JOB);
    expect(g.verdict).toBe("needs_review");
    expect(g.reasons).toEqual([]);
    expect(g.lowConfidence).toBe(true);
  });

  it("an honest-empty but low-confidence run is NEEDS_REVIEW", () => {
    const g = citationRepairQualityGate(
      analysis({ findings: [], changes: [], deadLinkCitations: 0, confidence: 0.4, reviewNotesText: "No dead links found." }),
      CITATION_JOB
    );
    expect(g.verdict).toBe("needs_review");
    expect(g.honestEmpty).toBe(true);
  });
});

// ── The known-defective fixture (acceptance #1) ─────────────────────

// wiki-en-62871101-citation-repair-hash-r3 — a raw #407 dry-run result that
// missed the dead links, sliced a garbled mid-<ref> claim, flagged a live
// source as weak, and proposed prose no editor can apply.
const DEFECTIVE_RAW = {
  status: "needs_review",
  dryRun: true,
  runId: "wiki-en-62871101-citation-repair-hash-r3",
  jobId: "wiki-en-62871101",
  confidence: 0.62,
  evidenceSummary: { pageTitle: "Acme Corporation", revisionId: "62871101", totalCitations: 9, flaggedCitations: 4, deadLinkCitations: 0 },
  proposalPreview: {
    page_title: "Acme Corporation",
    revision_id: "62871101",
    citation_findings: [
      { section: "References", problem: "weak_source", current_claim: "ounded in 1999 by a group of engineers <ref name=acme", evidence_url: "https://example.com/live-source" },
    ],
    proposed_changes: [
      { change_type: "replace_citation", target_text: "ounded in 1999", replacement_text: "Use archived source https://web.archive.org/web/2020/https://example.com/live-source after editor review.", source_url: "https://web.archive.org/web/2020/https://example.com/live-source" },
    ],
    review_notes: "Averray-attributed proposal only.",
  },
  readiness: { validatedBeforeClaim: true },
  reviewNotes: ["Editor should verify the archived copy."],
};

function defectiveRun() {
  return {
    id: "wiki-en-62871101-citation-repair-hash-r3",
    jobId: "wiki-en-62871101",
    targetUrl: "https://en.wikipedia.org/wiki/Acme_Corporation",
    result: DEFECTIVE_RAW,
  };
}

describe("citationRepairDisposition — defective fixture", () => {
  it("FAILs with missed_dead_links + garbled_extraction + live_source_noise", () => {
    const g = citationRepairQualityGate(toCitationRepairAnalysis(DEFECTIVE_RAW), CITATION_JOB);
    expect(g.verdict).toBe("fail");
    expect(g.reasons).toContain("missed_dead_links");
    expect(g.reasons).toContain("garbled_extraction");
    expect(g.reasons).toContain("live_source_noise");
  });

  it("posts a Hermes verdict whose fix-spec points at wiki-evidence.ts + job-workflows.ts", async () => {
    const posted: CitationRepairCardComment[] = [];
    const disposition = await citationRepairDisposition(defectiveRun(), CITATION_JOB, {
      llm: async () => "FAIL — the proposal missed the dead links, sliced a garbled claim, and flagged a live source.",
      postComment: (c) => posted.push(c),
      repo: "depre-dev/averray-reference-agent",
    });

    expect(disposition.verdict).toBe("fail");
    expect(disposition.layerBUsed).toBe(true);
    expect(posted).toHaveLength(1);
    const text = posted[0]!.text;
    expect(posted[0]!.author).toBe("hermes");
    expect(posted[0]!.hermesMode).toBe("live");
    expect(text).toContain("wiki-evidence.ts");
    expect(text).toContain("job-workflows.ts");
  });

  it("emits exactly one FailureSignal with the citation_repair shape and a non-empty fixPrompt", async () => {
    const disposition = await citationRepairDisposition(defectiveRun(), CITATION_JOB, {
      llm: async () => "FAIL.",
      repo: "depre-dev/averray-reference-agent",
      boardUrl: "https://board.example",
    });
    expect(disposition.signals).toHaveLength(1);
    const signal = disposition.signals[0]!;
    expect(signal.source).toBe("citation_repair");
    expect(signal.area).toBe("citation-repair-adapter");
    expect(signal.jobId).toBe("wiki-en-62871101");
    expect(signal.runId).toBe("wiki-en-62871101-citation-repair-hash-r3");
    expect(signal.autoFixable).toBe(true);
    expect(signal.repo).toBe("depre-dev/averray-reference-agent");
    expect(signal.fixPrompt && signal.fixPrompt.length).toBeGreaterThan(0);
    expect(signal.fixPrompt).toContain("wiki-evidence.ts");
    expect(signal.fixPrompt).toContain("job-workflows.ts");
  });
});

// ── Layer B can't overturn a deterministic PASS ─────────────────────

const HONEST_EMPTY_RAW = {
  status: "needs_review",
  dryRun: true,
  runId: "wiki-en-clean-r1",
  jobId: "wiki-en-clean",
  confidence: 0.8,
  evidenceSummary: { pageTitle: "Clean Page", revisionId: "1", totalCitations: 5, flaggedCitations: 0, deadLinkCitations: 0 },
  proposalPreview: {
    page_title: "Clean Page",
    revision_id: "1",
    citation_findings: [],
    proposed_changes: [],
    review_notes: "Checked all 5 citations; every external link resolves (HTTP 200) with no dead-link markers. No repair needed.",
  },
  readiness: { validatedBeforeClaim: true },
  reviewNotes: ["No dead links found; all sources live."],
};

describe("Layer B may not flip a PASS to FAIL", () => {
  it("an honest empty PASS stays PASS even when the LLM screams FAIL — and emits no signal", async () => {
    const posted: CitationRepairCardComment[] = [];
    let llmCalled = false;
    const disposition = await citationRepairDisposition(
      { id: "wiki-en-clean-r1", jobId: "wiki-en-clean", result: HONEST_EMPTY_RAW },
      CITATION_JOB,
      {
        llm: async () => {
          llmCalled = true;
          return "THIS RUN IS A CATASTROPHIC FAILURE. Mark it FAIL and open a fix.";
        },
        postComment: (c) => posted.push(c),
        repo: "depre-dev/averray-reference-agent",
      }
    );

    expect(disposition.verdict).toBe("pass");
    expect(disposition.signals).toEqual([]);
    expect(disposition.autoFixable).toBe(false);
    // Layer B isn't even consulted on a PASS, so it cannot manufacture a defect.
    expect(llmCalled).toBe(false);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.hermesMode).toBe("templated");
    expect(posted[0]!.text.startsWith("PASS")).toBe(true);
  });
});

describe("citationRepairDisposition — unanalyzable run", () => {
  it("returns needs_review (never a fabricated FAIL) when no structured proposal is attached", async () => {
    const posted: CitationRepairCardComment[] = [];
    const disposition = await citationRepairDisposition(
      { id: "run-x", jobId: "job-x", result: {} },
      CITATION_JOB,
      { postComment: (c) => posted.push(c) }
    );
    expect(disposition.verdict).toBe("needs_review");
    expect(disposition.reason).toBe("unanalyzable");
    expect(disposition.signals).toEqual([]);
    expect(posted).toHaveLength(1);
  });
});

// ── structured block survives a PR-1 report round-trip ──────────────

describe("toCitationRepairAnalysis", () => {
  it("extracts counts, findings, and changes from a raw dry-run result", () => {
    const a = toCitationRepairAnalysis(DEFECTIVE_RAW);
    expect(a.deadLinkCitations).toBe(0);
    expect(a.totalCitations).toBe(9);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]!.problem).toBe("weak_source");
    expect(a.changes[0]!.change_type).toBe("replace_citation");
    expect(a.jobId).toBe("wiki-en-62871101");
    expect(a.runId).toBe("wiki-en-62871101-citation-repair-hash-r3");
  });

  it("is idempotent on an already-structured analysis (the run.result.citationRepair block)", () => {
    const once = toCitationRepairAnalysis(DEFECTIVE_RAW);
    const twice = toCitationRepairAnalysis(once);
    expect(twice.deadLinkCitations).toBe(0);
    expect(twice.findings).toHaveLength(1);
    expect(twice.changes[0]!.replacement_text).toContain("archived source");
  });
});
