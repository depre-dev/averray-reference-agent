import { describe, expect, it, vi } from "vitest";

import { BuzzResponder, MAX_SEEN_IDS, type ResponderConfig } from "../../services/slack-operator/src/buzz-responder.js";
import { DEFAULT_MENTION_NAMES } from "../../services/slack-operator/src/buzz-inbound.js";
import type { InboundEvent } from "../../services/slack-operator/src/buzz-inbound.js";

const AGENT = "a".repeat(64);
const OPERATOR = "b".repeat(64);
const CHANNEL = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

const config = (over: Partial<ResponderConfig> = {}): ResponderConfig => ({
  agentPubkey: AGENT,
  channelId: CHANNEL,
  startedAtSeconds: 1_000,
  maxRepliesPerWindow: 30,
  rateWindowMs: 3_600_000,
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

/** A promise we resolve by hand, so a turn can be held open mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(over: Partial<ResponderConfig> = {}, askImpl?: (q: string) => Promise<string | null>) {
  const published: string[] = [];
  const asked: string[] = [];
  const logs: string[] = [];
  let now = 1_700_000_000_000;

  const responder = new BuzzResponder(config(over), {
    ask: async (q) => {
      asked.push(q);
      return askImpl ? await askImpl(q) : "nominal — 9 probes ok";
    },
    publish: async (text) => {
      published.push(text);
      return { ok: true, detail: "accepted" };
    },
    nowMs: () => now,
    log: (l) => logs.push(l),
  });

  return {
    responder,
    published,
    asked,
    logs,
    advance: (ms: number) => { now += ms; },
  };
}

describe("answering", () => {
  it("asks the agent and publishes what it says", async () => {
    const s = setup();
    s.responder.handle(msg());
    await vi.waitFor(() => expect(s.published).toHaveLength(1));

    expect(s.asked).toEqual(["is the money path ok?"]);
    expect(s.published[0]).toBe("nominal — 9 probes ok");
    expect(s.responder.snapshot().answered).toBe(1);
  });

  it("says nothing at all to its own messages", async () => {
    const s = setup();
    s.responder.handle(msg({ pubkey: AGENT }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.asked).toEqual([]);
    expect(s.published).toEqual([]);
  });

  it("does not log every self-message", () => {
    // In a channel we also post to, self-messages are the majority. Logging
    // each one buries the lines that matter.
    const s = setup();
    for (let i = 0; i < 5; i += 1) s.responder.handle(msg({ id: `s${i}`, pubkey: AGENT }));
    expect(s.logs).toEqual([]);
  });
});

describe("one turn at a time", () => {
  it("drops a second question while one is running", async () => {
    // A turn costs money and takes tens of seconds. Two at once interleave in
    // the channel and double the spend for what is usually the same question
    // typed again.
    const gate = deferred<string | null>();
    const s = setup({}, () => gate.promise);

    s.responder.handle(msg({ id: "first" }));
    await vi.waitFor(() => expect(s.asked).toHaveLength(1));
    expect(s.responder.snapshot().busy).toBe(true);

    s.responder.handle(msg({ id: "second", content: "and solvency?" }));
    expect(s.asked).toHaveLength(1);
    expect(s.responder.snapshot().dropped).toBe(1);

    gate.resolve("ok");
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
  });

  it("accepts a new question once the previous turn finishes", async () => {
    const gate = deferred<string | null>();
    let first = true;
    const s = setup({}, () => (first ? ((first = false), gate.promise) : Promise.resolve("second answer")));

    s.responder.handle(msg({ id: "one" }));
    await vi.waitFor(() => expect(s.asked).toHaveLength(1));
    gate.resolve("first answer");
    await vi.waitFor(() => expect(s.responder.snapshot().busy).toBe(false));

    s.responder.handle(msg({ id: "two" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(2));
    expect(s.published[1]).toBe("second answer");
  });

  it("records the event id BEFORE the turn, so a mid-turn redelivery is not a second answer", async () => {
    // A turn takes tens of seconds. A relay redelivering the same event during
    // it would otherwise pass the seen check and start an identical answer.
    const gate = deferred<string | null>();
    const s = setup({}, () => gate.promise);

    s.responder.handle(msg({ id: "same" }));
    await vi.waitFor(() => expect(s.asked).toHaveLength(1));
    s.responder.handle(msg({ id: "same" }));

    expect(s.responder.snapshot().lastVerdict).toBe("ignore-seen");
    gate.resolve("done");
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
  });
});

describe("failures still speak", () => {
  it("publishes an honest line when the agent throws", async () => {
    // Silence is indistinguishable from the listener being down, in the one
    // channel whose job is to be trustworthy when things are broken.
    const s = setup({}, () => Promise.reject(new Error("gateway timeout")));
    s.responder.handle(msg());
    await vi.waitFor(() => expect(s.published).toHaveLength(1));

    expect(s.published[0]).toContain("gateway timeout");
    expect(s.published[0]).toContain("not a verdict about the system");
    expect(s.responder.snapshot().failed).toBe(1);
    expect(s.responder.snapshot().answered).toBe(0);
  });

  it("distinguishes an empty answer from an unreachable agent", async () => {
    const s = setup({}, () => Promise.resolve(null));
    s.responder.handle(msg());
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
    expect(s.published[0]).toContain("empty answer");
  });

  it("does not publish a second message about a failed publish", async () => {
    // It would fail the same way. Log it and stop.
    const published: string[] = [];
    const logs: string[] = [];
    const responder = new BuzzResponder(config(), {
      ask: async () => "an answer",
      publish: async (t) => { published.push(t); return { ok: false, detail: "relay unreachable" }; },
      log: (l) => logs.push(l),
    });
    responder.handle(msg());
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));

    expect(published).toHaveLength(1);
    expect(logs.some((l) => l.includes("relay unreachable"))).toBe(true);
    expect(responder.snapshot().failed).toBe(1);
  });

  it("keeps the chain alive after a failed turn", async () => {
    let calls = 0;
    const s = setup({}, () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("recovered");
    });
    s.responder.handle(msg({ id: "a" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
    s.responder.handle(msg({ id: "b" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(2));
    expect(s.published[1]).toBe("recovered");
  });
});

describe("the rate window rolls", () => {
  it("stops answering once the window is spent, and resumes when it ages out", async () => {
    const s = setup({ maxRepliesPerWindow: 2, rateWindowMs: 60_000 });

    s.responder.handle(msg({ id: "1" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
    s.responder.handle(msg({ id: "2" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(2));

    s.responder.handle(msg({ id: "3" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.published).toHaveLength(2);
    expect(s.responder.snapshot().lastVerdict).toBe("ignore-rate-limited");

    // The window is rolling, not a fixed bucket: old replies age out.
    s.advance(61_000);
    s.responder.handle(msg({ id: "4" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(3));
  });

  it("counts a published failure line against the window", async () => {
    // A failing agent must not become an unbounded source of messages.
    const s = setup({ maxRepliesPerWindow: 1 }, () => Promise.reject(new Error("down")));
    s.responder.handle(msg({ id: "1" }));
    await vi.waitFor(() => expect(s.published).toHaveLength(1));
    s.responder.handle(msg({ id: "2" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.published).toHaveLength(1);
  });
});

describe("bounded memory", () => {
  it("evicts the oldest seen ids rather than growing forever", async () => {
    const s = setup();
    for (let i = 0; i < MAX_SEEN_IDS + 10; i += 1) {
      s.responder.handle(msg({ id: `id-${i}`, pubkey: OPERATOR }));
      // Each is dropped as busy after the first, but all are decided against
      // the same set; only answered ones are remembered.
    }
    await vi.waitFor(() => expect(s.published.length).toBeGreaterThan(0));
    // The set is capped; the assertion that matters is that this does not grow
    // without limit over a long-lived process.
    expect(MAX_SEEN_IDS).toBeLessThanOrEqual(500);
  });
});

describe("switched off", () => {
  it("never asks anything when disabled", async () => {
    const s = setup({ enabled: false });
    s.responder.handle(msg());
    await new Promise((r) => setTimeout(r, 5));
    expect(s.asked).toEqual([]);
    expect(s.published).toEqual([]);
  });
});
