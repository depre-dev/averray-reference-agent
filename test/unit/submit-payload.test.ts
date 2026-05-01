import { describe, expect, it } from "vitest";

import { buildSubmitRequestBody } from "../../packages/averray-mcp/src/submit-payload.js";

describe("submit payload", () => {
  it("sends structured output directly as the Averray submission", () => {
    const output = {
      page_title: "(Hash)",
      revision_id: "1351905908",
      citation_findings: [
        {
          section: "Charts",
          problem: "dead_link",
          current_claim: "Billboard Heatseekers chart entry",
          evidence_url: "https://web.archive.org/example"
        }
      ],
      proposed_changes: [
        {
          change_type: "replace_citation",
          target_text: "https://www.billboard.com/artist/Loona/chart-history/TLN",
          replacement_text: "Add archive URL to the existing chart citation",
          source_url: "https://web.archive.org/example"
        }
      ],
      review_notes: "Averray-attributed proposal only; no Wikipedia edit was made."
    };

    expect(buildSubmitRequestBody({ sessionId: "job:0xabc", output })).toEqual({
      sessionId: "job:0xabc",
      submission: output
    });
  });

  it("does not wrap output in submission.output metadata", () => {
    const output = {
      page_title: "(Hash)",
      revision_id: "1351905908",
      citation_findings: [],
      proposed_changes: [],
      review_notes: "Proposal only."
    };

    const body = buildSubmitRequestBody({ sessionId: "job:0xabc", output });

    expect(body.submission).not.toHaveProperty("output");
    expect(body.submission).not.toHaveProperty("jobId");
    expect(body.submission).not.toHaveProperty("submittedAt");
    expect(body.submission).not.toHaveProperty("idempotencyKey");
  });
});
