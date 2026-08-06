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

  it("uses the product-health cooldown to damp a REPEATED red", () => {
    const lastPostedAtMs = 1_000;
    const tooSoon = decideOpsNarration({
      prev: "healthy",
      curr: "red",
      probes: probes({ money_path: "red" }),
      network: "mainnet",
      muted: false,
      lastPostedAtMs,
      nowMs: 2_000,
      cooldownMs: 60_000,
    });
    expect(tooSoon).toMatchObject({ post: false, edge: "red", suppressed: "cooldown" });

    const redAgain = decideOpsNarration({
      prev: "healthy",
      curr: "red",
      probes: probes({ money_path: "red" }),
      network: "mainnet",
      muted: false,
      lastPostedAtMs,
      nowMs: 61_000,
      cooldownMs: 60_000,
    });
    expect(redAgain.post).toBe(true);
    expect(redAgain.edge).toBe("red");
  });

  // ── 2026-08-06 ────────────────────────────────────────────────────────────
  // The red was announced, Buzz-published and paged. Five minutes later the
  // probe recovered and the all-clear was dropped on the floor:
  //   {"edge":"recovered","suppressed":"cooldown","msg":"ops_narration_suppressed"}
  // The cooldown defaults to six hours, so this did not delay the recovery
  // message — it deleted it. The last thing any human heard was a false alarm.
  describe("an announced red is always closed", () => {
    it("publishes the recovery INSIDE the cooldown window when the red was announced", () => {
      const cooldownMs = 6 * 60 * 60 * 1000; // the shipped default
      const red = decideOpsNarration({
        prev: "healthy",
        curr: "red",
        probes: probes({ money_path: "red" }),
        network: "mainnet",
        muted: false,
        lastPostedAtMs: 0,
        nowMs: 1_000,
        cooldownMs,
      });
      expect(red.post).toBe(true);
      expect(red.redAnnounced).toBe(true);

      // Recovery five minutes later — deep inside the six-hour cooldown.
      const recovered = decideOpsNarration({
        prev: "red",
        curr: "healthy",
        probes: probes(),
        network: "mainnet",
        muted: false,
        lastPostedAtMs: 1_000,
        nowMs: 1_000 + 5 * 60 * 1000,
        cooldownMs,
        redAnnounced: red.redAnnounced,
      });
      expect(recovered.post).toBe(true);
      expect(recovered.suppressed).toBeUndefined();
      expect(recovered.edge).toBe("recovered");
      expect(recovered.text).toContain("Ops recovered");
      // …and the incident is now closed, so nothing is left owed.
      expect(recovered.redAnnounced).toBe(false);
    });

    it("stays quiet about a red it suppressed itself", () => {
      const cooldownMs = 60_000;
      const suppressedRed = decideOpsNarration({
        prev: "healthy",
        curr: "red",
        probes: probes({ money_path: "red" }),
        network: "mainnet",
        muted: false,
        lastPostedAtMs: 1_000,
        nowMs: 2_000,
        cooldownMs,
      });
      expect(suppressedRed).toMatchObject({ post: false, suppressed: "cooldown", redAnnounced: false });

      const recovered = decideOpsNarration({
        prev: "red",
        curr: "healthy",
        probes: probes(),
        network: "mainnet",
        muted: false,
        lastPostedAtMs: 1_000,
        nowMs: 3_000,
        cooldownMs,
        redAnnounced: suppressedRed.redAnnounced,
      });
      // An all-clear for an alarm nobody was given implies there was something
      // to be clear of.
      expect(recovered.post).toBe(false);
      expect(recovered.suppressed).toBe("never-announced");
    });

    it("closes an incident inherited across a restart (no bookkeeping ≠ never announced)", () => {
      // A fresh process booted into an ongoing red a previous one announced.
      const recovered = decideOpsNarration({
        prev: "red",
        curr: "healthy",
        probes: probes(),
        network: "mainnet",
        muted: false,
        lastPostedAtMs: 1_000,
        nowMs: 2_000,
        cooldownMs: 60_000,
        // redAnnounced deliberately absent
      });
      expect(recovered.post).toBe(true);
    });

    it("keeps the announced red open across ticks until something closes it", () => {
      const stillRed = decideOpsNarration({
        prev: "red",
        curr: "red",
        probes: probes({ money_path: "red" }),
        network: "mainnet",
        muted: false,
        redAnnounced: true,
      });
      expect(stillRed.post).toBe(false);
      expect(stillRed.redAnnounced).toBe(true);
    });

    it("mute silences both edges, and leaves no alarm owed", () => {
      // Mute is an explicit operator action, not an automatic damper: it
      // silences the opening red too, so nothing is left dangling.
      const red = decideOpsNarration({
        prev: "healthy",
        curr: "red",
        probes: probes({ money_path: "red" }),
        network: "mainnet",
        muted: true,
      });
      expect(red).toMatchObject({ post: false, suppressed: "muted", redAnnounced: false });

      const recovered = decideOpsNarration({
        prev: "red",
        curr: "healthy",
        probes: probes(),
        network: "mainnet",
        muted: true,
        redAnnounced: red.redAnnounced,
      });
      expect(recovered).toMatchObject({ post: false, suppressed: "muted", redAnnounced: false });
    });
  });
});
