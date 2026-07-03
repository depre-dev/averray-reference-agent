import { describe, expect, it } from "vitest";

import {
  probeLabel,
  probeTone,
  hasFreshRed,
  overallSummary,
  overallToneClass,
  type ProductHealth,
} from "./product-health.js";

const mk = (over: Partial<ProductHealth> = {}): ProductHealth => ({
  enabled: true,
  at: 1,
  status: "healthy",
  checks: 5,
  probes: [],
  ...over,
});

const red = (names: string[]): ProductHealth =>
  mk({ status: "red", probes: names.map((n) => ({ name: n, status: "red" as const, detail: "", sparkline: [] })) });

describe("probeLabel", () => {
  it("maps known probes and humanizes the rest", () => {
    expect(probeLabel("product_api")).toBe("Product API");
    expect(probeLabel("signer_liquidity")).toBe("Signer liquidity");
    expect(probeLabel("weird_thing")).toBe("Weird thing");
  });
});

describe("probeTone", () => {
  it("maps a probe status onto the --hm-state family", () => {
    expect(probeTone("ok")).toBe("pass");
    expect(probeTone("degraded")).toBe("degraded");
    expect(probeTone("red")).toBe("fail");
  });
});

describe("hasFreshRed (drives the auto-flip)", () => {
  it("is false when next isn't red", () => {
    expect(hasFreshRed(undefined, mk())).toBe(false);
    expect(hasFreshRed(red(["a"]), mk({ status: "degraded" }))).toBe(false);
  });
  it("is true on a first-seen red", () => {
    expect(hasFreshRed(undefined, red(["a"]))).toBe(true);
  });
  it("is false when the same probe was already red last poll (once per incident)", () => {
    expect(hasFreshRed(red(["a"]), red(["a"]))).toBe(false);
  });
  it("is true when a NEW probe crosses into red", () => {
    expect(hasFreshRed(red(["a"]), red(["a", "b"]))).toBe(true);
  });
});

describe("overallSummary (truth-boundary honest)", () => {
  it("distinguishes off / awaiting / degraded / healthy / red", () => {
    expect(overallSummary(mk({ enabled: false })).tone).toBe("off");
    expect(overallSummary(mk({ checks: 0 })).tone).toBe("idle");
    expect(overallSummary(mk({ status: "degraded" })).label).toBe("degraded · safe");
    expect(overallSummary(mk({ status: "healthy" })).label).toBe("all healthy");
    const r = overallSummary(red(["x"]));
    expect(r.tone).toBe("red");
    expect(r.label).toBe("1 probe red");
    expect(overallSummary(red(["x", "y"])).label).toBe("2 probes red");
  });
});

describe("overallToneClass", () => {
  it("maps tones onto --hm-state families (muted for off/idle)", () => {
    expect(overallToneClass("healthy")).toBe("pass");
    expect(overallToneClass("red")).toBe("fail");
    expect(overallToneClass("degraded")).toBe("degraded");
    expect(overallToneClass("off")).toBe("muted");
    expect(overallToneClass("idle")).toBe("muted");
  });
});
