import { describe, expect, it } from "vitest";

import {
  composeConversationalDigest,
  conversationalDigestViolation,
  digestFactTokens,
} from "../../services/slack-operator/src/digest-voice.js";

const HEADLINE = "Nominal — money moving, floors clear.";
const FACTS = ["14 settled in 24h, backlog 0", "gas ×3.2, bank ×5.1", "request 0x9d9a staged"];
const PLAIN = [
  "Good morning — all 3 probes green on Averray mainnet.",
  `The board reads: "${HEADLINE}"`,
  "Money: 14 settled in 24h, backlog 0",
].join("\n");

const input = (over: Record<string, unknown> = {}) => ({
  plain: PLAIN,
  verdictHeadline: HEADLINE,
  facts: FACTS,
  redCount: 0,
  ...over,
});

/** A compliant Hermes draft: every figure verbatim, headline quoted whole. */
const GOOD =
  `Morning! Quiet board — 14 settled in 24h with a backlog of 0, gas at 3.2× and the bank at 5.1× their floors, ` +
  `and request 0x9d9a staged. The board reads: "${HEADLINE}" Nothing is waiting on you today.`;

describe("digestFactTokens", () => {
  it("extracts numbers and hex ids, deduped", () => {
    const tokens = digestFactTokens(FACTS);
    expect(tokens).toContain("14");
    expect(tokens).toContain("3.2");
    expect(tokens).toContain("0x9d9a");
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("conversationalDigestViolation", () => {
  it("passes prose that reworded the phrasing but kept every figure", () => {
    expect(conversationalDigestViolation(input(), GOOD)).toBeNull();
  });

  it("names the missing figure — the model rounded 3.2 away", () => {
    const rounded = GOOD.replace("3.2", "about 3");
    expect(conversationalDigestViolation(input(), rounded)).toBe("fact_missing:3.2");
  });

  it("requires the verdict headline verbatim, not paraphrased", () => {
    const paraphrased = GOOD.replace(HEADLINE, "everything looks nominal");
    expect(conversationalDigestViolation(input(), paraphrased)).toBe("headline_missing");
  });

  it("refuses green words over a red board", () => {
    const lying = `${GOOD} All clear!`;
    expect(conversationalDigestViolation(input({ redCount: 1 }), lying)).toBe("polarity");
  });

  it("requires every attention item to be NAMED — numbers or not", () => {
    // A red probe whose detail carries no digits would otherwise be droppable
    // without tripping the fact gate.
    const v = conversationalDigestViolation(input({ attentionLabels: ["Product API"] }), GOOD);
    expect(v).toBe("attention_missing:Product API");
  });

  it("accepts the attention name case-insensitively inside flowing prose", () => {
    const v = conversationalDigestViolation(
      input({ attentionLabels: ["Product API"] }),
      `${GOOD} Meanwhile the product API needs eyes.`,
    );
    expect(v).toBeNull();
  });

  it("refuses empty and rambling drafts", () => {
    expect(conversationalDigestViolation(input(), "   ")).toBe("empty");
    expect(conversationalDigestViolation(input(), GOOD + " padding".repeat(300))).toBe("too_long");
  });
});

describe("composeConversationalDigest", () => {
  it("ships Hermes's words when the gate passes", async () => {
    const r = await composeConversationalDigest({ ...input(), request: async () => GOOD });
    expect(r.voice).toBe("hermes");
    expect(r.text).toBe(GOOD);
    expect(r.reason).toBeUndefined();
  });

  it("falls back to plain, with the named reason, when a figure is lost", async () => {
    const r = await composeConversationalDigest({
      ...input(),
      request: async () => GOOD.replace("14", "fourteen"),
    });
    expect(r.voice).toBe("plain");
    expect(r.text).toBe(PLAIN);
    expect(r.reason).toBe("fact_missing:14");
  });

  it("falls back to plain when the model is unreachable", async () => {
    const r = await composeConversationalDigest({ ...input(), request: async () => null });
    expect(r).toEqual({ text: PLAIN, voice: "plain", reason: "llm_unavailable" });
  });

  it("falls back to plain when the request throws — never to a missing digest", async () => {
    const r = await composeConversationalDigest({
      ...input(),
      request: async () => {
        throw new Error("socket hangup");
      },
    });
    expect(r.voice).toBe("plain");
    expect(r.reason).toBe("llm_unavailable");
  });
});
