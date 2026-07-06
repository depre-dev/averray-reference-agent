// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DepsDeployZone } from "./DepsDeployZone.js";
import type { ProductHealth, RemediationStatus } from "../../lib/monitor/product-health.js";

afterEach(cleanup);

const health = (remediation?: RemediationStatus): ProductHealth => ({
  enabled: true,
  at: 1,
  status: "healthy",
  checks: 5,
  probes: [{ name: "product_api", status: "ok", detail: "200", sparkline: [] }],
  remediation,
});

const rem = (state: RemediationStatus["state"], detail: string, onBackup = false): RemediationStatus => ({
  state,
  enabled: state !== "off",
  activeEndpoint: "https://eth-rpc-testnet.polkadot.io/",
  onBackup,
  detail,
});

describe("DepsDeployZone — RPC failover row", () => {
  test("no row when remediation is absent or off", () => {
    expect(render(<DepsDeployZone health={health()} />).queryByTestId("ops-remediation")).toBeNull();
    cleanup();
    expect(
      render(<DepsDeployZone health={health(rem("off", "auto-remediation off"))} />).queryByTestId("ops-remediation"),
    ).toBeNull();
  });

  test("armed → calm sage row", () => {
    const row = render(<DepsDeployZone health={health(rem("armed", "armed · primary eth-rpc-testnet.polkadot.io"))} />).getByTestId("ops-remediation");
    expect(row.className).toContain("ops-deploy-row--ok");
    expect(row.textContent).toContain("armed");
  });

  test("failover → amber row", () => {
    const row = render(<DepsDeployZone health={health(rem("failover", "reading backup services.polkadothub-rpc.com", true))} />).getByTestId("ops-remediation");
    expect(row.className).toContain("ops-deploy-row--degraded");
    expect(row.textContent).toContain("reading backup");
  });

  test("halted → coral row", () => {
    const row = render(<DepsDeployZone health={health(rem("halted", "halted — RPC unhealthy, needs an operator"))} />).getByTestId("ops-remediation");
    expect(row.className).toContain("ops-deploy-row--red");
    expect(row.textContent).toContain("halted");
  });
});
