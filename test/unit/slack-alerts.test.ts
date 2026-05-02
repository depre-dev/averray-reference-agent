import { describe, expect, it } from "vitest";

import {
  buildSlackPayload,
  validationFailureDetails,
} from "../../packages/averray-mcp/src/slack-alerts.js";

describe("Slack operational alerts", () => {
  it("formats claim alerts with identifiers and mutation budget state", () => {
    const payload = buildSlackPayload({
      kind: "claim_succeeded",
      title: "claim succeeded",
      identifiers: {
        jobId: "wiki-en-62871101-citation-repair-hash",
        runId: "controlled-wikipedia-hash-001",
        sessionId: "session-123",
        wallet: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
      },
      details: {
        claimDeadline: "2026-05-02T12:00:00.000Z",
        mutationBudgetConsumed: true,
      },
    });

    expect(payload.text).toContain("claim succeeded");
    expect(payload.text).toContain("wiki-en-62871101-citation-repair-hash");
    expect(payload.text).toContain("controlled-wikipedia-hash-001");
    expect(payload.text).toContain("session-123");
    expect(payload.text).toContain("mutationBudgetConsumed: `true`");
  });

  it("redacts secret-like fields and inline bearer/hex secrets", () => {
    const privateKey = `0x${"a".repeat(64)}`;
    const inlineHexSecret = `0x${"b".repeat(64)}`;
    const payload = buildSlackPayload({
      kind: "submit_failed",
      title: "submit failed",
      identifiers: {
        jobId: "job-1",
        authorization: "Bearer abc.def.ghi",
      },
      details: {
        privateKey,
        message: `server said Bearer abc.def.ghi and ${inlineHexSecret}`,
      },
    });

    expect(payload.text).toContain("[redacted]");
    expect(payload.text).toContain("Bearer [redacted]");
    expect(payload.text).toContain("[redacted-hex-secret]");
    expect(payload.text).not.toContain("abc.def.ghi");
    expect(payload.text).not.toContain("aaaaaaaaaaaaaaaa");
    expect(payload.text).not.toContain("bbbbbbbbbbbbbbbb");
  });

  it("summarizes local validation failures with actionable JSON paths", () => {
    const details = validationFailureDetails({
      valid: false,
      validator: "wikipedia",
      taskType: "citation_repair",
      errors: [
        {
          path: "citation_findings.0.citation_number",
          code: "unrecognized_keys",
          message: "citation_findings.0.citation_number is not allowed",
        },
      ],
    });

    expect(details).toEqual({
      validator: "wikipedia",
      taskType: "citation_repair",
      errorCount: 1,
      paths: ["citation_findings.0.citation_number"],
      messages: [
        "citation_findings.0.citation_number: citation_findings.0.citation_number is not allowed",
      ],
    });
  });
});
