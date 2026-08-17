// ARRIVALS — the platform's public MCP-front-door observatory.
//
// This is a cross-repo contract. The platform owns collection and serves
// `GET /monitor/arrivals`; Hermes reads that one public endpoint and renders
// the result. Nothing crossing that network boundary is trusted implicitly:
// malformed or unreachable data becomes an explicit `unavailable` block,
// never an empty funnel that could be mistaken for "nobody arrived".
//
// `funnel` is every call the platform saw, our own canaries and probes
// included. `funnelExternal` is the subset outsiders drove, and it is the only
// one a headline may render — a self-marked probe counted as an arrival
// manufactures demand evidence. Both are required: a platform that cannot
// supply the split cannot answer the question this panel asks, so the block
// becomes unavailable rather than falling back to the inflated total.
//
// `funnelAmbiguous` is traffic under a client name the platform ITSELF uses —
// our Claude session and a stranger's both declare `Anthropic/ClaudeAI`, so
// neither side can be claimed. It is OPTIONAL, and that is not the same laxity
// as above: a platform without it is one deployed before the bucket existed,
// and its `funnelExternal` is the number this panel has always rendered.
// Blanking the board over a deploy-order skew would be worse than showing it.
// Absent therefore stays ABSENT rather than becoming zero — a zero here is a
// measurement, and in that case we have not made one.

export const ARRIVALS_SCHEMA_VERSION = "averray.arrivals.v1";
export const ARRIVAL_STAGES = [
  "reached",
  "browsed",
  "evaluated",
  "identified",
  "authenticated",
  "claimed",
  "submitted",
] as const;

export type ArrivalStage = (typeof ARRIVAL_STAGES)[number];

export interface ArrivalAttributionCounts {
  siwe_wallet: number;
  client_name: number;
  ip_only: number;
}

export interface ArrivalAttributionSourceTotals {
  mcp: ArrivalAttributionCounts;
  http: ArrivalAttributionCounts;
}

export interface HttpArrivalCutover {
  atMs: number;
  at: string;
  backfilled: boolean;
  note: string;
}

export interface ArrivalClient {
  key: string;
  name: string | null;
  version: string | null;
  era: string | null;
  /** Declared as one of ours. Unmarked callers are external on purpose. */
  self: boolean;
  /** Declared under a name we also use, so neither side can be claimed. */
  ambiguous?: boolean;
  firstSeenMs: number;
  lastSeenMs: number;
  furthestStage: ArrivalStage;
  calls: number;
  tools: Record<string, number>;
}

export interface ArrivalsSnapshot {
  schemaVersion: typeof ARRIVALS_SCHEMA_VERSION;
  generatedAtMs?: number;
  observingSinceMs?: number;
  /** Every call, ours included. Never a headline on its own. */
  funnel: Record<ArrivalStage, number>;
  /** The subset outsiders drove — the only count that reads as demand. */
  funnelExternal: Record<ArrivalStage, number>;
  /** Our own probes, kept because confirming they ran is worth something. */
  funnelSelf: Record<ArrivalStage, number>;
  /**
   * Traffic we cannot attribute either way. Absent from a platform deployed
   * before the bucket existed — absent, never zero.
   */
  funnelAmbiguous?: Record<ArrivalStage, number>;
  /** HTTP is a separate front door; every field is absent on older producers. */
  funnelHttp?: Record<ArrivalStage, number>;
  funnelHttpExternal?: Record<ArrivalStage, number>;
  funnelHttpSelf?: Record<ArrivalStage, number>;
  funnelHttpAmbiguous?: Record<ArrivalStage, number>;
  attributionSourceTotals?: ArrivalAttributionSourceTotals;
  httpCutover?: HttpArrivalCutover;
  /**
   * The producer's verdict-first operator view (outsiders/ours/unknown with
   * furthest-ever and posted-work). Carried through opaquely: the panel owns
   * its shape, including the {unavailable} form. Absent from producers that
   * predate it — absent, never fabricated.
   */
  operatorView?: Record<string, unknown>;
  distinct: {
    declared: number;
    anonymous: number;
    self: number;
    ambiguous?: number;
    furthest: ArrivalStage;
    furthestExternal: ArrivalStage;
    furthestAmbiguous?: ArrivalStage;
  };
  clients: ArrivalClient[];
}

/** The platform snapshot verbatim, or why there is no reading. */
export type ArrivalsBlock = ArrivalsSnapshot | { unavailable: string };

export const ARRIVALS_FEED_TIMEOUT_MS = 4000;

export async function readArrivalsFeed(input: {
  /** The same public platform base used for `/health`. */
  baseUrl?: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<ArrivalsBlock> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    return { unavailable: "arrivals feed unreachable — platform API base URL is not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? ARRIVALS_FEED_TIMEOUT_MS);
  try {
    const url = new URL("/monitor/arrivals", `${baseUrl.replace(/\/+$/, "")}/`).toString();
    const response = await input.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return { unavailable: `arrivals feed unreachable — platform returned HTTP ${response.status}` };
    }
    return normalizeArrivalsFeed(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { unavailable: `arrivals feed unreachable — ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Shape-check the independently deployed producer before anything renders. */
export function normalizeArrivalsFeed(body: unknown): ArrivalsBlock {
  if (!body || typeof body !== "object") {
    return { unavailable: "arrivals feed unreadable — payload was not an object" };
  }
  const value = body as Record<string, unknown>;
  if (typeof value.unavailable === "string" && value.unavailable.trim()) {
    return { unavailable: `arrivals feed unavailable — ${value.unavailable.trim()}` };
  }
  if (value.schemaVersion !== ARRIVALS_SCHEMA_VERSION) {
    return {
      unavailable: `arrivals feed unreadable — expected schemaVersion ${ARRIVALS_SCHEMA_VERSION}`,
    };
  }

  const generatedAtMs = optionalCount(value.generatedAtMs);
  const observingSinceMs = optionalCount(value.observingSinceMs);
  if (generatedAtMs === null || observingSinceMs === null) {
    return { unavailable: "arrivals feed unreadable — source timestamps are invalid" };
  }

  const funnel = stageCounts(value.funnel, "funnel");
  if ("unavailable" in funnel) return funnel;
  const funnelExternal = stageCounts(value.funnelExternal, "funnelExternal");
  if ("unavailable" in funnelExternal) return funnelExternal;
  const funnelSelf = stageCounts(value.funnelSelf, "funnelSelf");
  if ("unavailable" in funnelSelf) return funnelSelf;
  // Optional, but malformed-when-present is still a producer we cannot read.
  const funnelAmbiguous =
    value.funnelAmbiguous === undefined
      ? undefined
      : stageCounts(value.funnelAmbiguous, "funnelAmbiguous");
  if (funnelAmbiguous && "unavailable" in funnelAmbiguous) return funnelAmbiguous;
  const ambiguousCounts = funnelAmbiguous && "counts" in funnelAmbiguous ? funnelAmbiguous.counts : undefined;

  // HTTP arrived later and remains optional across the independent platform
  // and board deploys. Present fields are real observations; absent fields
  // stay absent instead of being rewritten as zeroes.
  const funnelHttp = optionalStageCounts(value.funnelHttp, "funnelHttp");
  if (funnelHttp && "unavailable" in funnelHttp) return funnelHttp;
  const funnelHttpExternal = optionalStageCounts(value.funnelHttpExternal, "funnelHttpExternal");
  if (funnelHttpExternal && "unavailable" in funnelHttpExternal) return funnelHttpExternal;
  const funnelHttpSelf = optionalStageCounts(value.funnelHttpSelf, "funnelHttpSelf");
  if (funnelHttpSelf && "unavailable" in funnelHttpSelf) return funnelHttpSelf;
  const funnelHttpAmbiguous = optionalStageCounts(value.funnelHttpAmbiguous, "funnelHttpAmbiguous");
  if (funnelHttpAmbiguous && "unavailable" in funnelHttpAmbiguous) return funnelHttpAmbiguous;
  const httpCounts = funnelHttp && "counts" in funnelHttp ? funnelHttp.counts : undefined;
  const httpExternalCounts =
    funnelHttpExternal && "counts" in funnelHttpExternal ? funnelHttpExternal.counts : undefined;
  const httpSelfCounts = funnelHttpSelf && "counts" in funnelHttpSelf ? funnelHttpSelf.counts : undefined;
  const httpAmbiguousCounts =
    funnelHttpAmbiguous && "counts" in funnelHttpAmbiguous ? funnelHttpAmbiguous.counts : undefined;

  const attributionSourceTotals = normalizeAttributionSourceTotals(value.attributionSourceTotals);
  if (attributionSourceTotals && "unavailable" in attributionSourceTotals) return attributionSourceTotals;
  const httpCutover = normalizeHttpCutover(value.httpCutover);
  if (httpCutover && "unavailable" in httpCutover) return httpCutover;

  // External, self and ambiguous are disjoint subsets of the total, so no one
  // of them can exceed it and together they cannot either. A producer that
  // says otherwise is describing a funnel we do not understand, and the safe
  // reading of a funnel we do not understand is none at all.
  //
  // The check is an INEQUALITY, not an equality: calls the platform counted
  // before it split the funnel restore into the total alone, so the parts
  // legitimately fall short of the whole. Requiring them to add up would
  // reject every producer carrying real pre-split history.
  const incoherent = ARRIVAL_STAGES.find(
    (stage) =>
      funnelExternal.counts[stage] + funnelSelf.counts[stage] + (ambiguousCounts?.[stage] ?? 0) >
      funnel.counts[stage],
  );
  if (incoherent) {
    return {
      unavailable: `arrivals feed unreadable — ${incoherent} external plus self plus ambiguous exceeds the total`,
    };
  }

  // This is deliberately a second coherence check. HTTP is not part of the
  // MCP `funnel`, and comparing or summing the two doors would invent a
  // combined series that the producer does not report.
  const incoherentHttp = httpCounts && ARRIVAL_STAGES.find(
    (stage) =>
      (httpExternalCounts?.[stage] ?? 0) +
        (httpSelfCounts?.[stage] ?? 0) +
        (httpAmbiguousCounts?.[stage] ?? 0) >
      httpCounts[stage],
  );
  if (incoherentHttp) {
    return {
      unavailable: `arrivals feed unreadable — funnelHttp.${incoherentHttp} external plus self plus ambiguous exceeds the HTTP total`,
    };
  }

  if (!value.distinct || typeof value.distinct !== "object") {
    return { unavailable: "arrivals feed unreadable — distinct is missing" };
  }
  const distinctValue = value.distinct as Record<string, unknown>;
  const declared = count(distinctValue.declared);
  const anonymous = count(distinctValue.anonymous);
  const self = count(distinctValue.self);
  const furthest = arrivalStage(distinctValue.furthest);
  const furthestExternal = arrivalStage(distinctValue.furthestExternal);
  if (
    declared === undefined || anonymous === undefined || self === undefined ||
    furthest === undefined || furthestExternal === undefined
  ) {
    return { unavailable: "arrivals feed unreadable — distinct counts or furthest stages are invalid" };
  }
  const ambiguous = distinctValue.ambiguous === undefined ? undefined : count(distinctValue.ambiguous);
  const furthestAmbiguous =
    distinctValue.furthestAmbiguous === undefined ? undefined : arrivalStage(distinctValue.furthestAmbiguous);
  if (
    (distinctValue.ambiguous !== undefined && ambiguous === undefined) ||
    (distinctValue.furthestAmbiguous !== undefined && furthestAmbiguous === undefined)
  ) {
    return { unavailable: "arrivals feed unreadable — distinct ambiguous figures are invalid" };
  }

  if (!Array.isArray(value.clients)) {
    return { unavailable: "arrivals feed unreadable — clients is not an array" };
  }
  const clients: ArrivalClient[] = [];
  for (const rawClient of value.clients) {
    const client = normalizeClient(rawClient);
    if ("unavailable" in client) return client;
    clients.push(client.client);
  }

  return {
    schemaVersion: ARRIVALS_SCHEMA_VERSION,
    ...(generatedAtMs === undefined ? {} : { generatedAtMs }),
    ...(observingSinceMs === undefined ? {} : { observingSinceMs }),
    funnel: funnel.counts,
    funnelExternal: funnelExternal.counts,
    funnelSelf: funnelSelf.counts,
    // Omitted, not zero-filled, when the producer did not supply it.
    ...(ambiguousCounts === undefined ? {} : { funnelAmbiguous: ambiguousCounts }),
    ...(httpCounts === undefined ? {} : { funnelHttp: httpCounts }),
    ...(httpExternalCounts === undefined ? {} : { funnelHttpExternal: httpExternalCounts }),
    ...(httpSelfCounts === undefined ? {} : { funnelHttpSelf: httpSelfCounts }),
    ...(httpAmbiguousCounts === undefined ? {} : { funnelHttpAmbiguous: httpAmbiguousCounts }),
    ...(attributionSourceTotals && "value" in attributionSourceTotals
      ? { attributionSourceTotals: attributionSourceTotals.value }
      : {}),
    ...(httpCutover && "value" in httpCutover ? { httpCutover: httpCutover.value } : {}),
    // Pass the producer's operator view through untouched; the panel owns its
    // shape. Dropping it here is what turned the live verdict band into
    // "projection not present" while the backend was emitting it all along.
    ...(value.operatorView && typeof value.operatorView === "object" && !Array.isArray(value.operatorView)
      ? { operatorView: value.operatorView as Record<string, unknown> }
      : {}),
    distinct: {
      declared,
      anonymous,
      self,
      ...(ambiguous === undefined ? {} : { ambiguous }),
      furthest,
      furthestExternal,
      ...(furthestAmbiguous === undefined ? {} : { furthestAmbiguous }),
    },
    clients,
  };
}

function stageCounts(
  raw: unknown,
  field: string,
): { counts: Record<ArrivalStage, number> } | { unavailable: string } {
  if (!raw || typeof raw !== "object") {
    return { unavailable: `arrivals feed unreadable — ${field} is missing` };
  }
  const value = raw as Record<string, unknown>;
  const entries = ARRIVAL_STAGES.map((stage) => [stage, count(value[stage])] as const);
  const invalid = entries.find(([, stageCount]) => stageCount === undefined);
  if (invalid) {
    return { unavailable: `arrivals feed unreadable — ${field}.${invalid[0]} is invalid` };
  }
  return { counts: Object.fromEntries(entries) as Record<ArrivalStage, number> };
}

function optionalStageCounts(
  raw: unknown,
  field: string,
): { counts: Record<ArrivalStage, number> } | { unavailable: string } | undefined {
  return raw === undefined ? undefined : stageCounts(raw, field);
}

function normalizeAttributionSourceTotals(
  raw: unknown,
): { value: ArrivalAttributionSourceTotals } | { unavailable: string } | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { unavailable: "arrivals feed unreadable — attributionSourceTotals is invalid" };
  }
  const value = raw as Record<string, unknown>;
  const mcp = attributionCounts(value.mcp, "mcp");
  if ("unavailable" in mcp) return mcp;
  const http = attributionCounts(value.http, "http");
  if ("unavailable" in http) return http;
  return { value: { mcp: mcp.counts, http: http.counts } };
}

function attributionCounts(
  raw: unknown,
  door: string,
): { counts: ArrivalAttributionCounts } | { unavailable: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { unavailable: `arrivals feed unreadable — attributionSourceTotals.${door} is invalid` };
  }
  const value = raw as Record<string, unknown>;
  const siwe_wallet = count(value.siwe_wallet);
  const client_name = count(value.client_name);
  const ip_only = count(value.ip_only);
  if (siwe_wallet === undefined || client_name === undefined || ip_only === undefined) {
    return { unavailable: `arrivals feed unreadable — attributionSourceTotals.${door} counts are invalid` };
  }
  return { counts: { siwe_wallet, client_name, ip_only } };
}

function normalizeHttpCutover(
  raw: unknown,
): { value: HttpArrivalCutover } | { unavailable: string } | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { unavailable: "arrivals feed unreadable — httpCutover is invalid" };
  }
  const value = raw as Record<string, unknown>;
  const atMs = count(value.atMs);
  if (
    atMs === undefined ||
    typeof value.at !== "string" ||
    !value.at.trim() ||
    Number.isNaN(Date.parse(value.at)) ||
    typeof value.backfilled !== "boolean" ||
    typeof value.note !== "string" ||
    !value.note.trim()
  ) {
    return { unavailable: "arrivals feed unreadable — httpCutover fields are invalid" };
  }
  return { value: { atMs, at: value.at, backfilled: value.backfilled, note: value.note } };
}

function normalizeClient(raw: unknown): { client: ArrivalClient } | { unavailable: string } {
  if (!raw || typeof raw !== "object") {
    return { unavailable: "arrivals feed unreadable — client entry is not an object" };
  }
  const value = raw as Record<string, unknown>;
  const firstSeenMs = count(value.firstSeenMs);
  const lastSeenMs = count(value.lastSeenMs);
  const calls = count(value.calls);
  const furthestStage = arrivalStage(value.furthestStage);
  const tools = toolCounts(value.tools);
  if (
    typeof value.key !== "string" || !value.key.trim() ||
    !nullableString(value.name) || !nullableString(value.version) || !nullableString(value.era) ||
    // Not coerced: a missing mark is a producer we cannot read, whereas
    // treating it as false would silently promote our own probe to an
    // outsider. Absent is not the same as external here.
    typeof value.self !== "boolean" ||
    // The ambiguous mark IS allowed to be absent — an older producer has no
    // opinion to report — but a present one must be a real boolean.
    (value.ambiguous !== undefined && typeof value.ambiguous !== "boolean") ||
    firstSeenMs === undefined || lastSeenMs === undefined || calls === undefined ||
    furthestStage === undefined || tools === undefined
  ) {
    return { unavailable: "arrivals feed unreadable — client entry has invalid fields" };
  }
  return {
    client: {
      key: value.key,
      name: value.name,
      version: value.version,
      era: value.era,
      self: value.self,
      ...(value.ambiguous === undefined ? {} : { ambiguous: value.ambiguous }),
      firstSeenMs,
      lastSeenMs,
      furthestStage,
      calls,
      tools,
    },
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return count(value) ?? null;
}

function arrivalStage(value: unknown): ArrivalStage | undefined {
  return typeof value === "string" && (ARRIVAL_STAGES as readonly string[]).includes(value)
    ? value as ArrivalStage
    : undefined;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function toolCounts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, toolCount]) => !key || count(toolCount) === undefined)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}
