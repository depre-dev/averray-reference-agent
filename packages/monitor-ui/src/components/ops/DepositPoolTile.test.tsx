// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import type { DepositPoolBlock } from "../../lib/monitor/product-health.js";
import { DepositPoolTile } from "./DepositPoolTile.js";

afterEach(cleanup);

const amount = (raw: string) => ({ raw, decimals: 6 });

describe("DepositPoolTile truth states", () => {
  test("real zero measurements render as zeros with the born-empty annotation", () => {
    const pool: DepositPoolBlock = {
      snapshot: {
        schemaVersion: 1,
        available: true,
        pricingModel: "principal-cost-basis",
        totalAssets: amount("0"),
        totalShares: amount("0"),
        sharePrice: amount("1000000"),
        buffer: amount("0"),
        deployed: amount("0"),
        reconciled: true,
        caps: {
          totalAssetCap: amount("10000000"),
          headroom: amount("10000000"),
          utilizationBps: 0,
        },
        yieldStatus: "not_yet_earning",
        flows: {
          status: "ok",
          depositorCount: 0,
          pendingUnfulfilledRedemptionAssets: amount("0"),
          recent: [],
          window: { fromBlock: 100, toBlock: 101, maxBlocks: 2, recentLimit: 8 },
        },
      },
    };
    const { getByTestId } = render(<DepositPoolTile pool={pool} />);

    expect(getByTestId("ops-deposit-pool-born-empty").textContent).toContain("BORN EMPTY");
    expect(getByTestId("ops-deposit-pool-deposits").textContent).toContain("0 USDC");
    expect(getByTestId("ops-deposit-pool-allocation").textContent).toContain("0 USDC buffer");
    expect(getByTestId("ops-deposit-pool-allocation").textContent).toContain("0 USDC deployed");
    expect(getByTestId("ops-deposit-pool-depositors").textContent).toContain("0");
    expect(getByTestId("ops-deposit-pool-cap").textContent).toContain("0.00%");
    expect(getByTestId("ops-deposit-pool-flow-window").textContent).toContain("blocks 100–101");
  });

  test("a missing pre-5a endpoint renders UNAVAILABLE, visually distinct from zero", () => {
    const { getByTestId, queryByTestId } = render(
      <DepositPoolTile pool={{ unavailable: "deposit pool unreachable — platform returned HTTP 404" }} />,
    );
    const tile = getByTestId("ops-deposit-pool");
    expect(within(tile).getByText("UNAVAILABLE")).toBeTruthy();
    expect(tile.textContent).toContain("HTTP 404");
    expect(queryByTestId("ops-deposit-pool-born-empty")).toBeNull();
    expect(queryByTestId("ops-deposit-pool-deposits")).toBeNull();
  });

  test("an incoherent producer renders a labeled FAULT and no impossible figures", () => {
    const { getByTestId, queryByTestId } = render(
      <DepositPoolTile pool={{ fault: "deposit pool incoherent — buffer plus deployed does not equal total assets" }} />,
    );
    expect(getByTestId("ops-deposit-pool").textContent).toContain("FAULT");
    expect(queryByTestId("ops-deposit-pool-deposits")).toBeNull();
  });
});
