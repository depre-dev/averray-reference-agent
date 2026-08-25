export type OvernightWindow = "12h" | "24h" | "48h";
export type RemoteFeedState = "live" | "loading" | "unauthorized" | "unavailable";

export type RemoteFeedReading<T> =
  | { state: "live"; data: T }
  | { state: "loading"; reason: string }
  | { state: "unauthorized"; reason: string }
  | { state: "unavailable"; reason: string };

export interface MoneyAmount {
  raw: string | null;
  decimals: number;
  display: string | null;
  available?: false;
  proofRefs?: unknown[];
}

export interface OvernightReconciliation {
  openingLiquid: MoneyAmount;
  payoutsOut: {
    count: number;
    walletCount: number;
    netUsdc: MoneyAmount;
    proofRefs: unknown[];
  };
  retentionFeesIn: MoneyAmount;
  reservedDelta: MoneyAmount;
  closingLiquid: MoneyAmount;
  proofTiedCount: number;
  proofMissingCount: number;
  delta: MoneyAmount;
  match: "CONFIRMED" | "SHORTFALL";
  basis: string;
}

export interface OvernightWorker {
  wallet: string;
  isFirstEverActivity: boolean;
  selfIdentity?: unknown;
  sessionStart: string | null;
  sessionEnd: string | null;
  sessionHours: number;
  claims: number;
  approved: number;
  rejected: number;
  grossEarned: MoneyAmount;
  netEarned: MoneyAmount;
  retentionPaid: MoneyAmount;
  retentionWaived: MoneyAmount;
  waiverSlotsUsed: number;
  waiverSlotsTotal: number;
  reputationTier: string | null;
  tierEvents: Array<{ timestamp: string; from?: string | null; to?: string | null }>;
  balanceNow: MoneyAmount & { complete: boolean; basis: string };
  withdrawnInWindow: MoneyAmount;
}

export interface OvernightWorkerTotals {
  walletCount: number;
  claims: number;
  approved: number;
  rejected: number;
  grossEarned: MoneyAmount;
  netEarned: MoneyAmount;
  retentionPaid: MoneyAmount;
  retentionWaived: MoneyAmount;
  balanceNow: MoneyAmount;
  withdrawnInWindow: MoneyAmount;
}

export interface RewardBankSplit {
  liquid: MoneyAmount;
  reserved: MoneyAmount;
  runwayDays: number | null;
  runwayBasis: string;
  liquidDelta: MoneyAmount;
  reservedDelta: MoneyAmount;
}

export interface RetentionWindow {
  charged: MoneyAmount;
  chargedSettlementCount: number;
  waived: MoneyAmount;
  waivedSettlementCount: number;
  waiverSlotsConsumed: number;
  waiverSlotsTotal: number;
  walletsInFreeWindow: number;
  subsidySpend: MoneyAmount;
  subsidyDailyBudget: MoneyAmount;
  protocolRevenueDelta: MoneyAmount;
}

export interface OvernightDigestData {
  settlementCount: number;
  walletCount: number;
  newWalletCount: number;
  paid: MoneyAmount;
  retained: MoneyAmount;
  bankOpen: MoneyAmount;
  bankClose: MoneyAmount;
  bankLocked: MoneyAmount;
  stuckClaimCount: number;
  gasDelta: MoneyAmount;
  graduatedCount: number;
  waiverWindowsExhausted: number;
  firstExternalPostings: number;
  walletsInFreeWindow: number;
  warningsOpen: number;
  warningsClosed: number;
  deployCount: number;
  ledgerMatchState: "CONFIRMED" | "SHORTFALL";
  ledgerDelta: MoneyAmount;
}

export interface OvernightEvent {
  timestamp: string;
  type: string;
  severity: "ok" | "warn" | "info";
  wallet?: string;
  payload: Record<string, unknown>;
}

export interface OvernightLedgerPayload {
  window: OvernightWindow;
  generatedAt: string;
  reconciliation: OvernightReconciliation;
  workers: { items: OvernightWorker[]; totals: OvernightWorkerTotals };
  rewardBankSplit: RewardBankSplit;
  retention: RetentionWindow;
  digest: OvernightDigestData;
  events: {
    items: OvernightEvent[];
    totalCount: number;
    returnedCount: number;
    hasOlder: boolean;
  };
}

export interface TopupDestination {
  ss58Address: string;
  asset: "DOT" | "USDC";
  network: string;
  exchangeNetworkLabel?: string;
  landsInEoa?: boolean;
  followUpCommand?: string;
}

export interface TopupDestinationsPayload {
  topupDestinations: {
    signerGas: TopupDestination;
    rewardBank: TopupDestination;
  };
}

export interface MonitorReadIdentity {
  wallet: string;
  scopes: string[];
  source: "static_token" | "siwe" | "session";
  expiresAt?: string;
}

export interface OvernightLedgerFeed {
  schemaVersion: "averray.monitor.overnight-ledger.v1";
  generatedAt: string;
  window: OvernightWindow;
  ledger: Exclude<RemoteFeedReading<OvernightLedgerPayload>, { state: "loading" }>;
  topupDestinations: Exclude<RemoteFeedReading<TopupDestinationsPayload>, { state: "loading" }>;
  readIdentity: Exclude<RemoteFeedReading<MonitorReadIdentity>, { state: "loading" }>;
}

export function parseOvernightLedgerFeed(value: unknown): OvernightLedgerFeed {
  if (!isRecord(value) || value.schemaVersion !== "averray.monitor.overnight-ledger.v1") {
    throw new Error("overnight ledger feed has an unsupported schemaVersion");
  }
  if (!isOvernightWindow(value.window)) throw new Error("overnight ledger feed has an invalid window");
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: requiredString(value.generatedAt, "generatedAt"),
    window: value.window,
    ledger: parseReading(value.ledger, parseLedgerPayload, "ledger"),
    topupDestinations: parseReading(value.topupDestinations, parseTopupsPayload, "topupDestinations"),
    readIdentity: parseReading(value.readIdentity, parseReadIdentity, "readIdentity"),
  };
}

export function loadingReading<T>(reason = "feed loading — waiting for the first read"): RemoteFeedReading<T> {
  return { state: "loading", reason };
}

export function unavailableReading<T>(reason: string): RemoteFeedReading<T> {
  return { state: "unavailable", reason };
}

export function feedStateCopy(reading: RemoteFeedReading<unknown>): string {
  if (reading.state === "live") return "live";
  return reading.reason;
}

export function moneyDisplay(value: MoneyAmount, fallback = "—"): string {
  return value.display == null ? fallback : trimMoney(value.display);
}

export function signedMoneyDisplay(value: MoneyAmount): string {
  if (value.display == null) return "—";
  const display = trimMoney(value.display);
  if (display.startsWith("-")) return `−${display.slice(1)}`;
  if (Number(display) > 0) return `+${display}`;
  return display;
}

function parseReading<T>(
  value: unknown,
  parseData: (value: unknown) => T,
  label: string,
): Exclude<RemoteFeedReading<T>, { state: "loading" }> {
  if (!isRecord(value)) throw new Error(`${label} feed state is missing`);
  if (value.state === "live") return { state: "live", data: parseData(value.data) };
  if (value.state === "unauthorized" || value.state === "unavailable") {
    return { state: value.state, reason: requiredString(value.reason, `${label}.reason`) };
  }
  throw new Error(`${label} feed state is invalid`);
}

function parseLedgerPayload(value: unknown): OvernightLedgerPayload {
  if (!isRecord(value) || !isOvernightWindow(value.window)) throw new Error("ledger payload is malformed");
  for (const field of ["reconciliation", "workers", "rewardBankSplit", "retention", "digest", "events"] as const) {
    if (!isRecord(value[field])) throw new Error(`ledger payload is missing ${field}`);
  }
  const workers = value.workers;
  const events = value.events;
  if (!Array.isArray(workers.items) || !isRecord(workers.totals)) throw new Error("ledger workers are malformed");
  if (!Array.isArray(events.items)) throw new Error("ledger events are malformed");
  return value as unknown as OvernightLedgerPayload;
}

function parseTopupsPayload(value: unknown): TopupDestinationsPayload {
  if (!isRecord(value) || !isRecord(value.topupDestinations)) throw new Error("top-up destinations are malformed");
  for (const key of ["signerGas", "rewardBank"] as const) {
    const destination = value.topupDestinations[key];
    if (!isRecord(destination) || typeof destination.ss58Address !== "string" || typeof destination.asset !== "string"
      || typeof destination.network !== "string") {
      throw new Error(`top-up destination ${key} is malformed`);
    }
  }
  return value as unknown as TopupDestinationsPayload;
}

function parseReadIdentity(value: unknown): MonitorReadIdentity {
  if (!isRecord(value) || typeof value.wallet !== "string" || !Array.isArray(value.scopes)) {
    throw new Error("read identity is malformed");
  }
  if (value.source !== "static_token" && value.source !== "siwe" && value.source !== "session") {
    throw new Error("read identity source is malformed");
  }
  if (!value.scopes.every((scope: unknown) => typeof scope === "string")) {
    throw new Error("read identity scopes are malformed");
  }
  if (value.expiresAt !== undefined && typeof value.expiresAt !== "string") {
    throw new Error("read identity expiry is malformed");
  }
  return {
    wallet: value.wallet,
    scopes: [...new Set(value.scopes as string[])].sort(),
    source: value.source,
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
  };
}

function trimMoney(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/u, "").replace(/\.$/u, "");
  return trimmed === "-0" ? "0" : trimmed;
}

function isOvernightWindow(value: unknown): value is OvernightWindow {
  return value === "12h" || value === "24h" || value === "48h";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is missing`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
