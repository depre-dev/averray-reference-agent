import type {
  MoneyAmount,
  OvernightLedgerPayload,
  RemoteFeedReading,
  TopupDestinationsPayload,
} from "./overnight-ledger.js";

const amount = (display: string): MoneyAmount => ({
  raw: String(Math.round(Number(display) * 1_000_000)),
  decimals: 6,
  display,
});

export const OVERNIGHT_LEDGER_FIXTURE: OvernightLedgerPayload = {
  window: "24h",
  generatedAt: "2026-08-24T05:00:00.000Z",
  reconciliation: {
    openingLiquid: amount("4.00"),
    payoutsOut: { count: 2, walletCount: 1, netUsdc: amount("0.50"), proofRefs: [] },
    retentionFeesIn: amount("0.05"),
    reservedDelta: amount("0.25"),
    closingLiquid: amount("3.30"),
    proofTiedCount: 2,
    proofMissingCount: 0,
    delta: amount("0.00"),
    match: "CONFIRMED",
    basis: "fixture",
  },
  workers: {
    items: [{
      wallet: "fixture-worker-alpha",
      isFirstEverActivity: true,
      sessionStart: "2026-08-24T01:00:00.000Z",
      sessionEnd: "2026-08-24T02:30:00.000Z",
      sessionHours: 1.5,
      claims: 3,
      approved: 2,
      rejected: 1,
      grossEarned: amount("0.50"),
      netEarned: amount("0.42"),
      retentionPaid: amount("0.08"),
      retentionWaived: amount("0.00"),
      waiverSlotsUsed: 2,
      waiverSlotsTotal: 3,
      reputationTier: "pro",
      tierEvents: [{ timestamp: "2026-08-24T02:30:00.000Z", from: "journeyman", to: "pro" }],
      balanceNow: { ...amount("0.80"), complete: true, basis: "fixture" },
      withdrawnInWindow: amount("0.10"),
    }],
    totals: {
      walletCount: 1,
      claims: 3,
      approved: 2,
      rejected: 1,
      grossEarned: amount("0.50"),
      netEarned: amount("0.42"),
      retentionPaid: amount("0.08"),
      retentionWaived: amount("0.00"),
      balanceNow: amount("0.80"),
      withdrawnInWindow: amount("0.10"),
    },
  },
  rewardBankSplit: {
    liquid: amount("3.30"),
    reserved: amount("1.20"),
    runwayDays: 6.6,
    runwayBasis: "liquid_only",
    liquidDelta: amount("-0.70"),
    reservedDelta: amount("0.25"),
  },
  retention: {
    charged: amount("0.08"),
    chargedSettlementCount: 2,
    waived: amount("0.00"),
    waivedSettlementCount: 0,
    waiverSlotsConsumed: 2,
    waiverSlotsTotal: 3,
    walletsInFreeWindow: 1,
    subsidySpend: amount("0.03"),
    subsidyDailyBudget: amount("1.50"),
    protocolRevenueDelta: amount("0.05"),
  },
  digest: {
    settlementCount: 2,
    walletCount: 1,
    newWalletCount: 1,
    paid: amount("0.50"),
    retained: amount("0.08"),
    bankOpen: amount("4.00"),
    bankClose: amount("3.30"),
    bankLocked: amount("1.20"),
    stuckClaimCount: 0,
    gasDelta: { raw: "0", decimals: 18, display: "0.0" },
    graduatedCount: 1,
    waiverWindowsExhausted: 0,
    firstExternalPostings: 1,
    walletsInFreeWindow: 1,
    warningsOpen: 0,
    warningsClosed: 1,
    deployCount: 1,
    ledgerMatchState: "CONFIRMED",
    ledgerDelta: amount("0.00"),
  },
  events: {
    items: [{
      timestamp: "2026-08-24T02:30:00.000Z",
      type: "wallet_graduated",
      severity: "ok",
      wallet: "fixture-worker-alpha",
      payload: { to: "pro" },
    }],
    totalCount: 1,
    returnedCount: 1,
    hasOlder: false,
  },
};

export const OVERNIGHT_LEDGER_LIVE: RemoteFeedReading<OvernightLedgerPayload> = {
  state: "live",
  data: OVERNIGHT_LEDGER_FIXTURE,
};

export const OVERNIGHT_LEDGER_UNAUTHORIZED = {
  state: "unauthorized",
  reason: "feed unauthorized — monitor token lacks ops:view",
} as const;

export const OVERNIGHT_LEDGER_UNAVAILABLE = {
  state: "unavailable",
  reason: "feed unavailable — preview fixture",
} as const;

export const TOPUP_DESTINATIONS_FIXTURE: RemoteFeedReading<TopupDestinationsPayload> = {
  state: "live",
  data: {
    topupDestinations: {
      signerGas: {
        ss58Address: "fixture-signer-destination",
        asset: "DOT",
        network: "Polkadot Asset Hub",
        exchangeNetworkLabel: "Polkadot",
      },
      rewardBank: {
        ss58Address: "fixture-bank-destination",
        asset: "USDC",
        network: "Polkadot Asset Hub",
        exchangeNetworkLabel: "Polkadot",
        landsInEoa: true,
        followUpCommand: "fund-signer deposit",
      },
    },
  },
};
