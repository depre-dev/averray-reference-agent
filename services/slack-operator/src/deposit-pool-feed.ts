// The Bank pillar's deposit-pool snapshot, read from the independently
// deployed platform.
//
// This follows the arrivals-feed boundary: fields are allowlisted, additions
// are optional during staggered deploys, and values are reconstructed from
// decimal strings rather than trusting JavaScript numbers with token amounts.
// A real zero is a measurement. Only a missing endpoint/profile is
// UNAVAILABLE; malformed or arithmetically impossible core values are a FAULT.
// A log-read failure is narrower: it degrades `flows` while retaining the live
// balances, because losing history cannot make the current pool unreadable.

export const DEPOSIT_POOL_SCHEMA_VERSION = 1;
export const DEPOSIT_POOL_FEED_TIMEOUT_MS = 4000;

/**
 * The pool endpoint is intentionally internal. Reuse the Bank feed's already
 * configured `agent-mainnet-internal` origin and replace its path; NEVER fall
 * back to public PRODUCT_HEALTH_API_BASE_URL, where Caddy correctly returns
 * 404 for this route.
 */
export function depositPoolUrlFromBankFeed(bankFeedUrl: string | undefined): string | undefined {
  const source = bankFeedUrl?.trim();
  if (!source) return undefined;
  try {
    return new URL("/monitor/deposit-pool", source).toString();
  } catch {
    return undefined;
  }
}

export interface TokenAmount {
  /** Exact, canonical, non-negative integer in token base units. */
  raw: string;
  /** Absent only when a raw-only cap arrived before an asset read. */
  decimals?: number;
}

export type DepositPoolFlowKind =
  | "deposit"
  | "withdraw"
  | "redeem_requested"
  | "redeem_fulfilled"
  | "operator_principal_contributed"
  | "venue_loss_written_off";

export interface DepositPoolFlow {
  kind: DepositPoolFlowKind;
  blockNumber?: number;
  transactionHash?: string;
  logIndex?: number;
  assets?: TokenAmount;
  /** Kept exact; share decimals may be absent on partial producer payloads. */
  sharesRaw?: string;
  requestId?: string;
  tier?: string;
  unlockAt?: string;
}

export interface DepositPoolFlowWindow {
  fromBlock?: number;
  toBlock?: number;
  maxBlocks?: number;
  recentLimit?: number;
}

export interface DepositPoolFlows {
  status: "ok" | "unavailable";
  depositorCount?: number;
  depositorCountModel?: string;
  pendingUnfulfilledRedemptionShares?: TokenAmount;
  pendingUnfulfilledRedemptionAssets?: TokenAmount;
  recent: DepositPoolFlow[];
  /** Complete qualifying set from the bounded window, separate from recent flows. */
  sharePriceQualifyingEvents?: DepositPoolFlow[];
  window?: DepositPoolFlowWindow;
  lastError?: string;
}

export interface DepositPoolSnapshot {
  schemaVersion: typeof DEPOSIT_POOL_SCHEMA_VERSION;
  available: true;
  pool?: string;
  asset?: string;
  block?: { number?: number; hash?: string; timestamp?: number };
  pricingModel?: string;
  totalAssets?: TokenAmount;
  totalShares?: TokenAmount;
  sharePrice?: TokenAmount;
  buffer?: TokenAmount;
  deployed?: TokenAmount;
  reconciled?: boolean;
  caps?: {
    totalAssetCap?: TokenAmount;
    perAgentAssetCap?: TokenAmount;
    headroom?: TokenAmount;
    utilizationBps?: number;
  };
  yieldStatus?: "not_yet_earning" | "earning";
  yieldStatusText?: string;
  flows?: DepositPoolFlows;
}

export type DepositPoolBlock =
  | { snapshot: DepositPoolSnapshot }
  | { unavailable: string }
  | { fault: string };

export async function readDepositPoolFeed(input: {
  /** Exact URL derived from PRODUCT_HEALTH_BANK_FEED_URL's internal origin. */
  url?: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<DepositPoolBlock> {
  const url = input.url?.trim();
  if (!url) {
    return { unavailable: "deposit pool unreachable — internal Bank feed URL is not configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEPOSIT_POOL_FEED_TIMEOUT_MS);
  try {
    const response = await input.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return { unavailable: `deposit pool unreachable — platform returned HTTP ${response.status}` };
    }
    return normalizeDepositPoolFeed(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { unavailable: `deposit pool unreachable — ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Shape and arithmetic checks for the cross-repo v1 payload. */
export function normalizeDepositPoolFeed(body: unknown): DepositPoolBlock {
  if (!record(body)) return { fault: "deposit pool unreadable — payload was not an object" };
  if (body.schemaVersion !== DEPOSIT_POOL_SCHEMA_VERSION) {
    return { fault: `deposit pool unreadable — expected schemaVersion ${DEPOSIT_POOL_SCHEMA_VERSION}` };
  }
  if (body.available === false) {
    const reason = nonEmptyString(body.reason) ?? "deposit_pool_not_configured";
    return { unavailable: `deposit pool unavailable — ${reason}` };
  }
  if (body.available !== true) {
    return { fault: "deposit pool unreadable — available must be true or false" };
  }

  const amountFields = ["totalAssets", "totalShares", "sharePrice", "buffer", "deployed"] as const;
  const amounts: Partial<Record<(typeof amountFields)[number], TokenAmount>> = {};
  for (const field of amountFields) {
    const parsed = optionalAmount(body[field], field);
    if (parsed.fault) return { fault: parsed.fault };
    if (parsed.value) amounts[field] = parsed.value;
  }

  const block = optionalBlock(body.block);
  if (block.fault) return { fault: block.fault };
  const reconciliation = optionalReconciliation(body.reconciliation);
  if (reconciliation.fault) return { fault: reconciliation.fault };
  const caps = optionalCaps(body.caps);
  if (caps.fault) return { fault: caps.fault };

  if (body.reconciled !== undefined && typeof body.reconciled !== "boolean") {
    return { fault: "deposit pool unreadable — reconciled is invalid" };
  }
  if (body.reconciled === false) {
    return { fault: "deposit pool incoherent — producer reported reconciliation failure" };
  }
  if (reconciliation.value?.differenceRaw !== undefined && reconciliation.value.differenceRaw !== "0") {
    return { fault: "deposit pool incoherent — producer reported a non-zero reconciliation difference" };
  }
  if (
    amounts.buffer && amounts.deployed && amounts.totalAssets &&
    !amountSumEquals(amounts.buffer, amounts.deployed, amounts.totalAssets)
  ) {
    return { fault: "deposit pool incoherent — buffer plus deployed does not equal total assets" };
  }
  if (
    amounts.totalAssets && amounts.totalShares && amounts.sharePrice &&
    !sharePriceIsConsistent(amounts.totalAssets, amounts.totalShares, amounts.sharePrice)
  ) {
    return { fault: "deposit pool incoherent — share price is inconsistent with total assets and shares" };
  }

  const yieldStatus = body.yieldStatus === undefined
    ? undefined
    : body.yieldStatus === "not_yet_earning" || body.yieldStatus === "earning"
      ? body.yieldStatus
      : null;
  if (yieldStatus === null) return { fault: "deposit pool unreadable — yieldStatus is invalid" };
  if (body.pool !== undefined && !nonEmptyString(body.pool)) {
    return { fault: "deposit pool unreadable — pool is invalid" };
  }
  if (body.asset !== undefined && !nonEmptyString(body.asset)) {
    return { fault: "deposit pool unreadable — asset is invalid" };
  }
  if (body.pricingModel !== undefined && !nonEmptyString(body.pricingModel)) {
    return { fault: "deposit pool unreadable — pricingModel is invalid" };
  }
  if (body.yieldStatusText !== undefined && typeof body.yieldStatusText !== "string") {
    return { fault: "deposit pool unreadable — yieldStatusText is invalid" };
  }

  const flows = optionalFlows(body.flows, amounts.totalAssets?.decimals);
  const snapshot: DepositPoolSnapshot = {
    schemaVersion: DEPOSIT_POOL_SCHEMA_VERSION,
    available: true,
    ...(body.pool === undefined ? {} : { pool: body.pool as string }),
    ...(body.asset === undefined ? {} : { asset: body.asset as string }),
    ...(block.value ? { block: block.value } : {}),
    ...(body.pricingModel === undefined ? {} : { pricingModel: body.pricingModel as string }),
    ...amounts,
    ...(body.reconciled === undefined ? {} : { reconciled: body.reconciled }),
    ...(caps.value ? { caps: caps.value } : {}),
    ...(yieldStatus === undefined ? {} : { yieldStatus }),
    ...(body.yieldStatusText === undefined ? {} : { yieldStatusText: body.yieldStatusText as string }),
    ...(flows ? { flows } : {}),
  };
  return { snapshot };
}

function optionalAmount(raw: unknown, field: string): { value?: TokenAmount; fault?: string } {
  if (raw === undefined) return {};
  if (!record(raw)) return { fault: `deposit pool unreadable — ${field} is invalid` };
  const amountRaw = decimalRaw(raw.raw);
  const decimals = safeCount(raw.decimals);
  if (amountRaw === undefined || decimals === undefined || decimals > 36) {
    return { fault: `deposit pool unreadable — ${field} needs decimal-string raw and decimals` };
  }
  return { value: { raw: amountRaw, decimals } };
}

function optionalBlock(raw: unknown): {
  value?: { number?: number; hash?: string; timestamp?: number };
  fault?: string;
} {
  if (raw === undefined) return {};
  if (!record(raw)) return { fault: "deposit pool unreadable — block is invalid" };
  const number = optionalSafeCount(raw.number);
  const timestamp = optionalSafeCount(raw.timestamp);
  if (
    number === null || timestamp === null ||
    (raw.hash !== undefined && raw.hash !== null && !nonEmptyString(raw.hash))
  ) {
    return { fault: "deposit pool unreadable — block fields are invalid" };
  }
  return {
    value: {
      ...(number === undefined ? {} : { number }),
      ...(raw.hash === undefined || raw.hash === null ? {} : { hash: raw.hash as string }),
      ...(timestamp === undefined ? {} : { timestamp }),
    },
  };
}

function optionalReconciliation(raw: unknown): {
  value?: { equation?: string; accountedRaw?: string; differenceRaw?: string };
  fault?: string;
} {
  if (raw === undefined) return {};
  if (!record(raw)) {
    return { fault: "deposit pool unreadable — reconciliation is invalid" };
  }
  const equation = raw.equation === undefined ? undefined : nonEmptyString(raw.equation);
  const accountedRaw = raw.accountedRaw === undefined ? undefined : decimalRaw(raw.accountedRaw);
  const differenceRaw = raw.differenceRaw === undefined ? undefined : signedDecimalRaw(raw.differenceRaw);
  if (
    (raw.equation !== undefined && equation === undefined) ||
    (raw.accountedRaw !== undefined && accountedRaw === undefined) ||
    (raw.differenceRaw !== undefined && differenceRaw === undefined)
  ) {
    return { fault: "deposit pool unreadable — reconciliation fields are invalid" };
  }
  return {
    value: {
      ...(equation === undefined ? {} : { equation }),
      ...(accountedRaw === undefined ? {} : { accountedRaw }),
      ...(differenceRaw === undefined ? {} : { differenceRaw }),
    },
  };
}

function optionalCaps(raw: unknown): {
  value?: DepositPoolSnapshot["caps"];
  fault?: string;
} {
  if (raw === undefined) return {};
  if (!record(raw)) return { fault: "deposit pool unreadable — caps is invalid" };
  const names = ["totalAssetCap", "perAgentAssetCap", "headroom"] as const;
  const value: NonNullable<DepositPoolSnapshot["caps"]> = {};
  for (const field of names) {
    const parsed = optionalAmount(raw[field], `caps.${field}`);
    if (parsed.fault) return { fault: parsed.fault };
    if (parsed.value) value[field] = parsed.value;
  }
  if (raw.utilizationBps !== undefined) {
    const utilizationBps = raw.utilizationBps === null
      ? undefined
      : typeof raw.utilizationBps === "string" && /^\d+$/.test(raw.utilizationBps)
        ? Number(raw.utilizationBps)
        : safeCount(raw.utilizationBps);
    if (utilizationBps === undefined || utilizationBps > 10_000) {
      if (raw.utilizationBps !== null) {
        return { fault: "deposit pool unreadable — caps.utilizationBps is invalid" };
      }
    } else {
      value.utilizationBps = utilizationBps;
    }
  }
  return { value };
}

function optionalFlows(
  raw: unknown,
  assetDecimals: number | undefined,
): DepositPoolFlows | undefined {
  if (raw === undefined) return undefined;
  if (!record(raw)) return unavailableFlows("flows payload is invalid");
  const status = raw.status === "ok" || raw.status === "unavailable" ? raw.status : null;
  if (status === null) return unavailableFlows("flows.status is invalid");
  const depositorCount = raw.depositorCount === null ? undefined : optionalSafeCount(raw.depositorCount);
  if (depositorCount === null) return unavailableFlows("flows.depositorCount is invalid", raw);
  const depositorCountModel = raw.depositorCountModel === undefined
    ? undefined
    : nonEmptyString(raw.depositorCountModel);
  if (raw.depositorCountModel !== undefined && depositorCountModel === undefined) {
    return unavailableFlows("flows.depositorCountModel is invalid", raw);
  }
  const pendingShares = nullableAmount(
    raw.pendingUnfulfilledRedemptionShares,
    "flows.pendingUnfulfilledRedemptionShares",
  );
  const pendingAssets = nullableAmount(
    raw.pendingUnfulfilledRedemptionAssets,
    "flows.pendingUnfulfilledRedemptionAssets",
  );
  if (pendingShares.fault) return unavailableFlows(pendingShares.fault, raw);
  if (pendingAssets.fault) return unavailableFlows(pendingAssets.fault, raw);
  const window = normalizeFlowWindow(raw.window);
  if (window === null) return unavailableFlows("flows.window is invalid", raw);
  if (raw.recent !== undefined && raw.recent !== null && !Array.isArray(raw.recent)) {
    return unavailableFlows("flows.recent is invalid", raw);
  }
  const recent: DepositPoolFlow[] = [];
  for (const entry of (raw.recent as unknown[] | null | undefined) ?? []) {
    const flow = normalizeFlow(entry, assetDecimals);
    if (flow) recent.push(flow);
  }
  if (
    raw.sharePriceQualifyingEvents !== undefined &&
    raw.sharePriceQualifyingEvents !== null &&
    !Array.isArray(raw.sharePriceQualifyingEvents)
  ) {
    return unavailableFlows("flows.sharePriceQualifyingEvents is invalid", raw);
  }
  let sharePriceQualifyingEvents: DepositPoolFlow[] | undefined =
    raw.sharePriceQualifyingEvents === undefined || raw.sharePriceQualifyingEvents === null ? undefined : [];
  for (const entry of (raw.sharePriceQualifyingEvents as unknown[] | null | undefined) ?? []) {
    const flow = normalizeFlow(entry, assetDecimals);
    if (!flow) {
      // An explicitly supplied but malformed proof list cannot prove absence.
      // Disable the tombstone conclusion for this observation rather than
      // laundering a bad entry into an empty qualifying set.
      sharePriceQualifyingEvents = undefined;
      break;
    }
    if (PRICE_QUALIFYING_FLOW_KINDS.has(flow.kind)) sharePriceQualifyingEvents?.push(flow);
  }
  const lastError = nonEmptyString(raw.lastError);
  return {
    status,
    ...(depositorCount === undefined ? {} : { depositorCount }),
    ...(depositorCountModel === undefined ? {} : { depositorCountModel }),
    ...(pendingShares.value ? { pendingUnfulfilledRedemptionShares: pendingShares.value } : {}),
    ...(pendingAssets.value ? { pendingUnfulfilledRedemptionAssets: pendingAssets.value } : {}),
    recent,
    ...(sharePriceQualifyingEvents ? { sharePriceQualifyingEvents } : {}),
    ...(window === undefined ? {} : { window }),
    ...(lastError ? { lastError } : {}),
  };
}

function unavailableFlows(reason: string, raw?: Record<string, unknown>): DepositPoolFlows {
  const window = normalizeFlowWindow(raw?.window);
  return {
    status: "unavailable",
    recent: [],
    ...(window && window !== null ? { window } : {}),
    lastError: `deposit pool flows unreadable — ${reason}`,
  };
}

function normalizeFlowWindow(raw: unknown): DepositPoolFlowWindow | undefined | null {
  if (raw === undefined) return undefined;
  if (!record(raw)) return null;
  const value: DepositPoolFlowWindow = {};
  for (const field of ["fromBlock", "toBlock", "maxBlocks", "recentLimit"] as const) {
    if (raw[field] === undefined) continue;
    const parsed = safeCount(raw[field]);
    if (parsed === undefined) return null;
    value[field] = parsed;
  }
  if (
    value.fromBlock !== undefined && value.toBlock !== undefined && value.fromBlock > value.toBlock
  ) return null;
  return value;
}

function normalizeFlow(raw: unknown, assetDecimals: number | undefined): DepositPoolFlow | undefined {
  if (!record(raw)) return undefined;
  const kind = flowKind(raw.event ?? raw.type ?? raw.name);
  if (!kind) return undefined;
  const blockNumber = optionalSafeCount(raw.blockNumber);
  const logIndex = optionalSafeCount(raw.logIndex);
  const assetsRaw = raw.assetsRaw === undefined ? undefined : decimalRaw(raw.assetsRaw);
  const sharesRaw = raw.sharesRaw === undefined ? undefined : decimalRaw(raw.sharesRaw);
  if (blockNumber === null || logIndex === null) return undefined;
  if (raw.assetsRaw !== undefined && assetsRaw === undefined) return undefined;
  if (raw.sharesRaw !== undefined && sharesRaw === undefined) return undefined;
  const transactionHash = nonEmptyString(raw.transactionHash ?? raw.txHash);
  const requestId = raw.requestId === undefined ? undefined : nonEmptyString(raw.requestId);
  const tier = raw.tier === undefined ? undefined : decimalRaw(raw.tier);
  const unlockAt = raw.unlockAt === undefined ? undefined : decimalRaw(raw.unlockAt);
  if (raw.requestId !== undefined && requestId === undefined) return undefined;
  if (raw.tier !== undefined && tier === undefined) return undefined;
  if (raw.unlockAt !== undefined && unlockAt === undefined) return undefined;
  return {
    kind,
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(transactionHash ? { transactionHash } : {}),
    ...(logIndex === undefined ? {} : { logIndex }),
    ...(assetsRaw === undefined
      ? {}
      : { assets: { raw: assetsRaw, ...(assetDecimals === undefined ? {} : { decimals: assetDecimals }) } }),
    ...(sharesRaw === undefined ? {} : { sharesRaw }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(tier === undefined ? {} : { tier }),
    ...(unlockAt === undefined ? {} : { unlockAt }),
  };
}

function flowKind(value: unknown): DepositPoolFlowKind | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return ({
    deposit: "deposit",
    withdraw: "withdraw",
    redeemrequested: "redeem_requested",
    redeemfulfilled: "redeem_fulfilled",
    operatorprincipalcontributed: "operator_principal_contributed",
    venuelosswrittenoff: "venue_loss_written_off",
  } as Record<string, DepositPoolFlowKind>)[key];
}

const PRICE_QUALIFYING_FLOW_KINDS = new Set<DepositPoolFlowKind>([
  "operator_principal_contributed",
  "redeem_fulfilled",
  "venue_loss_written_off",
]);

function nullableAmount(raw: unknown, field: string): { value?: TokenAmount; fault?: string } {
  if (raw === undefined || raw === null) return {};
  return optionalAmount(raw, field);
}

function amountSumEquals(a: TokenAmount, b: TokenAmount, total: TokenAmount): boolean {
  if (a.decimals === undefined || b.decimals === undefined || total.decimals === undefined) return false;
  const scale = Math.max(a.decimals, b.decimals, total.decimals);
  return scaledRaw(a, scale) + scaledRaw(b, scale) === scaledRaw(total, scale);
}

function sharePriceIsConsistent(assets: TokenAmount, shares: TokenAmount, price: TokenAmount): boolean {
  if (assets.decimals === undefined || shares.decimals === undefined || price.decimals === undefined) return false;
  const shareRaw = BigInt(shares.raw);
  // A born-empty pool has no ratio to reconstruct. Its initial quoted price is
  // still a live contract read and is rendered as such; the first non-zero
  // share observation makes this check determinate.
  if (shareRaw === 0n) return true;
  const numerator = BigInt(assets.raw) * 10n ** BigInt(price.decimals + shares.decimals);
  const denominator = shareRaw * 10n ** BigInt(assets.decimals);
  const expected = numerator / denominator;
  const actual = BigInt(price.raw);
  const difference = actual >= expected ? actual - expected : expected - actual;
  return difference <= 1n;
}

function scaledRaw(amount: TokenAmount, decimals: number): bigint {
  return BigInt(amount.raw) * 10n ** BigInt(decimals - (amount.decimals ?? decimals));
}

function decimalRaw(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return BigInt(value).toString();
}

function signedDecimalRaw(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
  return BigInt(value).toString();
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalSafeCount(value: unknown): number | null | undefined {
  return value === undefined ? undefined : safeCount(value) ?? null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
