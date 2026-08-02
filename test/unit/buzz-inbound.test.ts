import { describe, expect, it } from "vitest";

import {
  DEFAULT_MENTION_NAMES,
  MAX_REPLY_CHARS,
  buildInboundPrompt,
  decideInboundMessage,
  describeInboundFailure,
  formatReplyForBuzz,
  replyFitsRelay,
  type InboundContext,
  type InboundEvent,
} from "../../services/slack-operator/src/buzz-inbound.js";

const AGENT = "a".repeat(64);
const OPERATOR = "b".repeat(64);
const CHANNEL = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

const ctx = (over: Partial<InboundContext> = {}): InboundContext => ({
  agentPubkey: AGENT,
  channelId: CHANNEL,
  startedAtSeconds: 1_000,
  seenEventIds: new Set(),
  repliesInWindow: 0,
  maxRepliesPerWindow: 30,
  requireMention: false,
  mentionNames: DEFAULT_MENTION_NAMES,
  enabled: true,
  ...over,
});

const msg = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  id: "e1",
  pubkey: OPERATOR,
  kind: 9,
  tags: [["h", CHANNEL]],
  content: "is the money path ok?",
  created_at: 2_000,
  ...over,
});

describe("the loop guard", () => {
  it("NEVER answers a message published by this agent", () => {
    // The single most important rule in this file. The narration publisher and
    // this listener share one agent key, so without this an alert posted to
    // #Ops is a question the agent asks itself, and the answer is another one.
    const r = decideInboundMessage(msg({ pubkey: AGENT }), ctx());
    expect(r.verdict).toBe("ignore-self");
    expect(r.question).toBeUndefined();
  });

  it("ignores our own message even when it names the agent", () => {
    // Narration could easily contain the word "Hermes". Mention-matching must
    // not be a way back into the loop.
    const r = decideInboundMessage(
      msg({ pubkey: AGENT, content: "Hermes: money_path recovered" }),
      ctx({ requireMention: true }),
    );
    expect(r.verdict).toBe("ignore-self");
  });

  it("does not let our own messages consume the rate-limit window", () => {
    // Rate limiting is evaluated LAST on purpose. If self-messages burned the
    // window, a chatty incident would disarm the backstop precisely when the
    // loop it guards against would be most expensive.
    const r = decideInboundMessage(
      msg({ pubkey: AGENT }),
      ctx({ repliesInWindow: 999, maxRepliesPerWindow: 1 }),
    );
    expect(r.verdict).toBe("ignore-self");
  });
});

describe("replay and redelivery", () => {
  it("ignores a message older than this listener", () => {
    // Relays replay stored events on connect and again on every reconnect.
    // Answering them means each restart re-answers the last question — the same
    // shape as the duplicate #Ops alerts that reached production.
    const r = decideInboundMessage(msg({ created_at: 999 }), ctx({ startedAtSeconds: 1_000 }));
    expect(r.verdict).toBe("ignore-replay");
    expect(r.detail).toContain("1s");
  });

  it("answers a message sent exactly at startup", () => {
    // The boundary must not swallow a live question by an off-by-one.
    const r = decideInboundMessage(msg({ created_at: 1_000 }), ctx({ startedAtSeconds: 1_000 }));
    expect(r.verdict).toBe("answer");
  });

  it("ignores an event id it has already handled", () => {
    const r = decideInboundMessage(msg({ id: "dup" }), ctx({ seenEventIds: new Set(["dup"]) }));
    expect(r.verdict).toBe("ignore-seen");
  });
});

describe("addressing", () => {
  it("answers anything in the channel when a mention is not required", () => {
    expect(decideInboundMessage(msg(), ctx()).verdict).toBe("answer");
  });

  it("requires the agent's name when configured to", () => {
    const r = decideInboundMessage(msg({ content: "what a day" }), ctx({ requireMention: true }));
    expect(r.verdict).toBe("ignore-not-addressed");
  });

  it("strips a leading mention so the question is what gets asked", () => {
    // A model handed its own name as the first token sometimes answers about
    // itself rather than the question.
    const r = decideInboundMessage(
      msg({ content: "@hermes is the money path ok?" }),
      ctx({ requireMention: true }),
    );
    expect(r.verdict).toBe("answer");
    expect(r.question).toBe("is the money path ok?");
  });

  it("keeps a mention that is part of the question", () => {
    const r = decideInboundMessage(
      msg({ content: "who manages hermes?" }),
      ctx({ requireMention: true }),
    );
    expect(r.question).toBe("who manages hermes?");
  });

  it("says nothing to a message that is only a mention", () => {
    const r = decideInboundMessage(msg({ content: "@hermes" }), ctx({ requireMention: true }));
    expect(r.verdict).toBe("ignore-empty");
  });
});

describe("structural rejections", () => {
  it("ignores non-message kinds", () => {
    expect(decideInboundMessage(msg({ kind: 0 }), ctx()).verdict).toBe("ignore-kind");
  });

  it("ignores a message tagged for another channel", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(decideInboundMessage(msg({ tags: [["h", other]] }), ctx()).verdict).toBe("ignore-channel");
  });

  it("ignores a message with no channel tag at all", () => {
    const r = decideInboundMessage(msg({ tags: [] }), ctx());
    expect(r.verdict).toBe("ignore-channel");
    expect(r.detail).toContain("no channel tag");
  });

  it("ignores whitespace-only content", () => {
    expect(decideInboundMessage(msg({ content: "   \n " }), ctx()).verdict).toBe("ignore-empty");
  });

  it("is silent when the feature is switched off", () => {
    expect(decideInboundMessage(msg(), ctx({ enabled: false })).verdict).toBe("ignore-disabled");
  });
});

describe("rate limiting", () => {
  it("stops answering once the window is spent", () => {
    const r = decideInboundMessage(msg(), ctx({ repliesInWindow: 30, maxRepliesPerWindow: 30 }));
    expect(r.verdict).toBe("ignore-rate-limited");
    expect(r.detail).toContain("30");
  });

  it("still answers on the last reply of the window", () => {
    const r = decideInboundMessage(msg(), ctx({ repliesInWindow: 29, maxRepliesPerWindow: 30 }));
    expect(r.verdict).toBe("answer");
  });
});

describe("the prompt", () => {
  it("tells the agent to check the board rather than answer from memory", () => {
    const prompt = buildInboundPrompt("is averray ok?");
    expect(prompt).toContain("not from memory");
    expect(prompt).toContain("is averray ok?");
  });

  it("says UNKNOWN is the answer when the board cannot be reached", () => {
    // The same rule the board-health tool carries. Both paths must agree, or
    // the agent has two policies for the same situation.
    expect(buildInboundPrompt("x")).toContain("UNKNOWN");
  });

  it("forbids taking action", () => {
    expect(buildInboundPrompt("x").toLowerCase()).toContain("do not take actions");
  });
});

describe("formatting the reply", () => {
  it("returns null for nothing to say, so the caller can be honest instead", () => {
    // Publishing empty content throws at the event builder, and silence in an
    // ops channel is indistinguishable from the listener being down.
    expect(formatReplyForBuzz("")).toBeNull();
    expect(formatReplyForBuzz("   ")).toBeNull();
    expect(formatReplyForBuzz(null)).toBeNull();
    expect(formatReplyForBuzz(undefined)).toBeNull();
  });

  it("passes a normal answer through untouched", () => {
    expect(formatReplyForBuzz("  nominal, 9 probes ok  ")).toBe("nominal, 9 probes ok");
  });

  it("MARKS truncation rather than cutting silently", () => {
    // A cut-off ops answer that looks complete is a way to be confidently wrong.
    const long = "x".repeat(MAX_REPLY_CHARS + 500);
    const out = formatReplyForBuzz(long)!;
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(long.length);
  });

  it("produces something the relay will accept", () => {
    expect(replyFitsRelay(formatReplyForBuzz("y".repeat(MAX_REPLY_CHARS * 2))!)).toBe(true);
  });
});

describe("failure lines", () => {
  it("says the failure is ours, not a verdict about the system", () => {
    // THE TRUTH BOUNDARY, in one sentence. "I could not answer" must never be
    // readable as "the system is fine" or as "the system is broken".
    const line = describeInboundFailure("the agent session timed out");
    expect(line).toContain("the agent session timed out");
    expect(line).toContain("not a verdict about the system");
  });
});
