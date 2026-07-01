import { describe, expect, it } from "vitest";

import {
  copilotStreamSubscriberCount,
  emitCopilotStreamEvent,
  onCopilotStreamEvent,
  type CopilotStreamEvent,
} from "../../services/slack-operator/src/monitor-copilot-stream.js";

describe("monitor-copilot-stream event bus", () => {
  it("broadcasts events to every subscriber and unsubscribes cleanly", () => {
    const a: CopilotStreamEvent[] = [];
    const b: CopilotStreamEvent[] = [];
    const offA = onCopilotStreamEvent((e) => a.push(e));
    const offB = onCopilotStreamEvent((e) => b.push(e));
    expect(copilotStreamSubscriberCount()).toBe(2);

    const delta: CopilotStreamEvent = {
      type: "hermes.delta",
      payload: { turnId: "t1", delta: "hi", addressedTo: "everyone" },
    };
    emitCopilotStreamEvent(delta);
    expect(a).toEqual([delta]);
    expect(b).toEqual([delta]);

    offA();
    expect(copilotStreamSubscriberCount()).toBe(1);
    const completed: CopilotStreamEvent = {
      type: "hermes.turn.completed",
      payload: { turnId: "t1", text: "hi there", hermesMode: "live", addressedTo: "everyone" },
    };
    emitCopilotStreamEvent(completed);
    expect(a).toEqual([delta]); // unsubscribed → no further events
    expect(b).toEqual([delta, completed]);

    offB();
    expect(copilotStreamSubscriberCount()).toBe(0);
  });

  it("a throwing subscriber never breaks the broadcast to the others", () => {
    const received: CopilotStreamEvent[] = [];
    const offBad = onCopilotStreamEvent(() => {
      throw new Error("dead socket");
    });
    const offGood = onCopilotStreamEvent((e) => received.push(e));

    const event: CopilotStreamEvent = { type: "hermes.delta", payload: { turnId: "t", delta: "x", addressedTo: "everyone" } };
    expect(() => emitCopilotStreamEvent(event)).not.toThrow();
    expect(received).toEqual([event]);

    offBad();
    offGood();
  });

  it("emitting with no subscribers is a no-op", () => {
    expect(copilotStreamSubscriberCount()).toBe(0);
    expect(() =>
      emitCopilotStreamEvent({ type: "hermes.delta", payload: { turnId: "t", delta: "x", addressedTo: "everyone" } }),
    ).not.toThrow();
  });
});
