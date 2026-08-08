// ARRIVALS — the platform's public MCP-front-door observatory.
//
// This is a cross-repo contract. The platform owns collection and serves
// `GET /monitor/arrivals`; Hermes reads that one public endpoint and renders
// the result. Nothing crossing that network boundary is trusted implicitly:
// malformed or unreachable data becomes an explicit `unavailable` block,
// never an empty funnel that could be mistaken for "nobody arrived".

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
  funnel: Record<ArrivalStage, number>;
  distinct: {
    declared: number;
    anonymous: number;
    furthest: ArrivalStage;
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

  if (!value.distinct || typeof value.distinct !== "object") {
    return { unavailable: "arrivals feed unreadable — distinct is missing" };
  }
  const distinctValue = value.distinct as Record<string, unknown>;
  const declared = count(distinctValue.declared);
  const anonymous = count(distinctValue.anonymous);
  const furthest = arrivalStage(distinctValue.furthest);
  if (declared === undefined || anonymous === undefined || furthest === undefined) {
    return { unavailable: "arrivals feed unreadable — distinct counts or furthest stage are invalid" };
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
    distinct: { declared, anonymous, furthest },
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
