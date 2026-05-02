import { describe, expect, it } from "vitest";
import {
  selectValidator,
  validateSubmissionLocally,
} from "../../packages/averray-mcp/src/validate-submission.js";

const wikipediaCitationRepairDefinition = {
  source: { type: "wikipedia_article", taskType: "citation_repair" },
};

const validCitationRepairOutput = {
  page_title: "Polkadot (cryptocurrency)",
  revision_id: "1351905437",
  citation_findings: [
    {
      section: "Funding",
      problem: "outdated_source" as const,
      current_claim: "Funding round figures are out of date.",
      evidence_url: "https://example.com/2025-audit",
    },
  ],
  proposed_changes: [
    {
      change_type: "replace_citation" as const,
      target_text: "old citation",
      replacement_text: "new citation",
      source_url: "https://example.com/2025-audit",
    },
  ],
  review_notes: "Editor should verify source reliability before publishing.",
};

describe("selectValidator", () => {
  it("picks the Wikipedia validator from a wikipedia_article job definition", () => {
    expect(selectValidator(wikipediaCitationRepairDefinition)).toEqual({
      validator: "wikipedia",
      taskType: "citation_repair",
    });
  });

  it("falls back to permissive when source kind isn't a Wikipedia article", () => {
    expect(
      selectValidator({ source: { type: "github_issue", repo: "x/y", issueNumber: 1 } })
    ).toEqual({ validator: "permissive" });
  });

  it("falls back to permissive when no source is present", () => {
    expect(selectValidator({})).toEqual({ validator: "permissive" });
    expect(selectValidator(null)).toEqual({ validator: "permissive" });
  });

  it("reads task type from publicDetails when source.taskType is missing", () => {
    expect(
      selectValidator({
        source: { type: "wikipedia_article" },
        publicDetails: { source: "wikipedia", taskType: "freshness_check" },
      })
    ).toEqual({ validator: "wikipedia", taskType: "freshness_check" });
  });
});

describe("validateSubmissionLocally — Wikipedia citation_repair", () => {
  it("rejects a proposal that adds an extra nested field (citation_number) with an actionable path", () => {
    const output = {
      ...validCitationRepairOutput,
      citation_findings: [
        {
          ...validCitationRepairOutput.citation_findings[0],
          citation_number: 1, // ← the bug from the reference run
        },
      ],
    };
    const result = validateSubmissionLocally(
      wikipediaCitationRepairDefinition,
      output
    );
    expect(result.valid).toBe(false);
    expect(result.validator).toBe("wikipedia");
    expect(result.taskType).toBe("citation_repair");
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const issue = result.errors![0];
    expect(issue.code).toBe("unrecognized_keys");
    expect(issue.path).toBe("citation_findings.0.citation_number");
    expect(issue.message).toContain("citation_findings.0.citation_number");
    expect(issue.message).toContain("not allowed");
  });

  it("accepts a valid Wikipedia citation-repair proposal", () => {
    const result = validateSubmissionLocally(
      wikipediaCitationRepairDefinition,
      validCitationRepairOutput
    );
    expect(result).toEqual({
      valid: true,
      validator: "wikipedia",
      taskType: "citation_repair",
    });
  });

  it("flags missing required top-level fields with their JSON path", () => {
    const result = validateSubmissionLocally(wikipediaCitationRepairDefinition, {
      page_title: "Polkadot",
      revision_id: "123",
      // citation_findings + proposed_changes + review_notes missing
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    const paths = result.errors!.map((e) => e.path);
    expect(paths).toContain("citation_findings");
    expect(paths).toContain("proposed_changes");
    expect(paths).toContain("review_notes");
  });

  it("rejects an unknown problem enum value with the offending path", () => {
    const output = {
      ...validCitationRepairOutput,
      citation_findings: [
        {
          ...validCitationRepairOutput.citation_findings[0],
          problem: "made_up_reason",
        },
      ],
    };
    const result = validateSubmissionLocally(
      wikipediaCitationRepairDefinition,
      output
    );
    expect(result.valid).toBe(false);
    const issue = result.errors!.find(
      (e) => e.path === "citation_findings.0.problem"
    );
    expect(issue).toBeDefined();
  });
});

describe("validateSubmissionLocally — non-Wikipedia sources", () => {
  it("returns permissive valid for source kinds without a local schema", () => {
    const result = validateSubmissionLocally(
      { source: { type: "open_data_dataset" } },
      { whatever: "the agent submits" }
    );
    expect(result).toEqual({ valid: true, validator: "permissive" });
  });

  it("returns permissive valid for unknown Wikipedia task types", () => {
    const result = validateSubmissionLocally(
      { source: { type: "wikipedia_article", taskType: "future_task_we_dont_have_a_schema_for" } },
      { whatever: "the agent submits" }
    );
    expect(result.valid).toBe(true);
    expect(result.validator).toBe("permissive");
    expect(result.taskType).toBe("future_task_we_dont_have_a_schema_for");
  });
});
