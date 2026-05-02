import { optionalEnv } from "@avg/mcp-common";

export type EvidenceFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RevisionFetchInput {
  title: string;
  revisionId: string;
  format?: "wikitext" | "html" | "references";
  maxBytes?: number;
  fetchImpl?: EvidenceFetch;
}

export interface CitationExtractionInput {
  title: string;
  revisionId: string;
  maxCitations?: number;
  maxContextChars?: number;
  fetchImpl?: EvidenceFetch;
}

export interface SourceUrlCheckInput {
  url: string;
  expectedHost?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxSnippetChars?: number;
  fetchImpl?: EvidenceFetch;
}

export interface ArchiveSnapshotInput {
  url: string;
  timestampHint?: string;
  timeoutMs?: number;
  fetchImpl?: EvidenceFetch;
}

export interface WikipediaCitation {
  index: number;
  referenceId?: string;
  templateNames: string[];
  urls: string[];
  archiveUrls: string[];
  deadLinkMarkers: string[];
  accessDates: string[];
  title?: string;
  context: string;
}

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_OLDID_BASE = "https://en.wikipedia.org/w/index.php";
const WAYBACK_AVAILABLE = "https://archive.org/wayback/available";
const DEFAULT_USER_AGENT =
  "AverrayReferenceAgent/0.1 (+https://github.com/depre-dev/averray-reference-agent; read-only evidence helper)";

export function buildWikipediaRevisionApiUrl(input: {
  revisionId: string;
  format?: "wikitext";
}): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "revisions",
    revids: input.revisionId,
    rvprop: "ids|timestamp|content|contentmodel|size|sha1",
    rvslots: "main",
    origin: "*",
  });
  return `${WIKIPEDIA_API}?${params.toString()}`;
}

export function buildWikipediaRevisionHtmlApiUrl(revisionId: string): string {
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    formatversion: "2",
    oldid: revisionId,
    prop: "text|revid|displaytitle",
    origin: "*",
  });
  return `${WIKIPEDIA_API}?${params.toString()}`;
}

export function buildWikipediaRevisionUrl(title: string, revisionId: string): string {
  const params = new URLSearchParams({ title, oldid: revisionId });
  return `${WIKIPEDIA_OLDID_BASE}?${params.toString()}`;
}

export async function fetchWikipediaRevision(input: RevisionFetchInput) {
  const format = input.format ?? "wikitext";
  if (format === "html") {
    const fetched = await fetchRevisionHtml(input);
    return {
      ...fetched,
      format,
      content: limitText(fetched.content, input.maxBytes ?? defaultMaxBytes()),
      truncated: byteLength(fetched.content) > (input.maxBytes ?? defaultMaxBytes()),
    };
  }
  const fetched = await fetchRevisionWikitext(input);
  if (format === "references") {
    return {
      ...withoutContent(fetched),
      references: extractWikipediaCitationsFromWikitext(fetched.content, {
        maxCitations: 50,
        maxContextChars: 240,
      }),
    };
  }
  return {
    ...withoutContent(fetched),
    format,
    content: limitText(fetched.content, input.maxBytes ?? defaultMaxBytes()),
    truncated: byteLength(fetched.content) > (input.maxBytes ?? defaultMaxBytes()),
  };
}

export async function extractWikipediaCitations(input: CitationExtractionInput) {
  const fetched = await fetchRevisionWikitext(input);
  const citations = extractWikipediaCitationsFromWikitext(fetched.content, {
    maxCitations: input.maxCitations ?? 80,
    maxContextChars: input.maxContextChars ?? 240,
  });
  return {
    ...withoutContent(fetched),
    count: citations.length,
    citations,
    truncated: citations.length >= (input.maxCitations ?? 80),
  };
}

export function extractWikipediaCitationsFromWikitext(
  wikitext: string,
  options: { maxCitations: number; maxContextChars: number }
): WikipediaCitation[] {
  const citations: WikipediaCitation[] = [];
  const refPattern = /<ref\b([^>/]*?)(?:\/>|>([\s\S]*?)<\/ref>)/gi;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(wikitext)) && citations.length < options.maxCitations) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const raw = match[0];
    const context = contextAround(wikitext, match.index, raw.length, options.maxContextChars);
    const templateNames = extractTemplateNames(body);
    const bareUrls = extractBareUrls(body);
    const urls = unique([...extractTemplateParamValues(body, ["url"]), ...bareUrls])
      .filter((url) => !isArchiveUrl(url));
    const archiveUrls = unique([
      ...extractTemplateParamValues(body, ["archive-url", "archiveurl"]),
      ...bareUrls.filter((url) => isArchiveUrl(url)),
    ]);
    citations.push({
      index: citations.length + 1,
      ...optionalString("referenceId", extractRefName(attrs)),
      templateNames,
      urls,
      archiveUrls,
      deadLinkMarkers: extractDeadLinkMarkers(`${body}\n${context}`),
      accessDates: extractTemplateParamValues(body, ["access-date", "accessdate"]),
      ...optionalString("title", firstTemplateParamValue(body, ["title"])),
      context,
    });
  }
  return citations;
}

export async function checkSourceUrl(input: SourceUrlCheckInput) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "user-agent": input.userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  };
  const response = await fetchImpl(input.url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? defaultTimeoutMs()),
    headers,
  });
  const finalUrl = response.url || input.url;
  const contentType = response.headers.get("content-type") ?? undefined;
  const text = isTextLike(contentType) ? await response.text().catch(() => "") : "";
  return {
    url: input.url,
    finalUrl,
    status: response.status,
    ok: response.ok,
    redirected: finalUrl !== input.url || response.redirected,
    expectedHost: input.expectedHost ?? null,
    expectedHostMatched: input.expectedHost ? hostMatches(finalUrl, input.expectedHost) : null,
    contentType: contentType ?? null,
    title: text ? extractHtmlTitle(text) : null,
    snippet: text ? extractSnippet(text, input.maxSnippetChars ?? 280) : null,
    archiveHints: {
      isArchiveUrl: isArchiveUrl(finalUrl),
      waybackAvailabilityUrl: buildWaybackAvailabilityUrl(input.url),
    },
    elapsedMs: Date.now() - startedAt,
  };
}

export async function findArchiveSnapshot(input: ArchiveSnapshotInput) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiUrl = buildWaybackAvailabilityUrl(input.url, input.timestampHint);
  const response = await fetchImpl(apiUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? defaultTimeoutMs()),
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  const closest = readClosestSnapshot(payload);
  return {
    url: input.url,
    timestampHint: input.timestampHint ?? null,
    lookupUrl: apiUrl,
    status: response.status,
    available: closest?.available === true,
    candidates: closest?.available === true ? [closest] : [],
  };
}

export function buildWaybackAvailabilityUrl(url: string, timestampHint?: string): string {
  const params = new URLSearchParams({ url });
  const timestamp = normalizeWaybackTimestamp(timestampHint);
  if (timestamp) params.set("timestamp", timestamp);
  return `${WAYBACK_AVAILABLE}?${params.toString()}`;
}

async function fetchRevisionWikitext(input: RevisionFetchInput | CitationExtractionInput) {
  const response = await (input.fetchImpl ?? fetch)(buildWikipediaRevisionApiUrl({ revisionId: input.revisionId }), {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(defaultTimeoutMs()),
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/json",
    },
  });
  const payload = await response.json();
  const page = payload?.query?.pages?.[0];
  const revision = page?.revisions?.[0];
  const content = revision?.slots?.main?.content ?? revision?.content;
  if (!page || !revision || typeof content !== "string") {
    throw new Error("wikipedia_revision_not_found_or_missing_content");
  }
  const exactTitle = typeof page.title === "string" ? page.title : input.title;
  const revisionId = String(revision.revid ?? input.revisionId);
  return {
    title: exactTitle,
    requestedTitle: input.title,
    revisionId,
    revisionUrl: buildWikipediaRevisionUrl(exactTitle, revisionId),
    apiUrl: buildWikipediaRevisionApiUrl({ revisionId }),
    timestamp: revision.timestamp ?? null,
    size: revision.size ?? byteLength(content),
    sha1: revision.sha1 ?? null,
    content,
  };
}

async function fetchRevisionHtml(input: RevisionFetchInput) {
  const apiUrl = buildWikipediaRevisionHtmlApiUrl(input.revisionId);
  const response = await (input.fetchImpl ?? fetch)(apiUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(defaultTimeoutMs()),
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/json",
    },
  });
  const payload = await response.json();
  const parse = payload?.parse;
  const html = parse?.text;
  if (!parse || typeof html !== "string") {
    throw new Error("wikipedia_revision_not_found_or_missing_html");
  }
  const title = typeof parse.title === "string" ? parse.title : input.title;
  const revisionId = String(parse.revid ?? input.revisionId);
  return {
    title,
    requestedTitle: input.title,
    revisionId,
    revisionUrl: buildWikipediaRevisionUrl(title, revisionId),
    apiUrl,
    timestamp: null,
    size: byteLength(html),
    sha1: null,
    content: html,
  };
}

function withoutContent(input: Awaited<ReturnType<typeof fetchRevisionWikitext>>) {
  const { content: _content, ...rest } = input;
  return rest;
}

function extractTemplateNames(text: string): string[] {
  const names = [...text.matchAll(/\{\{\s*([^|{}\n]+)(?:\||\}\})/g)]
    .map((match) => cleanWikiValue(match[1]))
    .filter(Boolean);
  return unique(names);
}

function extractTemplateParamValues(text: string, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const pattern = new RegExp(`\\|\\s*${escapeRegex(key)}\\s*=\\s*([^|}\\n]+)`, "gi");
    for (const match of text.matchAll(pattern)) {
      const value = cleanWikiValue(match[1]);
      if (value) values.push(value);
    }
  }
  return unique(values);
}

function firstTemplateParamValue(text: string, keys: string[]): string | undefined {
  return extractTemplateParamValues(text, keys)[0];
}

function extractBareUrls(text: string): string[] {
  return unique([...text.matchAll(/https?:\/\/[^\s<>{}|[\]"']+/gi)].map((match) => cleanUrl(match[0])));
}

function extractDeadLinkMarkers(text: string): string[] {
  const markers: string[] = [];
  if (/\{\{\s*(dead link|link rot|bare url inline|citation needed)\b/i.test(text)) markers.push("maintenance_template");
  if (/\|\s*url-status\s*=\s*(dead|unfit|usurped)\b/i.test(text)) markers.push("url_status_dead");
  if (/\|\s*dead-?url\s*=\s*(yes|true)\b/i.test(text)) markers.push("dead_url_yes");
  if (/\b404\b|\bnot found\b|\bdead link\b/i.test(text)) markers.push("context_dead_link_text");
  return unique(markers);
}

function extractRefName(attrs: string): string | undefined {
  const quoted = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
  if (quoted) return cleanWikiValue(quoted);
  return attrs.match(/\bname\s*=\s*([^\s/>]+)/i)?.[1];
}

function contextAround(text: string, index: number, length: number, maxChars: number): string {
  const half = Math.max(20, Math.floor(maxChars / 2));
  const start = Math.max(0, index - half);
  const end = Math.min(text.length, index + length + half);
  return cleanWikiValue(text.slice(start, end)).slice(0, maxChars);
}

function extractHtmlTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeHtml(stripTags(title)).slice(0, 180) : null;
}

function extractSnippet(text: string, maxChars: number): string {
  return decodeHtml(stripTags(text)).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function readClosestSnapshot(payload: unknown) {
  if (!isRecord(payload)) return undefined;
  const archived = isRecord(payload.archived_snapshots) ? payload.archived_snapshots : undefined;
  const closest = isRecord(archived?.closest) ? archived.closest : undefined;
  if (!closest || typeof closest.url !== "string") return undefined;
  return {
    archiveUrl: closest.url,
    timestamp: typeof closest.timestamp === "string" ? closest.timestamp : null,
    status: typeof closest.status === "string" ? closest.status : null,
    available: closest.available === true,
  };
}

function normalizeWaybackTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 14) return digits.slice(0, 14);
  if (digits.length >= 8) return digits.slice(0, 8);
  if (digits.length >= 4) return digits.slice(0, 4);
  return undefined;
}

function defaultMaxBytes(): number {
  return Number.parseInt(optionalEnv("AVERRAY_EVIDENCE_MAX_BYTES", "120000"), 10);
}

function defaultTimeoutMs(): number {
  return Number.parseInt(optionalEnv("AVERRAY_EVIDENCE_TIMEOUT_MS", "12000"), 10);
}

function limitText(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function hostMatches(url: string, expectedHost: string): boolean {
  const host = new URL(url).host.toLowerCase();
  const expected = expectedHost.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

function isArchiveUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "web.archive.org" || host.endsWith(".archive.org");
  } catch {
    return false;
  }
}

function isTextLike(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /text\/|json|xml|html|xhtml/i.test(contentType);
}

function cleanWikiValue(value: string | undefined): string {
  return (value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\{\{!}}\}/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(url: string): string {
  return url.replace(/[),.;]+$/g, "");
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function optionalString<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
