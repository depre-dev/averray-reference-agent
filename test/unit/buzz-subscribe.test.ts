import { describe, expect, it } from "vitest";

import type { BuzzConfig } from "../../services/slack-operator/src/buzz-client.js";
import {
  buildReqFrame,
  describeListenerRow,
  eventFromFrame,
  nextRetryDelayMs,
  subscribeToBuzz,
  type ListenerState,
} from "../../services/slack-operator/src/buzz-subscribe.js";
import type { InboundEvent } from "../../services/slack-operator/src/buzz-inbound.js";

const CHANNEL = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const SECRET = "1".repeat(64);
const OWNER = "c".repeat(64);

const config: BuzzConfig = {
  relayUrl: "wss://relay.test",
  agentSecretKeyHex: SECRET,
  authTag: ["auth", OWNER, "conditions", "sig"],
  channelId: CHANNEL,
};

/** A socket we drive by hand, so every branch is reachable without a relay. */
class FakeSocket {
  handlers: Record<string, Array<(e: any) => void>> = {};
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, handler: (e: any) => void): void {
    (this.handlers[type] ??= []).push(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event: unknown = {}): void {
    for (const h of this.handlers[type] ?? []) h(event);
  }
  frame(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  /** Frames sent, parsed, for readable assertions. */
  parsed(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/** Timer control: nothing sleeps, and every pending callback is nameable. */
function harness() {
  const timers: Array<{ fn: () => void; ms: number; handle: number }> = [];
  let next = 1;
  const sockets: FakeSocket[] = [];
  const states: ListenerState[] = [];
  const messages: InboundEvent[] = [];

  return {
    sockets,
    states,
    messages,
    timers,
    options: {
      openSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      nowMs: () => 1_700_000_000_000,
      setTimer: (fn: () => void, ms: number) => {
        const handle = next++;
        timers.push({ fn, ms, handle });
        return handle;
      },
      clearTimer: (h: unknown) => {
        const i = timers.findIndex((t) => t.handle === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    handlers: {
      onMessage: (e: InboundEvent) => messages.push(e),
      onState: (s: ListenerState) => states.push(s),
    },
    /** Run the longest-pending timer, which is the one under test. */
    fireLongest(): void {
      const t = [...timers].sort((a, b) => b.ms - a.ms)[0];
      if (!t) throw new Error("no timer pending");
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    },
    fireShortest(): void {
      const t = [...timers].sort((a, b) => a.ms - b.ms)[0];
      if (!t) throw new Error("no timer pending");
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    },
  };
}

describe("buildReqFrame", () => {
  it("asks only for channel messages, and only new ones", () => {
    // `since` is not an optimisation: without it every reconnect replays the
    // channel's history at us.
    const frame = JSON.parse(buildReqFrame(CHANNEL, 1_700));
    expect(frame[0]).toBe("REQ");
    expect(frame[2]).toEqual({ kinds: [9], "#h": [CHANNEL], since: 1_700 });
  });
});

describe("eventFromFrame", () => {
  it("parses a well-formed EVENT", () => {
    const e = eventFromFrame(["EVENT", "sub", {
      id: "i", pubkey: "p", kind: 9, tags: [["h", CHANNEL]], content: "hi", created_at: 5,
    }]);
    expect(e).toMatchObject({ id: "i", kind: 9, content: "hi" });
  });

  it("rejects anything malformed rather than half-parsing it", () => {
    // A partially-parsed event would reach the decision layer missing the very
    // fields its guards key on — pubkey and created_at.
    expect(eventFromFrame(["EVENT", "sub", { id: "i" }])).toBeNull();
    expect(eventFromFrame(["EOSE", "sub"])).toBeNull();
    expect(eventFromFrame("nonsense")).toBeNull();
    expect(eventFromFrame(["EVENT", "sub", null])).toBeNull();
  });

  it("drops non-string tag entries instead of trusting them", () => {
    const e = eventFromFrame(["EVENT", "sub", {
      id: "i", pubkey: "p", kind: 9, tags: [["h", CHANNEL], [1, 2], "x"], content: "hi", created_at: 5,
    }]);
    expect(e!.tags).toEqual([["h", CHANNEL]]);
  });
});

describe("the handshake", () => {
  it("answers AUTH and subscribes in the same breath", () => {
    const h = harness();
    subscribeToBuzz(config, h.handlers, { ...h.options, sinceSeconds: 42 });
    h.sockets[0]!.frame(["AUTH", "challenge-1"]);

    const sent = h.sockets[0]!.parsed();
    expect((sent[0] as any[])[0]).toBe("AUTH");
    expect((sent[1] as any[])[0]).toBe("REQ");
    expect((sent[1] as any[])[2].since).toBe(42);
  });

  it("only claims to be listening once the relay says EOSE", () => {
    // Before EOSE the subscription may not have been accepted at all. Claiming
    // to listen early is the same lie as a fake green.
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.frame(["AUTH", "c"]);
    expect(sub.state().phase).toBe("authenticating");

    h.sockets[0]!.frame(["EOSE", "avg-ops"]);
    expect(sub.state().phase).toBe("listening");
  });

  it("stops rather than spins when the signing key is unusable", () => {
    // Retrying cannot fix a bad key, and a tight reconnect loop against a
    // relay is a way to turn our configuration error into their outage.
    const h = harness();
    const sub = subscribeToBuzz({ ...config, agentSecretKeyHex: "nope" }, h.handlers, h.options);
    expect(sub.state().phase).toBe("misconfigured");
    expect(h.sockets).toHaveLength(0);
  });
});

describe("delivery", () => {
  it("hands channel messages to the callback", () => {
    const h = harness();
    subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.frame(["EOSE", "avg-ops"]);
    h.sockets[0]!.frame(["EVENT", "avg-ops", {
      id: "e1", pubkey: "op", kind: 9, tags: [["h", CHANNEL]], content: "ok?", created_at: 9,
    }]);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.content).toBe("ok?");
  });

  it("survives a handler that throws", () => {
    // A callback failure must not take down the socket whose job is to notice
    // when things are broken.
    const h = harness();
    subscribeToBuzz(config, { onMessage: () => { throw new Error("boom"); } }, h.options);
    expect(() => h.sockets[0]!.frame(["EVENT", "avg-ops", {
      id: "e", pubkey: "p", kind: 9, tags: [["h", CHANNEL]], content: "x", created_at: 1,
    }])).not.toThrow();
  });

  it("forwards stored events too, leaving replay rejection to one place", () => {
    // Duplicating the replay rule here would create a second place for it to be
    // wrong. The decision layer owns it.
    const h = harness();
    subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.frame(["EVENT", "avg-ops", {
      id: "old", pubkey: "op", kind: 9, tags: [["h", CHANNEL]], content: "ancient", created_at: 1,
    }]);
    expect(h.messages).toHaveLength(1);
  });
});

describe("staying alive", () => {
  it("reconnects when the relay closes", () => {
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.emit("close");
    expect(sub.state().phase).toBe("retrying");

    h.fireShortest(); // the retry timer
    expect(h.sockets).toHaveLength(2);
  });

  it("presumes a silent socket is dead and replaces it", () => {
    // THE OBJECTION buzz-client.ts raises against persistent sockets: one that
    // is half-dead looks exactly like a quiet channel. The watchdog is the
    // answer, and this test is why the answer is real.
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, { ...h.options, idleTimeoutMs: 600_000 });
    h.sockets[0]!.frame(["EOSE", "avg-ops"]);
    expect(sub.state().phase).toBe("listening");

    h.fireLongest(); // the idle watchdog
    expect(sub.state().phase).toBe("retrying");
    expect(sub.state().detail).toContain("presuming the socket is dead");
  });

  it("counts ANY frame as proof of life, not just messages", () => {
    // Treating only messages as liveness would churn the connection on a
    // healthy but quiet channel — which is the normal state of an ops channel.
    const h = harness();
    subscribeToBuzz(config, h.handlers, { ...h.options, idleTimeoutMs: 600_000 });
    const before = h.timers.find((t) => t.ms === 600_000)!.handle;
    h.sockets[0]!.frame(["NOTICE", "just saying hello"]);
    const after = h.timers.find((t) => t.ms === 600_000)!.handle;
    expect(after).not.toBe(before); // the countdown was restarted
  });

  it("reports a closed subscription with the relay's reason", () => {
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.frame(["CLOSED", "avg-ops", "auth-required: not a member"]);
    expect(sub.state().phase).toBe("retrying");
    expect(sub.state().detail).toContain("not a member");
  });

  it("stops for good when closed, with no further reconnects", () => {
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, h.options);
    sub.close();
    expect(sub.state().phase).toBe("closed");
    h.sockets[0]!.emit("close");
    expect(sub.state().phase).toBe("closed");
    expect(h.sockets).toHaveLength(1);
  });

  it("clears the failure count once it is genuinely listening", () => {
    const h = harness();
    const sub = subscribeToBuzz(config, h.handlers, h.options);
    h.sockets[0]!.emit("close");
    expect(sub.state().failures).toBe(1);
    h.fireShortest();
    h.sockets[1]!.frame(["EOSE", "avg-ops"]);
    expect(sub.state().failures).toBe(0);
  });
});

describe("nextRetryDelayMs", () => {
  it("backs off exponentially and stops at the ceiling", () => {
    expect(nextRetryDelayMs(1, 2_000, 60_000)).toBeLessThan(2_600);
    expect(nextRetryDelayMs(3, 2_000, 60_000)).toBeGreaterThan(6_000);
    for (const n of [10, 20, 50]) {
      expect(nextRetryDelayMs(n, 2_000, 60_000)).toBeLessThanOrEqual(60_000 * 1.1);
    }
  });

  it("jitters, so a restarting relay is not hit on the same instant every time", () => {
    const seen = new Set(Array.from({ length: 24 }, () => nextRetryDelayMs(4, 2_000, 60_000)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("describeListenerRow", () => {
  it("calls only 'listening' ok", () => {
    // Every other phase means questions go unanswered, and a retrying listener
    // looks exactly like a channel nobody has posted in.
    expect(describeListenerRow({ phase: "listening", detail: "", failures: 0 }).status).toBe("ok");
    for (const phase of ["connecting", "authenticating", "retrying", "misconfigured"] as const) {
      expect(describeListenerRow({ phase, detail: "why", failures: 1 }).status).toBe("degraded");
    }
  });

  it("distinguishes off from broken", () => {
    // A feature switched off must never render as a failure, and vice versa.
    expect(describeListenerRow(null).status).toBe("off");
    expect(describeListenerRow({ phase: "closed", detail: "", failures: 0 }).status).toBe("off");
  });
});
