import { describe, expect, it } from "vitest";

import { extractWikipediaCitationsFromWikitext } from "../../packages/averray-mcp/src/wiki-evidence.js";
import { buildWikipediaCitationRepairProposal } from "../../packages/averray-mcp/src/job-workflows.js";
import { wikipediaCitationRepairOutputSchema } from "../../packages/schemas/src/wikipedia.js";

const EXTRACT_OPTS = { maxCitations: 80, maxContextChars: 240 };
const REVISION_URL = "https://en.wikipedia.org/w/index.php?title=(Hash)&oldid=1351905908";

// A Charts table whose Billboard rows carry {{dead link}} on {{album chart}}
// templates — the exact shape the <ref>-only extractor was blind to.
const CHARTS_WIKITEXT = `== Charts ==
{| class="wikitable"
|-
! Chart (2024) !! Peak
|-
| {{album chart|Billboard|artist=Foo|album=Bar|type=Heatseekers}}{{dead link|date=April 2024|bot=InternetArchiveBot}}
| 19
|-
| {{album chart|Billboard|artist=Foo|album=Bar|type=Independent}}{{dead link|date=April 2024|bot=InternetArchiveBot}}
| 44
|-
| {{album chart|Billboard|artist=Foo|album=Bar|type=World}}{{dead link|date=April 2024|bot=InternetArchiveBot}}
| 4
|}

== References ==
{{reflist}}`;

function chartsEvidence() {
  return {
    pageTitle: "(Hash)",
    revisionId: "1351905908",
    revisionUrl: REVISION_URL,
    citations: extractWikipediaCitationsFromWikitext(CHARTS_WIKITEXT, EXTRACT_OPTS),
    sourceChecks: [],
  };
}

describe("extractWikipediaCitationsFromWikitext — template-embedded dead links", () => {
  it("detects {{dead link}} on {{album chart}} rows outside <ref>, with section + coherent raw", () => {
    const citations = extractWikipediaCitationsFromWikitext(CHARTS_WIKITEXT, EXTRACT_OPTS);
    const dead = citations.filter((c) => c.deadLinkMarkers.length > 0);
    expect(dead.length).toBeGreaterThanOrEqual(3);
    for (const c of dead) {
      expect(c.section).toBe("Charts");
      expect(c.deadLinkMarkers).toContain("maintenance_template");
      expect(c.raw).toContain("album chart"); // coherent full row, not a slice
      expect(c.raw).toContain("dead link");
    }
  });

  it("does not double-count a {{dead link}} that sits inside a <ref>", () => {
    const citations = extractWikipediaCitationsFromWikitext(
      `Body.<ref>{{dead link|date=May 2026}}{{cite news |url=https://example.com/story}}</ref>`,
      EXTRACT_OPTS
    );
    expect(citations).toHaveLength(1); // the <ref> pass owns it; the template pass skips it
    expect(citations[0]!.deadLinkMarkers).toContain("maintenance_template");
  });
});

describe("buildWikipediaCitationRepairProposal — Charts dead links", () => {
  it("reports >=3 dead_link findings in Charts with coherent target_text and no live-source noise", () => {
    const { output, confidence } = buildWikipediaCitationRepairProposal({}, chartsEvidence());
    const findings = output.citation_findings as Array<Record<string, unknown>>;
    const changes = output.proposed_changes as Array<Record<string, unknown>>;

    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.every((f) => f.problem === "dead_link")).toBe(true);
    expect(findings.every((f) => f.section === "Charts")).toBe(true);
    expect(findings.every((f) => String(f.current_claim).includes("album chart"))).toBe(true);
    // No weak_source noise on a dead-link job.
    expect(findings.some((f) => f.problem === "weak_source")).toBe(false);
    // No archivable URL here → honest editor flags, never an asserted archive.
    expect(changes.every((c) => c.change_type === "flag_for_editor_review")).toBe(true);
    expect(confidence).toBeLessThan(0.7); // dead links found but only editor flags → needs review
    expect(wikipediaCitationRepairOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe("buildWikipediaCitationRepairProposal — live sources are never flagged", () => {
  it("a live <ref> (200 / url-status=live) produces an honest empty proposal, not weak_source", () => {
    const citations = extractWikipediaCitationsFromWikitext(
      `Claim.<ref name="live">{{cite web |title=Live |url=https://live.example/x |access-date=2023-01-01}}</ref>`,
      EXTRACT_OPTS
    );
    const { output, confidence } = buildWikipediaCitationRepairProposal(
      {},
      {
        pageTitle: "Live Page",
        revisionId: "1",
        revisionUrl: REVISION_URL,
        citations,
        sourceChecks: [{ url: "https://live.example/x", status: 200, ok: true, finalUrl: "https://live.example/x", archiveUrl: null }],
      }
    );
    expect(output.citation_findings).toEqual([]);
    expect(output.proposed_changes).toEqual([]);
    expect(confidence).toBe(0.6);
    expect(String(output.review_notes)).toMatch(/no dead-link/i);
    // Top-level shape stays exactly the 5 allowed keys (no stray fields). The
    // full schema requires .min(1) on both arrays — i.e. you cannot SUBMIT a
    // no-op repair — so an honest empty proposal is intentionally not a valid
    // submission: the workflow declines to claim/submit it rather than
    // manufacturing a defect to satisfy the schema.
    expect(Object.keys(output).sort()).toEqual([
      "citation_findings",
      "page_title",
      "proposed_changes",
      "review_notes",
      "revision_id",
    ]);
    expect(wikipediaCitationRepairOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe("buildWikipediaCitationRepairProposal — applyable, honest archive fixes", () => {
  const deadCiteCitation = (over: Record<string, unknown> = {}) => ({
    index: 1,
    referenceId: "r",
    templateNames: ["cite web"],
    urls: ["https://dead.example/a"],
    archiveUrls: ["https://web.archive.org/web/20230115000000/https://dead.example/a"],
    deadLinkMarkers: ["url_status_dead"],
    accessDates: ["2023-01-10"],
    title: "A",
    context: "context",
    raw: '<ref name="r">{{cite web |title=A |url=https://dead.example/a |access-date=2023-01-10}}</ref>',
    section: "Reception",
    ...over,
  });

  function proposalFor(citation: Record<string, unknown>) {
    return buildWikipediaCitationRepairProposal(
      {},
      {
        pageTitle: "Album",
        revisionId: "1",
        revisionUrl: REVISION_URL,
        citations: [citation as never],
        sourceChecks: [{ url: "https://dead.example/a", status: 404, ok: false, finalUrl: "https://dead.example/a", archiveUrl: "https://web.archive.org/web/20230115000000/https://dead.example/a" }],
      }
    );
  }

  it("emits applyable wikitext (archive-url/date/url-status=dead) when a plausible snapshot supports the cited date", () => {
    const { output, confidence } = proposalFor(deadCiteCitation());
    const change = (output.proposed_changes as Array<Record<string, unknown>>)[0]!;
    expect(change.change_type).toBe("replace_citation");
    expect(String(change.replacement_text)).toContain("{{cite web");
    expect(String(change.replacement_text)).toContain("|archive-url=https://web.archive.org/web/20230115000000/https://dead.example/a");
    expect(String(change.replacement_text)).toContain("|archive-date=2023-01-15");
    expect(String(change.replacement_text)).toContain("|url-status=dead");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
    expect(wikipediaCitationRepairOutputSchema.safeParse(output).success).toBe(true);
  });

  it("flags instead of asserting when there is no cited date to verify the snapshot against", () => {
    // No access-date → we cannot verify the snapshot supports the claim → flag.
    const { output } = proposalFor(deadCiteCitation({ accessDates: [], raw: '<ref name="r">{{cite web |title=A |url=https://dead.example/a}}</ref>' }));
    const change = (output.proposed_changes as Array<Record<string, unknown>>)[0]!;
    expect(change.change_type).toBe("flag_for_editor_review");
    expect(String(change.replacement_text)).toMatch(/not verified|confirm/i);
    expect(wikipediaCitationRepairOutputSchema.safeParse(output).success).toBe(true);
  });
});
