// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { BoardView } from "../BoardView.js";
import { OpsBoard } from "../ops/OpsBoard.js";
import { MobileBoard } from "./MobileBoard.js";
import type { OvernightLedgerState } from "../../hooks/useOvernightLedger.js";
import {
  OVERNIGHT_LEDGER_FIXTURE,
  OVERNIGHT_LEDGER_LIVE,
  OVERNIGHT_LEDGER_UNAUTHORIZED,
  READ_IDENTITY_FIXTURE,
  TOPUP_DESTINATIONS_FIXTURE,
} from "../../lib/monitor/overnight-ledger-fixtures.js";
import type { OvernightWindow, RemoteFeedReading } from "../../lib/monitor/overnight-ledger.js";
import { OPS_FIXTURE_NOMINAL, OPS_FIXTURE_STRESS, FIXTURE_NOW } from "../../lib/monitor/ops-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const overnightState = (window: OvernightWindow = "24h"): OvernightLedgerState => ({
  ledger: {
    state: "live",
    data: { ...OVERNIGHT_LEDGER_FIXTURE, window },
  },
  topupDestinations: TOPUP_DESTINATIONS_FIXTURE,
  window,
  setWindow: vi.fn(),
  refresh: vi.fn(),
});

describe("Hermes mobile triage — one truth", () => {
  test("the work screen shows the served review line", () => {
    const health = {
      ...OPS_FIXTURE_NOMINAL,
      flow: {
        ...OPS_FIXTURE_NOMINAL.flow,
        waitingForMerge: 4,
        awaitingHumanReview: 1,
        overdueReview: 2,
        maxOverdueReview: 5,
      },
    };
    const view = render(
      <MobileBoard
        health={health}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "work" }));
    expect(view.getByTestId("mobile-review-buckets").textContent).toContain("waiting for merge 4");
    expect(view.getByTestId("mobile-review-buckets").textContent).toContain("overdue review 2");
  });

  test("mobile renders the same shared verdict state as desktop and exposes its typed reason", () => {
    const desktop = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={FIXTURE_NOW} />);
    const mobile = render(
      <MobileBoard
        health={OPS_FIXTURE_STRESS}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
      />,
    );
    const headline = desktop.getByTestId("ops-verdict").textContent;
    expect(headline).toBeTruthy();
    expect(within(mobile.container).getByText(headline!)).toBeTruthy();
    expect(mobile.getByText("reason · floor-breach")).toBeTruthy();
  });

  test("mobile and desktop agree on settled count, net paid, runway, and closing liquid for the same window fixture", () => {
    const desktop = render(
      <OpsBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        topupDestinations={TOPUP_DESTINATIONS_FIXTURE}
        overnightWindow="24h"
      />,
    );
    const mobileStatus = render(
      <MobileBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        topupDestinations={TOPUP_DESTINATIONS_FIXTURE}
        overnightWindow="24h"
      />,
    );
    const settled = within(mobileStatus.getByTestId("mobile-vital-settled")).getByText("2").textContent;
    const paid = String(Number(OVERNIGHT_LEDGER_FIXTURE.digest.paid.display));
    const runway = String(OVERNIGHT_LEDGER_FIXTURE.rewardBankSplit.runwayDays);
    expect(mobileStatus.getByTestId("mobile-vital-runway").textContent).toContain(runway);
    expect(desktop.getByTestId("ops-overnight-digest").textContent).toContain(`${settled} settlements`);
    expect(desktop.getByTestId("ops-overnight-digest").textContent).toContain(`${paid} paid`);
    expect(desktop.getByTestId("ops-reward-bank-split").textContent).toContain(`runway ${runway} d`);

    const mobileMoney = render(
      <MobileBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        topupDestinations={TOPUP_DESTINATIONS_FIXTURE}
        overnightWindow="24h"
        initialScreen="money"
      />,
    );
    expect(mobileMoney.getByTestId("mobile-closing-liquid").textContent).toBe(
      desktop.container.querySelector('[data-row="closing"] b')?.textContent,
    );
  });

  test("one shared window value governs every mobile screen and the More sheet only mirrors it", () => {
    function Harness() {
      const [window, setWindow] = useState<OvernightWindow>("24h");
      const ledger: RemoteFeedReading<typeof OVERNIGHT_LEDGER_FIXTURE> = {
        state: "live",
        data: { ...OVERNIGHT_LEDGER_FIXTURE, window },
      };
      return (
        <MobileBoard
          health={OPS_FIXTURE_NOMINAL}
          nowMs={FIXTURE_NOW}
          overnightLedger={ledger}
          topupDestinations={TOPUP_DESTINATIONS_FIXTURE}
          overnightWindow={window}
          onOvernightWindowChange={setWindow}
        />
      );
    }
    const view = render(<Harness />);
    fireEvent.click(within(view.getByRole("group", { name: "Shared board window" })).getByRole("button", { name: "48h" }));
    expect(view.getByRole("button", { name: "48h" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByTestId("mobile-digest").textContent).toContain("Last 48h");

    fireEvent.click(view.getByRole("tab", { name: "money" }));
    expect(view.getByTestId("mobile-money-movement").textContent).toContain("MONEY MOVEMENT — 48H");
    fireEvent.click(view.getByRole("tab", { name: "work" }));
    expect(view.getByTestId("mobile-work-screen").textContent).toContain("MONEY PATH — 48H");
    fireEvent.click(view.getByRole("button", { name: "more" }));
    expect(view.getByTestId("mobile-more-sheet").textContent).toContain("WINDOW · GOVERNS EVERY SCREEN48H");
    expect(within(view.getByTestId("mobile-more-sheet")).queryByRole("group", { name: "Shared board window" })).toBeNull();
  });

  test("keeps WAIVER and TIER as separately-headered mobile worker columns", () => {
    const view = render(
      <MobileBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        initialScreen="work"
      />,
    );
    const headers = within(view.getByTestId("mobile-worker-row"))
      .getAllByRole("columnheader")
      .map((node) => node.textContent);
    expect(headers).toContain("WAIVER");
    expect(headers).toContain("TIER");
    expect(headers.indexOf("WAIVER")).not.toBe(headers.indexOf("TIER"));
  });
});

describe("Hermes mobile triage — state honesty", () => {
  test("a degraded status renders PARTIAL VIEW, the typed verdict reason, and no zero for a missing vital", () => {
    const health = {
      ...OPS_FIXTURE_STRESS,
      solvency: {
        ...OPS_FIXTURE_STRESS.solvency!,
        pools: OPS_FIXTURE_STRESS.solvency!.pools.filter((pool) => pool.key !== "signer_gas"),
      },
      probes: OPS_FIXTURE_STRESS.probes.map((probe) => probe.name === "signer_liquidity"
        ? { ...probe, detail: "balance read failed: fixture RPC timeout" }
        : probe),
    };
    const view = render(
      <MobileBoard
        health={health}
        streamDegraded
        streamStatus="reconnecting"
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_UNAUTHORIZED}
      />,
    );
    expect(view.getByTestId("mobile-partial-view").textContent).toContain("PARTIAL VIEW");
    const signer = view.getByTestId("mobile-vital-signer-gas");
    expect(signer.textContent).toContain("balance read failed: fixture RPC timeout");
    expect(within(signer).getByLabelText("SIGNER GAS unavailable").textContent).toBe("—");
    expect(signer.textContent).not.toContain("0");
    expect(view.getByTestId("mobile-status-screen").textContent).toContain("reason · floor-breach");
    expect(view.getByTestId("mobile-actions").textContent).toContain("feed unauthorized");
  });

  test("names live, loading, unauthorized, and unavailable feed states", () => {
    const loading = { state: "loading", reason: "feed loading — fixture" } as const;
    const unavailable = { state: "unavailable", reason: "feed unavailable — fixture" } as const;
    const readings = [
      OVERNIGHT_LEDGER_LIVE,
      loading,
      OVERNIGHT_LEDGER_UNAUTHORIZED,
      unavailable,
    ];
    for (const reading of readings) {
      const view = render(<MobileBoard overnightLedger={reading} initialScreen="money" />);
      expect(view.getByTestId("mobile-money-movement").getAttribute("data-feed-state")).toBe(reading.state);
      expect(view.getByTestId("mobile-board").textContent?.toLowerCase()).toContain(reading.state);
      view.unmount();
    }
  });

  test("an empty live Events window is a live zero-row answer, not an unavailable panel", () => {
    const ledger = {
      state: "live",
      data: {
        ...OVERNIGHT_LEDGER_FIXTURE,
        events: { items: [], totalCount: 0, returnedCount: 0, hasOlder: false },
      },
    } as const;
    const view = render(<MobileBoard overnightLedger={ledger} initialScreen="events" />);
    expect(view.getByTestId("mobile-events-empty").textContent).toContain("feed is live and reachable");
    expect(view.getByTestId("mobile-events-empty").textContent).toContain("LIVE · 0 ROWS");
  });

  test("renders the machine read identity with its scopes and never a sign-out control", () => {
    const view = render(
      <MobileBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        readIdentity={READ_IDENTITY_FIXTURE}
        initialMoreOpen
      />,
    );
    const sheet = view.getByTestId("mobile-more-sheet");
    expect(sheet.textContent).toContain("READ IDENTITY");
    expect(sheet.textContent).toContain("0x062d…2a8a");
    expect(sheet.textContent).toContain("ops:view ✓");
    expect(sheet.textContent).toContain("admin:status ✓");
    expect(sheet.textContent).toContain("sufficient for the board's read panels");
    expect(within(sheet).queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  test("a live empty action derivation says nothing needs you rather than unavailable", () => {
    const view = render(
      <MobileBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={FIXTURE_NOW}
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
      />,
    );
    expect(view.getByTestId("mobile-actions").getAttribute("data-feed-state")).toBe("live");
    expect(view.getByTestId("mobile-actions-empty").textContent).toBe("nothing needs you");
  });
});

describe("Hermes mobile triage — routes and responsive boundaries", () => {
  test("desktop-only surfaces resolve to gate cards instead of squeezed tables", () => {
    const view = render(<MobileBoard initialMoreOpen />);
    for (const [button, gate] of [
      [/BANK-LANE DETAIL/i, "mobile-gate-bank-lane"],
      [/PAYOUT EVIDENCE TABLE/i, "mobile-gate-payout-evidence"],
      [/PROBE GRID \(FULL\)/i, "mobile-gate-probe-grid"],
    ] as const) {
      fireEvent.click(view.getByRole("button", { name: button }));
      expect(view.getByTestId(gate).textContent).toContain("this view is built for desktop");
      expect(view.getByTestId(gate).textContent).toContain("copy link for desktop");
      fireEvent.click(within(view.getByTestId(gate)).getByRole("button", { name: /back/i }));
    }
  });

  test("top-up addresses come only from the runtime reading and components contain no address literal", () => {
    const view = render(
      <MobileBoard
        overnightLedger={OVERNIGHT_LEDGER_LIVE}
        topupDestinations={TOPUP_DESTINATIONS_FIXTURE}
        initialScreen="money"
      />,
    );
    expect(view.getByTestId("mobile-topup-signerGas").textContent).toContain("fixture-signer-destination");
    expect(view.getByTestId("mobile-topup-rewardBank").textContent).toContain("fixture-bank-destination");
    const packageRoot = fs.existsSync(path.resolve("src/components/mobile/MobileBoard.tsx")) ? "." : "packages/monitor-ui";
    const source = fs.readFileSync(path.resolve(packageRoot, "src/components/mobile/MobileBoard.tsx"), "utf8");
    expect(source).not.toMatch(/0x[a-fA-F0-9]{40}/u);
    expect(source).not.toMatch(/\b1[1-9A-HJ-NP-Za-km-z]{45,49}\b/u);
  });

  test("keeps the >=1080 desktop board markup byte-for-byte equal to OpsBoard", async () => {
    mockViewport(1080);
    const health = { ...OPS_FIXTURE_NOMINAL, at: Date.now() - 2_000 };
    const state = overnightState();
    const board = { cards: [], at: "2026-08-24T05:00:00.000Z" };
    const responsive = render(<BoardView board={board} status="open" health={health} overnight={state} />);
    await waitFor(() => expect(responsive.queryByTestId("mobile-board")).toBeNull());
    const responsiveMarkup = within(responsive.container).getByTestId("ops-board").outerHTML;
    const direct = render(
      <div className="hm-shell">
        <OpsBoard
          health={health}
          board={board}
          streamStatus="open"
          streamDegraded={false}
          overnightLedger={state.ledger}
          topupDestinations={state.topupDestinations}
          overnightWindow={state.window}
          onOvernightWindowChange={state.setWindow}
        />
      </div>,
    );
    expect(responsiveMarkup).toBe(within(direct.container).getByTestId("ops-board").outerHTML);
  });

  test("routes tablet width through compact triage while preserving the desktop cutoff", async () => {
    mockViewport(1079);
    const view = render(
      <BoardView board={{ cards: [], at: "2026-08-24T05:00:00.000Z" }} status="open" health={OPS_FIXTURE_NOMINAL} overnight={overnightState()} />,
    );
    await waitFor(() => expect(view.getByTestId("mobile-board")).toBeTruthy());
    expect(view.queryByTestId("ops-board")).toBeNull();
  });
});

function mockViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => {
      const maxWidth = Number(/max-width:\s*(\d+)px/u.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
      return {
        matches: width <= maxWidth,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}
