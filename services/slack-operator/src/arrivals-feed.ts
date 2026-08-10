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

export interface ArrivalClient {
  key: string;
  name: string | null;
  version: string | null;
  era: string | null;
  /** Declared as one of ours. Unmarked callers are external on purpose. */
  self: boolean;
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
  distinct: {
    declared: number;
    anonymous: number;
    self: number;
    furthest: ArrivalStage;
    furthestExternal: ArrivalStage;
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

  // External and self are subsets of the total, so neither can exceed it and
  // together they cannot either. A producer that says otherwise is describing
  // a funnel we do not understand, and the safe reading of a funnel we do not
  // understand is none at all.
  const incoherent = ARRIVAL_STAGES.find(
    (stage) => funnelExternal.counts[stage] + funnelSelf.counts[stage] > funnel.counts[stage],
  );
  if (incoherent) {
    return {
      unavailable: `arrivals feed unreadable — ${incoherent} external plus self exceeds the total`,
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
    distinct: { declared, anonymous, self, furthest, furthestExternal },
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
