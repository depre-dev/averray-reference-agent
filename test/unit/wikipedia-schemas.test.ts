import { describe, expect, it } from "vitest";
import {
  validateWikipediaOutput,
  wikipediaCitationRepairOutputSchema,
  wikipediaFreshnessCheckOutputSchema
} from "../../packages/schemas/src/wikipedia.js";

describe("Wikipedia output schemas", () => {
  it("accepts citation repair output", () => {
    const payload = {
      page_title: "Example article",
      revision_id: "123",
      citation_findings: [
        {
          section: "History",
          problem: "dead_link",
          current_claim: "A claim with a dead source.",
          evidence_url: "https://example.com/source"
        }
      ],
      proposed_changes: [
        {
          change_type: "replace_citation",
          target_text: "old citation",
          replacement_text: "new citation",
          source_url: "https://example.com/source"
        }
      ],
      review_notes: "Editor should verify source reliability before publishing."
    };
    expect(wikipediaCitationRepairOutputSchema.parse(payload)).toEqual(payload);
    expect(validateWikipediaOutput("citation_repair", payload)).toEqual(payload);
  });

  it("rejects freshness output with missing required findings", () => {
    expect(() =>
      wikipediaFreshnessCheckOutputSchema.parse({
        page_title: "Example",
        revision_id: "123",
        freshness_findings: [],
        recommended_editor_actions: ["Review"],
        risk_level: "low"
      })
    ).toThrow();
  });
});

