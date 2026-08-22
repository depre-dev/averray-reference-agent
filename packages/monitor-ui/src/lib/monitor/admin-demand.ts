export const ARRIVAL_SURFACES = [
  "manifest",
  "onboarding",
  "jobs_reads",
  "mcp_initialize",
  "verify_profiles",
] as const;

export const CLIENT_SOFTWARE_CLASSES = [
  "claude",
  "cursor",
  "codex",
  "browser",
  "mcp_bridge",
  "directory",
  "other_declared",
  "unidentified",
] as const;

export type ArrivalSurface = typeof ARRIVAL_SURFACES[number];
export type ClientSoftwareClass = typeof CLIENT_SOFTWARE_CLASSES[number];
export type AdminDemandWindow = "48h" | "30d";

export interface AdminDemandUnavailable {
  unavailable: string;
}

export interface ArrivalTimelineCount {
  surface: ArrivalSurface;
  clientClass: ClientSoftwareClass;
  count: number;
}

export interface ArrivalTimelineBucket {
  start: string;
  end: string;
  total: number;
  counts: ArrivalTimelineCount[];
}

export interface ArrivalTimeline {
  schemaVersion: "averray.admin.arrivals.timeline.v1";
  generatedAt: string;
  collectionSince: string;
  window: {
    id: AdminDemandWindow;
    bucket: "hour" | "day";
    start: string;
    end: string;
    bucketCount: number;
    retentionDays: number;
    backfilled: false;
  };
  dimensions: {
    surfaces: ArrivalSurface[];
    clientSoftwareClasses: ClientSoftwareClass[];
  };
  buckets: ArrivalTimelineBucket[];
}

export type JourneyEventType =
  | "first_seen"
  | "auth_nonce"
  | "signed_in"
  | "preflighted"
  | "claimed"
  | "submitted"
  | "verified"
  | "settled"
  | "withdrawal_intent"
  | "gas_grant";

const JOURNEY_EVENT_TYPES: readonly JourneyEventType[] = [
  "first_seen",
  "auth_nonce",
  "signed_in",
  "preflighted",
  "claimed",
  "submitted",
  "verified",
  "settled",
  "withdrawal_intent",
  "gas_grant",
];

export interface WorkerJourneyEvent {
  id: string;
  type: JourneyEventType;
  timestamp: string;
  sourceStore: string;
  durationFromPreviousMs?: number | null;
  sessionId?: string;
  jobId?: string;
  txHash?: string;
  details?: Record<string, unknown>;
}

export interface WorkerJourney {
  wallet: string;
  classification: "external" | "operator-run" | "unknown";
  classificationKind?: string;
  classificationAuthority: "shared_self_identity_registry";
  classificationEvidence?: unknown;
  firstSeenAt?: string;
  lastActiveAt?: string;
  events: WorkerJourneyEvent[];
}

export interface WorkerJourneys {
  schemaVersion: "averray.admin.worker-journeys.v1";
  generatedAt: string;
  collectionSince: string;
  window: {
    id: "wallet_retained_history" | "recent_active";
    backfilled: false;
    sessionReadCap: number;
    eventReadCap: number;
    journeyEventPerWalletCap: number;
  };
  scope: "operator";
  identityBoundary: string;
  count: number;
  limit: number;
  wallet?: string;
  journeys: WorkerJourney[];
}

export interface AdminDemandFeed {
  schemaVersion: "averray.monitor.arrivals-journeys.v1";
  generatedAt: string;
  collectionSince?: string;
  window: AdminDemandWindow;
  timeline: ArrivalTimeline | AdminDemandUnavailable;
  journeys: WorkerJourneys | AdminDemandUnavailable;
}

export function isUnavailable(value: unknown): value is AdminDemandUnavailable {
  return isRecord(value) && typeof value.unavailable === "string";
}

/** Fail closed on malformed admin data: the panel shows a read failure, not invented rows. */
export function parseAdminDemandFeed(value: unknown): AdminDemandFeed {
  if (!isRecord(value) || value.schemaVersion !== "averray.monitor.arrivals-journeys.v1") {
    throw new Error("admin demand response has an unsupported schema");
  }
  if (value.window !== "48h" && value.window !== "30d") throw new Error("admin demand response has an invalid window");
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: requiredString(value.generatedAt, "generatedAt"),
    ...(typeof value.collectionSince === "string" ? { collectionSince: value.collectionSince } : {}),
    window: value.window,
    timeline: parseTimelineOrUnavailable(value.timeline),
    journeys: parseJourneysOrUnavailable(value.journeys),
  };
}

function parseTimelineOrUnavailable(value: unknown): ArrivalTimeline | AdminDemandUnavailable {
  if (isUnavailable(value)) return value;
  if (!isRecord(value) || value.schemaVersion !== "averray.admin.arrivals.timeline.v1") {
    throw new Error("arrival timeline is missing or malformed");
  }
  if (!isRecord(value.window) || (value.window.id !== "48h" && value.window.id !== "30d")) {
    throw new Error("arrival timeline window is malformed");
  }
  if (value.window.bucket !== "hour" && value.window.bucket !== "day") throw new Error("arrival timeline bucket unit is malformed");
  if (value.window.backfilled !== false) throw new Error("arrival timeline must state that it is not backfilled");
  if (!isRecord(value.dimensions) || !Array.isArray(value.dimensions.surfaces)
    || !Array.isArray(value.dimensions.clientSoftwareClasses)) {
    throw new Error("arrival timeline dimensions are malformed");
  }
  if (!Array.isArray(value.buckets)) throw new Error("arrival timeline buckets are malformed");
  const buckets = value.buckets.map((bucket, index) => parseTimelineBucket(bucket, index));
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: requiredString(value.generatedAt, "timeline.generatedAt"),
    collectionSince: requiredString(value.collectionSince, "timeline.collectionSince"),
    window: {
      id: value.window.id,
      bucket: value.window.bucket,
      start: requiredString(value.window.start, "timeline.window.start"),
      end: requiredString(value.window.end, "timeline.window.end"),
      bucketCount: nonNegativeNumber(value.window.bucketCount, "timeline.window.bucketCount"),
      retentionDays: nonNegativeNumber(value.window.retentionDays, "timeline.window.retentionDays"),
      backfilled: false,
    },
    dimensions: {
      surfaces: parseEnumArray(value.dimensions.surfaces, ARRIVAL_SURFACES, "timeline.dimensions.surfaces"),
      clientSoftwareClasses: parseEnumArray(
        value.dimensions.clientSoftwareClasses,
        CLIENT_SOFTWARE_CLASSES,
        "timeline.dimensions.clientSoftwareClasses",
      ),
    },
    buckets,
  };
}

function parseTimelineBucket(value: unknown, index: number): ArrivalTimelineBucket {
  if (!isRecord(value) || !Array.isArray(value.counts)) throw new Error(`arrival timeline bucket ${index} is malformed`);
  return {
    start: requiredString(value.start, `buckets[${index}].start`),
    end: requiredString(value.end, `buckets[${index}].end`),
    total: nonNegativeNumber(value.total, `buckets[${index}].total`),
    counts: value.counts.map((count, countIndex) => parseTimelineCount(count, index, countIndex)),
  };
}

function parseTimelineCount(value: unknown, bucketIndex: number, countIndex: number): ArrivalTimelineCount {
  if (!isRecord(value) || !ARRIVAL_SURFACES.includes(value.surface as ArrivalSurface)
    || !CLIENT_SOFTWARE_CLASSES.includes(value.clientClass as ClientSoftwareClass)) {
    throw new Error(`arrival timeline count ${bucketIndex}:${countIndex} is malformed`);
  }
  return {
    surface: value.surface as ArrivalSurface,
    clientClass: value.clientClass as ClientSoftwareClass,
    count: nonNegativeNumber(value.count, `buckets[${bucketIndex}].counts[${countIndex}].count`),
  };
}

function parseJourneysOrUnavailable(value: unknown): WorkerJourneys | AdminDemandUnavailable {
  if (isUnavailable(value)) return value;
  if (!isRecord(value) || value.schemaVersion !== "averray.admin.worker-journeys.v1" || !Array.isArray(value.journeys)) {
    throw new Error("worker journeys are missing or malformed");
  }
  if (!isRecord(value.window) || (value.window.id !== "wallet_retained_history" && value.window.id !== "recent_active")) {
    throw new Error("worker journey window is malformed");
  }
  if (value.window.backfilled !== false) throw new Error("worker journeys must state that they are not backfilled");
  if (value.scope !== "operator") throw new Error("worker journeys escaped the operator scope");
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: requiredString(value.generatedAt, "journeys.generatedAt"),
    collectionSince: requiredString(value.collectionSince, "journeys.collectionSince"),
    window: {
      id: value.window.id,
      backfilled: false,
      sessionReadCap: nonNegativeNumber(value.window.sessionReadCap, "journeys.window.sessionReadCap"),
      eventReadCap: nonNegativeNumber(value.window.eventReadCap, "journeys.window.eventReadCap"),
      journeyEventPerWalletCap: nonNegativeNumber(value.window.journeyEventPerWalletCap, "journeys.window.journeyEventPerWalletCap"),
    },
    scope: value.scope,
    identityBoundary: requiredString(value.identityBoundary, "journeys.identityBoundary"),
    count: nonNegativeNumber(value.count, "journeys.count"),
    limit: nonNegativeNumber(value.limit, "journeys.limit"),
    ...(typeof value.wallet === "string" ? { wallet: value.wallet } : {}),
    journeys: value.journeys.map((journey, index) => parseJourney(journey, index)),
  };
}

function parseJourney(value: unknown, index: number): WorkerJourney {
  if (!isRecord(value) || !Array.isArray(value.events)) throw new Error(`worker journey ${index} is malformed`);
  const classification = value.classification;
  if (classification !== "external" && classification !== "operator-run" && classification !== "unknown") {
    throw new Error(`worker journey ${index} has an invalid classification`);
  }
  if (value.classificationAuthority !== "shared_self_identity_registry") {
    throw new Error(`worker journey ${index} has an invalid classification authority`);
  }
  return {
    wallet: requiredString(value.wallet, `journeys[${index}].wallet`),
    classification,
    classificationAuthority: value.classificationAuthority,
    ...(typeof value.classificationKind === "string" ? { classificationKind: value.classificationKind } : {}),
    ...(value.classificationEvidence === undefined ? {} : { classificationEvidence: value.classificationEvidence }),
    ...(typeof value.firstSeenAt === "string" ? { firstSeenAt: value.firstSeenAt } : {}),
    ...(typeof value.lastActiveAt === "string" ? { lastActiveAt: value.lastActiveAt } : {}),
    events: value.events.map((event, eventIndex) => parseJourneyEvent(event, index, eventIndex)),
  };
}

function parseJourneyEvent(value: unknown, journeyIndex: number, eventIndex: number): WorkerJourneyEvent {
  if (!isRecord(value)) throw new Error(`worker journey event ${journeyIndex}:${eventIndex} is malformed`);
  const type = requiredString(value.type, `journeys[${journeyIndex}].events[${eventIndex}].type`);
  if (!JOURNEY_EVENT_TYPES.includes(type as JourneyEventType)) {
    throw new Error(`worker journey event ${journeyIndex}:${eventIndex} has an invalid type`);
  }
  const duration = value.durationFromPreviousMs;
  if (duration !== undefined && duration !== null
    && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) {
    throw new Error(`worker journey event ${journeyIndex}:${eventIndex} has an invalid duration`);
  }
  return {
    id: requiredString(value.id, `journeys[${journeyIndex}].events[${eventIndex}].id`),
    type: type as JourneyEventType,
    timestamp: requiredString(value.timestamp, `journeys[${journeyIndex}].events[${eventIndex}].timestamp`),
    sourceStore: requiredString(value.sourceStore, `journeys[${journeyIndex}].events[${eventIndex}].sourceStore`),
    ...(duration === undefined ? {} : { durationFromPreviousMs: duration as number | null }),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
    ...(typeof value.txHash === "string" ? { txHash: value.txHash } : {}),
    ...(isRecord(value.details) ? { details: value.details } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function parseEnumArray<const T extends readonly string[]>(value: unknown[], allowed: T, field: string): Array<T[number]> {
  if (value.some((item) => typeof item !== "string" || !allowed.includes(item as T[number]))) {
    throw new Error(`${field} contains an unsupported value`);
  }
  return value as Array<T[number]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
