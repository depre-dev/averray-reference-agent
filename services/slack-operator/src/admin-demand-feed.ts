import { describeFeedError } from "./probe-transport.js";

export type AdminDemandWindow = "48h" | "30d";

export interface AdminDemandAuthSession {
  token: string;
  wallet?: string;
  expiresAt?: string;
  source?: "static_token" | "siwe";
}

export function createAdminReadSessionProvider(options: {
  staticToken?: string;
  getSiweSession: () => Promise<AdminDemandAuthSession>;
}): () => Promise<AdminDemandAuthSession> {
  const staticToken = options.staticToken?.trim();
  if (staticToken) {
    return async () => ({ token: staticToken, source: "static_token" });
  }
  return async () => ({ ...(await options.getSiweSession()), source: "siwe" });
}

export interface AdminDemandUnavailable {
  unavailable: string;
  state?: "unauthorized" | "unavailable";
}

export interface AdminDemandFeed {
  schemaVersion: "averray.monitor.arrivals-journeys.v1";
  generatedAt: string;
  /** The later cut-over is the earliest point shared by both returned feeds. */
  collectionSince?: string;
  window: AdminDemandWindow;
  timeline: unknown | AdminDemandUnavailable;
  journeys: unknown | AdminDemandUnavailable;
}

interface ReadAdminDemandFeedOptions {
  baseUrl: string;
  window: AdminDemandWindow;
  limit: number;
  getSession: () => Promise<AdminDemandAuthSession>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Keeps the platform bearer on the server, beside the wallet that minted it.
 * The monitor browser sees only the projected admin reads and never receives
 * the token or a signing capability.
 */
export class AdminDemandSessionCache {
  private session: AdminDemandAuthSession | undefined;
  private pending: Promise<AdminDemandAuthSession> | undefined;

  constructor(
    private readonly login: () => Promise<AdminDemandAuthSession>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<AdminDemandAuthSession> {
    if (this.session && sessionRemainsUsable(this.session, this.now())) return this.session;
    if (this.pending) return this.pending;

    this.pending = this.login()
      .then((session) => {
        this.session = session;
        return session;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export async function readAdminDemandFeed(options: ReadAdminDemandFeedOptions): Promise<AdminDemandFeed> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  let session: AdminDemandAuthSession;
  try {
    session = await options.getSession();
  } catch (error) {
    const reason = `admin SIWE session unavailable: ${errorMessage(error)}`;
    return unavailableFeed(options.window, generatedAt, reason);
  }

  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const [timeline, journeys] = await Promise.all([
    readAdminJson(
      `${baseUrl}/admin/arrivals/timeline?window=${encodeURIComponent(options.window)}`,
      session.token,
      "arrivals timeline",
      fetchImpl,
    ),
    readAdminJson(
      `${baseUrl}/admin/worker-journeys?limit=${encodeURIComponent(String(options.limit))}`,
      session.token,
      "worker journeys",
      fetchImpl,
    ),
  ]);
  const collectionSince = sharedCollectionSince(timeline, journeys);

  return {
    schemaVersion: "averray.monitor.arrivals-journeys.v1",
    generatedAt,
    ...(collectionSince ? { collectionSince } : {}),
    window: options.window,
    timeline,
    journeys,
  };
}

async function readAdminJson(
  url: string,
  token: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<unknown | AdminDemandUnavailable> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 403) {
      return {
        state: "unauthorized",
        unavailable: "feed unauthorized — monitor token lacks ops:view",
      };
    }
    if (!response.ok) return { state: "unavailable", unavailable: `${label} returned HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { state: "unavailable", unavailable: `${label} unavailable: ${errorMessage(error)}` };
  }
}

function unavailableFeed(window: AdminDemandWindow, generatedAt: string, reason: string): AdminDemandFeed {
  return {
    schemaVersion: "averray.monitor.arrivals-journeys.v1",
    generatedAt,
    window,
    timeline: { state: "unavailable", unavailable: reason },
    journeys: { state: "unavailable", unavailable: reason },
  };
}

function sessionRemainsUsable(session: AdminDemandAuthSession, nowMs: number): boolean {
  if (!session.token) return false;
  if (!session.expiresAt) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs + 60_000;
}

function sharedCollectionSince(...feeds: Array<unknown | AdminDemandUnavailable>): string | undefined {
  const times = feeds
    .map((feed) => readCollectionSince(feed))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, at: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.at));
  if (times.length === 0) return undefined;
  return times.reduce((latest, current) => current.at > latest.at ? current : latest).value;
}

function readCollectionSince(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || "unavailable" in value) return undefined;
  const collectionSince = (value as Record<string, unknown>).collectionSince;
  return typeof collectionSince === "string" ? collectionSince : undefined;
}

function errorMessage(error: unknown): string {
  return describeFeedError(error);
}
