import { describe, expect, it } from "vitest";

import {
  attachmentFromDockerInspect,
  BANK_NETWORK_DETACHED,
  decideBankNetworkAttachment,
} from "../../services/slack-operator/src/bank-network.js";

describe("bank network attachment", () => {
  it("fires when the overlay is missing and the network exists", () => {
    const report = decideBankNetworkAttachment({
      networkExists: true,
      containers: ["platform-backend"],
      self: "slack-operator",
    });
    expect(report.attached).toBe(false);
    expect(report.detail).toBe(BANK_NETWORK_DETACHED);
    expect(report.detail).toContain("ops/deploy-monitor.sh");
  });

  it("stays quiet when the network itself is absent", () => {
    const report = decideBankNetworkAttachment({ networkExists: false, self: "slack-operator" });
    expect(report.detail).toBeUndefined();
    expect(report.networkExists).toBe(false);
  });

  it("reads docker network inspect and fires when this container is not a member", () => {
    const report = attachmentFromDockerInspect({
      selfId: "abc123def456",
      inspect: [{
        Name: "agent-mainnet-internal",
        Containers: {
          fff999: { Name: "agent-mainnet-backend" },
        },
      }],
    });
    expect(report.networkExists).toBe(true);
    expect(report.attached).toBe(false);
    expect(report.detail).toBe(BANK_NETWORK_DETACHED);
  });

  it("is attached when the container id is a member", () => {
    const report = attachmentFromDockerInspect({
      selfId: "abc123def456",
      inspect: [{
        Name: "agent-mainnet-internal",
        Containers: {
          abc123def4567890: { Name: "avg-slack-operator-1" },
        },
      }],
    });
    expect(report.attached).toBe(true);
    expect(report.detail).toBeUndefined();
  });
});
