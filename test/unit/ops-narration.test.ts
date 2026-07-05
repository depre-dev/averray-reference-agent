import { describe, expect, it } from "vitest";
import { decideOpsNarration, type OpsNarrationProbe } from "../../services/slack-operator/src/ops-narration.js";

const probes = (over: Partial<Record<string, string>> = {}): OpsNarrationProbe[] => [
  { name: "product_api", status: "ok", detail: "200" },
  { name: "chain_height", status: over.chain_height ?? "ok", detail: "block #9,481,204 · 3s old" },
  { name: "money_path", status: over.money_path ?? "ok", detail: "6 stuck ≥ threshold — settlements not landing" },
];

describe("decideOpsNarration", () => {
  it("does not narrate the boot transition (prev unknown)", () => {
    expect(decideOpsNarration({ prev: "unknown", curr: "red", probes: probes({ money_path: "red" }), network: "mainnet", muted: false }).post).toBe(false);
  });

  it("does not narrate a routine degraded↔healthy move", () => {
    expect(decideOpsNarration({ prev: "healthy", curr: "degraded", probes: probes(), network: "testnet", muted: false }).post).toBe(false);
    expect(decideOpsNarration({ prev: "degraded", curr: "healthy", probes: probes(), network: "testnet", muted: false }).post).toBe(false);
  });

  it("narrates entering red and names the lead red probe", () => {
    const d = decideOpsNarration({ prev: "degraded", curr: "red", probes: probes({ money_path: "red" }), network: "mainnet", muted: false });
    expect(d.post).toBe(true);
    expect(d.edge).toBe("red");
    expect(d.text).toContain("Money path red");
    expect(d.text).toContain("settlements not landing");
    expect(d.text).toContain("On-call is paged.");
  });

  it("tones a testnet red as informational, not paging", () => {
    const d = decideOpsNarration({ prev: "healthy", curr: "red", probes: probes({ money_path: "red" }), network: "testnet", muted: false });
    expect(d.text).toContain("Testnet — informational.");
    expect(d.text).not.toContain("paged");
  });

  it("appends +N when several probes are red", () => {
    const d = decideOpsNarration({ prev: "healthy", curr: "red", probes: probes({ chain_height: "red", money_path: "red" }), network: "mainnet", muted: false });
    expect(d.text).toContain("(+1 more)");
  });

  it("narrates recovery from red", () => {
    const d = decideOpsNarration({ prev: "red", curr: "degraded", probes: probes(), network: "testnet", muted: false });
    expect(d.post).toBe(true);
    expect(d.edge).toBe("recovered");
    expect(d.text).toContain("Ops recovered");
    expect(d.text).toContain("degraded");
  });

  it("stays quiet while red persists (no edge)", () => {
    expect(decideOpsNarration({ prev: "red", curr: "red", probes: probes({ money_path: "red" }), network: "mainnet", muted: false }).post).toBe(false);
  });

  it("mute suppresses the post but reports the edge", () => {
    const d = decideOpsNarration({ prev: "healthy", curr: "red", probes: probes({ money_path: "red" }), network: "mainnet", muted: true });
    expect(d.post).toBe(false);
    expect(d.edge).toBe("red");
    expect(d.suppressed).toBe("muted");
  });
});
