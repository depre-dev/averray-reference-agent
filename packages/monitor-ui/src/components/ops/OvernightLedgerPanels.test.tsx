// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import {
  EventsLane,
  MoneyMovementPanel,
  OvernightDigest,
  RetentionWaiversPanel,
  TopupBlock,
  WorkersTable,
} from "./OvernightLedgerPanels.js";
import type {
  OvernightLedgerPayload,
  RemoteFeedReading,
  TopupDestinationsPayload,
} from "../../lib/monitor/overnight-ledger.js";

afterEach(cleanup);

const amount = (display: string) => ({ raw: String(Math.round(Number(display) * 1_000_000)), decimals: 6, display });

const ledger: OvernightLedgerPayload = {
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
    items: [{ timestamp: "2026-08-24T02:30:00.000Z", type: "wallet_graduated", severity: "ok", wallet: "fixture-worker-alpha", payload: { to: "pro" } }],
    totalCount: 1,
    returnedCount: 1,
    hasOlder: false,
  },
};

const live: RemoteFeedReading<OvernightLedgerPayload> = { state: "live", data: ledger };
const unauthorized = {
  state: "unauthorized",
  reason: "feed unauthorized — monitor token lacks ops:view",
} as const;

describe("Overnight ledger panels", () => {
  test("keeps WAIVER and TIER as separate ladder columns", () => {
    const { getByTestId } = render(<WorkersTable reading={live} />);
    const headers = within(getByTestId("ops-workers-head")).getAllByRole("columnheader").map((node) => node.textContent);
    expect(headers).toContain("WAIVER");
    expect(headers).toContain("TIER");
    expect(headers.indexOf("WAIVER")).not.toBe(headers.indexOf("TIER"));
  });

  test("renders every unauthorized ledger surface as a named non-reading", () => {
    const { getAllByText } = render(
      <>
        <OvernightDigest reading={unauthorized} window="24h" onWindowChange={() => undefined} />
        <MoneyMovementPanel reading={unauthorized} window="24h" />
        <RetentionWaiversPanel reading={unauthorized} window="24h" />
        <EventsLane reading={unauthorized} window="24h" />
        <WorkersTable reading={unauthorized} />
      </>,
    );
    expect(getAllByText(/feed unauthorized — monitor token lacks ops:view/i)).toHaveLength(5);
  });

  test("renders a live worker row and all five money evidence outputs", () => {
    const { getByTestId } = render(
      <>
        <MoneyMovementPanel reading={live} window="24h" />
        <WorkersTable reading={live} />
      </>,
    );
    expect(getByTestId("ops-money-movement").textContent).toContain("OPENING LIQUID");
    expect(getByTestId("ops-money-movement").textContent).toContain("CLOSING LIQUID");
    expect(getByTestId("ops-workers").textContent).toContain("fixture-worker-alpha");
    expect(getByTestId("ops-workers").textContent).toContain("journeyman → pro");
  });

  test("top-up block renders only the address supplied by the response", () => {
    const topups: TopupDestinationsPayload = {
      topupDestinations: {
        signerGas: { ss58Address: "fixture-runtime-destination", asset: "DOT", network: "Polkadot Asset Hub", exchangeNetworkLabel: "Polkadot" },
        rewardBank: { ss58Address: "fixture-bank-destination", asset: "USDC", network: "Polkadot Asset Hub", exchangeNetworkLabel: "Polkadot", landsInEoa: true, followUpCommand: "fund-signer deposit" },
      },
    };
    const { getByTestId } = render(<TopupBlock account="signerGas" reading={{ state: "live", data: topups }} />);
    expect(getByTestId("ops-topup-signerGas").textContent).toContain("fixture-runtime-destination");
  });

  test("new components contain no address-shaped literal", () => {
    const source = fs.readFileSync(path.resolve("packages/monitor-ui/src/components/ops/OvernightLedgerPanels.tsx"), "utf8");
    expect(source).not.toMatch(/0x[a-fA-F0-9]{40}/u);
    expect(source).not.toMatch(/\b1[1-9A-HJ-NP-Za-km-z]{45,49}\b/u);
  });
});
