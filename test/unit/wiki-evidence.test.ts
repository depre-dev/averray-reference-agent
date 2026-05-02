import { describe, expect, it } from "vitest";

import {
  buildWaybackAvailabilityUrl,
  buildWikipediaRevisionApiUrl,
  checkSourceUrl,
  extractWikipediaCitationsFromWikitext,
  fetchWikipediaRevision,
  findArchiveSnapshot,
  type EvidenceFetch,
} from "../../packages/averray-mcp/src/wiki-evidence.js";

describe("Wikipedia evidence helpers", () => {
  it("constructs a pinned revision fetch URL", () => {
    const url = new URL(buildWikipediaRevisionApiUrl({ revisionId: "1351905437" }));

    expect(url.origin).toBe("https://en.wikipedia.org");
    expect(url.pathname).toBe("/w/api.php");
    expect(url.searchParams.get("action")).toBe("query");
    expect(url.searchParams.get("revids")).toBe("1351905437");
    expect(url.searchParams.get("rvslots")).toBe("main");
    expect(url.searchParams.get("rvprop")).toContain("content");
  });

  it("fetches a pinned revision with bounded output", async () => {
    const longContent = "A".repeat(200);
    const fetchImpl: EvidenceFetch = async (url) =>
      jsonResponse(url, {
        query: {
          pages: [
            {
              title: "Album",
              revisions: [
                {
                  revid: 123,
                  timestamp: "2026-05-01T00:00:00Z",
                  size: longContent.length,
                  sha1: "abc",
                  slots: { main: { content: longContent } },
                },
              ],
            },
          ],
        },
      });

    const revision = await fetchWikipediaRevision({
      title: "Album",
      revisionId: "123",
      maxBytes: 40,
      fetchImpl,
    });

    expect(revision.title).toBe("Album");
    expect(revision.revisionId).toBe("123");
    expect(revision.content.length).toBe(40);
    expect(revision.truncated).toBe(true);
    expect(revision.revisionUrl).toContain("oldid=123");
  });

  it("extracts citation URLs, archive URLs, and dead-link markers", () => {
    const citations = extractWikipediaCitationsFromWikitext(
      `Some sentence.<ref name="review">{{cite web |title=Review |url=https://dead.example/review |archive-url=https://web.archive.org/web/20200101000000/https://dead.example/review |access-date=2020-01-02 |url-status=dead}}</ref>
       Another sentence.<ref>{{dead link|date=May 2026}}{{cite news |url=https://example.com/story}}</ref>`,
      { maxCitations: 10, maxContextChars: 180 }
    );

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      referenceId: "review",
      templateNames: ["cite web"],
      urls: ["https://dead.example/review"],
      archiveUrls: ["https://web.archive.org/web/20200101000000/https://dead.example/review"],
      accessDates: ["2020-01-02"],
      title: "Review",
    });
    expect(citations[0].deadLinkMarkers).toContain("url_status_dead");
    expect(citations[1].deadLinkMarkers).toContain("maintenance_template");
  });

  it("normalizes URL status, redirect, host match, title, and snippet", async () => {
    const fetchImpl: EvidenceFetch = async () =>
      textResponse("https://www.example.com/final", "<html><head><title>Example Title</title></head><body>Hello world source page</body></html>", {
        status: 200,
        contentType: "text/html; charset=utf-8",
        redirected: true,
      });

    const result = await checkSourceUrl({
      url: "https://example.com/start",
      expectedHost: "example.com",
      fetchImpl,
    });

    expect(result).toMatchObject({
      url: "https://example.com/start",
      finalUrl: "https://www.example.com/final",
      status: 200,
      ok: true,
      redirected: true,
      expectedHostMatched: true,
      contentType: "text/html; charset=utf-8",
      title: "Example Title",
    });
    expect(result.snippet).toContain("Hello world");
    expect(result.archiveHints.waybackAvailabilityUrl).toContain("archive.org/wayback/available");
  });

  it("finds a Wayback snapshot candidate", async () => {
    const fetchImpl: EvidenceFetch = async (url) =>
      jsonResponse(url, {
        archived_snapshots: {
          closest: {
            available: true,
            url: "https://web.archive.org/web/20200101000000/https://example.com/story",
            timestamp: "20200101000000",
            status: "200",
          },
        },
      });

    const result = await findArchiveSnapshot({
      url: "https://example.com/story",
      timestampHint: "2020-01-02",
      fetchImpl,
    });

    expect(result.available).toBe(true);
    expect(result.lookupUrl).toBe(
      buildWaybackAvailabilityUrl("https://example.com/story", "2020-01-02")
    );
    expect(result.candidates[0]).toMatchObject({
      archiveUrl: "https://web.archive.org/web/20200101000000/https://example.com/story",
      timestamp: "20200101000000",
      status: "200",
    });
  });

  it("reports absence of Wayback snapshots cleanly", async () => {
    const fetchImpl: EvidenceFetch = async (url) => jsonResponse(url, { archived_snapshots: {} });

    const result = await findArchiveSnapshot({
      url: "https://example.com/missing",
      fetchImpl,
    });

    expect(result.available).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});

function jsonResponse(url: string, body: unknown): Response {
  return withUrl(Response.json(body), url);
}

function textResponse(
  url: string,
  body: string,
  options: { status: number; contentType: string; redirected?: boolean }
): Response {
  return withUrl(
    new Response(body, {
      status: options.status,
      headers: { "content-type": options.contentType },
    }),
    url,
    options.redirected ?? false
  );
}

function withUrl(response: Response, url: string, redirected = false): Response {
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: redirected });
  return response;
}
