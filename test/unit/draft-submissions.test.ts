import { describe, expect, it } from "vitest";

import {
  buildDraftId,
  getDraftSubmission,
  normalizeDraftOutput,
  saveDraftSubmission,
  type DraftQueryFn,
} from "../../packages/averray-mcp/src/draft-submissions.js";
import { validateSubmissionLocally } from "../../packages/averray-mcp/src/validate-submission.js";

const jobId = "wiki-en-45188030-citation-repair-album";
const runId = "controlled-wikipedia-album-001";
const sessionId =
  "wiki-en-45188030-citation-repair-album:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05";

const wikipediaCitationRepairDefinition = {
  source: { type: "wikipedia_article", taskType: "citation_repair" },
};

const proposal = {
  page_title: "Album",
  revision_id: "123456789",
  citation_findings: [
    {
      section: "Reception",
      problem: "dead_link" as const,
      current_claim: "A review citation is dead.",
      evidence_url: "https://example.com/archive",
    },
  ],
  proposed_changes: [
    {
      change_type: "replace_citation" as const,
      target_text: "dead citation",
      replacement_text: "archived citation",
      source_url: "https://web.archive.org/example",
    },
  ],
  review_notes: "Averray-attributed proposal only. No Wikipedia edit was made.",
};

describe("draft submissions", () => {
  it("saves and loads the exact structured proposal object", async () => {
    const db = memoryDraftDb();
    const saved = await saveDraftSubmission({ runId, jobId, sessionId, output: proposal }, db.query);
    const loaded = await getDraftSubmission({ runId, jobId, sessionId }, db.query);
    const resumedBySession = await getDraftSubmission({ sessionId }, db.query);

    expect(loaded.draftId).toBe(saved.draftId);
    expect(loaded.output).toEqual(proposal);
    expect(resumedBySession.output).toEqual(proposal);
    expect(loaded.proposalOnly).toBe(true);
    expect(loaded.noWikipediaEdit).toBe(true);
    expect(loaded.outputHash).toBe(saved.outputHash);
  });

  it("lets a resumed validation path use the persisted object shape", async () => {
    const db = memoryDraftDb();
    await saveDraftSubmission({ runId, jobId, sessionId, output: proposal }, db.query);

    const loaded = await getDraftSubmission({ runId, jobId, sessionId }, db.query);
    const validation = validateSubmissionLocally(wikipediaCitationRepairDefinition, loaded.output);

    expect(typeof loaded.output).toBe("object");
    expect(Array.isArray(loaded.output)).toBe(false);
    expect(validation).toEqual({
      valid: true,
      validator: "wikipedia",
      taskType: "citation_repair",
    });
  });

  it("parses stringified JSON objects before validation code sees them", () => {
    const normalized = normalizeDraftOutput(JSON.stringify(proposal));

    expect(normalized.warning).toBe("parsed_stringified_json_object");
    expect(normalized.output).toEqual(proposal);
  });

  it("rejects non-JSON strings with an actionable error", () => {
    expect(() => normalizeDraftOutput("page_title: Album")).toThrow(
      /draft_submission_output_must_be_object/
    );
  });

  it("fails closed when a draftId lookup has a session mismatch", async () => {
    const db = memoryDraftDb();
    const saved = await saveDraftSubmission({ runId, jobId, sessionId, output: proposal }, db.query);

    await expect(
      getDraftSubmission({ draftId: saved.draftId, jobId, sessionId: `${sessionId}-typo` }, db.query)
    ).rejects.toThrow(/draft_lookup_mismatch: sessionId/);
  });

  it("rejects secret-like keys before persisting the draft", async () => {
    const db = memoryDraftDb();

    await expect(
      saveDraftSubmission(
        { runId, jobId, sessionId, output: { ...proposal, private_key: "0xabc" } },
        db.query
      )
    ).rejects.toThrow(/draft_contains_secret_like_key/);
  });
});

function memoryDraftDb(): { query: DraftQueryFn } {
  const rows = new Map<string, DraftRow>();
  const now = "2026-05-02T14:00:00.000Z";
  const query: DraftQueryFn = async <T>(text: string, values: unknown[] = []) => {
    if (text.includes("insert into draft_submissions")) {
      const [draftId, rowRunId, rowJobId, rowSessionId, outputJson, outputHash, outputBytes] = values;
      const existing = rows.get(String(draftId));
      const row: DraftRow = {
        draft_id: String(draftId),
        run_id: typeof rowRunId === "string" ? rowRunId : null,
        job_id: String(rowJobId),
        session_id: typeof rowSessionId === "string" ? rowSessionId : null,
        output: JSON.parse(String(outputJson)),
        output_hash: String(outputHash),
        output_bytes: Number(outputBytes),
        proposal_only: true,
        no_wikipedia_edit: true,
        validation_status: "unvalidated",
        validation_result: {},
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      rows.set(row.draft_id, row);
      return [row] as T[];
    }

    if (text.includes("where draft_id = $1")) {
      return [rows.get(String(values[0]))].filter(Boolean) as T[];
    }

    if (text.includes("from draft_submissions")) {
      const result = [...rows.values()].find((row) => {
        let cursor = 0;
        if (text.includes("job_id =")) {
          if (row.job_id !== values[cursor]) return false;
          cursor += 1;
        }
        if (text.includes("run_id =")) {
          if (row.run_id !== values[cursor]) return false;
          cursor += 1;
        }
        if (text.includes("session_id =")) {
          if (row.session_id !== values[cursor]) return false;
        }
        return true;
      });
      return [result].filter(Boolean) as T[];
    }

    if (text.includes("update draft_submissions")) {
      const [draftId, status, validationResultJson] = values;
      const row = rows.get(String(draftId));
      if (row) {
        row.validation_status = String(status);
        row.validation_result = JSON.parse(String(validationResultJson));
      }
      return [] as T[];
    }

    return [] as T[];
  };
  return { query };
}

interface DraftRow {
  draft_id: string;
  run_id: string | null;
  job_id: string;
  session_id: string | null;
  output: unknown;
  output_hash: string;
  output_bytes: number;
  proposal_only: boolean;
  no_wikipedia_edit: boolean;
  validation_status: string;
  validation_result: unknown;
  created_at: string;
  updated_at: string;
}
