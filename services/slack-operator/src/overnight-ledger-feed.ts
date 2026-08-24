import type { AdminDemandAuthSession } from "./admin-demand-feed.js";

export type OvernightLedgerWindow = "12h" | "24h" | "48h";

export type AdminFeedReading =
  | { state: "live"; data: unknown }
  | { state: "unauthorized"; reason: string }
  | { state: "unavailable"; reason: string };

export interface OvernightLedgerFeed {
  schemaVersion: "averray.monitor.overnight-ledger.v1";
  generatedAt: string;
  window: OvernightLedgerWindow;
  ledger: AdminFeedReading;
  topupDestinations: AdminFeedReading;
}

interface ReadOvernightLedgerFeedOptions {
  baseUrl: string;
  window: OvernightLedgerWindow;
  getSession: () => Promise<AdminDemandAuthSession>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const UNAUTHORIZED_REASON = "feed unauthorized — monitor token lacks ops:view";

export async function readOvernightLedgerFeed(options: ReadOvernightLedgerFeedOptions): Promise<OvernightLedgerFeed> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  let session: AdminDemandAuthSession;
  try {
    session = await options.getSession();
  } catch (error) {
    const reason = `admin read unavailable — ${errorMessage(error)}`;
    return unavailableFeed(options.window, generatedAt, reason);
  }

  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const [ledger, topupDestinations] = await Promise.all([
    readAdminJson(
      `${baseUrl}/admin/ops/overnight-ledger?window=${encodeURIComponent(options.window)}`,
      session.token,
      "overnight ledger",
      fetchImpl,
    ),
    readAdminJson(
      `${baseUrl}/admin/ops/topup-destinations`,
      session.token,
      "top-up destinations",
      fetchImpl,
    ),
  ]);

  return {
    schemaVersion: "averray.monitor.overnight-ledger.v1",
    generatedAt,
    window: options.window,
    ledger,
    topupDestinations,
  };
}

async function readAdminJson(
  url: string,
  token: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<AdminFeedReading> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 403) return { state: "unauthorized", reason: UNAUTHORIZED_REASON };
    if (!response.ok) return { state: "unavailable", reason: `${label} returned HTTP ${response.status}` };
    return { state: "live", data: await response.json() };
  } catch (error) {
    return { state: "unavailable", reason: `${label} unavailable — ${errorMessage(error)}` };
  }
}

function unavailableFeed(
  window: OvernightLedgerWindow,
  generatedAt: string,
  reason: string,
): OvernightLedgerFeed {
  return {
    schemaVersion: "averray.monitor.overnight-ledger.v1",
    generatedAt,
    window,
    ledger: { state: "unavailable", reason },
    topupDestinations: { state: "unavailable", reason },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
