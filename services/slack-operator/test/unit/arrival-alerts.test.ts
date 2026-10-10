import { afterEach, describe, expect, it } from "vitest";

import type { AlertPayload } from "../../src/alert-bridge.js";
import {
  __resetArrivalAlertsForTests,
  ARRIVAL_ALERTS_SCHEMA,
  pollArrivalAlerts,
} from "../../src/arrival-alerts.js";

afterEach(() => __resetArrivalAlertsForTests());

function alert(over: Record<string, unknown>) {
  return {
    id: "external_wallet_first:0xabc",
    kind: "external_wallet_first",
    subject: "0xabc",
    status: "ready",
    atMs: 1_000,
    readyAtMs: 1_000,
    trail: "not reported",
    ...over,
  };
}

function body(ready: unknown[], pending: unknown[] = []) {
  return {
    schemaVersion: ARRIVAL_ALERTS_SCHEMA,
    generatedAtMs: 1_000,
    ready,
    pending,
    saturated: false,
    sending: "monitor_alert_bridge",
  };
}

function harness(ready: unknown[], pending: unknown[] = []) {
  const sent: AlertPayload[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    return {
      ok: true,
      status: 200,
      json: async () => body(ready, pending),
      requested: String(url),
    };
  }) as typeof fetch;
  return {
    sent,
    input: {
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl,
      alert: async (payload: AlertPayload) => {
        sent.push(payload);
        return true;
      },
      boardUrl: "https://monitor.example/monitor",
      minIntervalMs: 0,
    },
  };
}

describe("pollArrivalAlerts", () => {
  it("sends a ready alert once and does not send it again", async () => {
    const { sent, input } = harness([alert({})]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    await pollArrivalAlerts({ ...input, nowMs: 1_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.items[0]?.id).toBe("external_wallet_first:0xabc");
    expect(sent[0]?.text).toContain("external_wallet_first");
  });

  it("does not send pending alerts", async () => {
    const { sent, input } = harness(
      [],
      [alert({ id: "external_client_first:cursor@1", kind: "external_client_first", subject: "cursor@1", status: "pending", readyAtMs: null })],
    );
    const reading = await pollArrivalAlerts({ ...input, nowMs: 0 });
    expect(sent).toHaveLength(0);
    expect(reading.pending).toHaveLength(1);
    expect(reading.ready).toHaveLength(0);
  });

  it("a new summary count is a new id and sends an update", async () => {
    const first = harness([alert({
      id: "suppressed_firsts:1000:3",
      kind: "suppressed_firsts",
      subject: "summary",
      suppressedCount: 3,
    })]);
    await pollArrivalAlerts({ ...first.input, nowMs: 0 });
    const second = harness([alert({
      id: "suppressed_firsts:1000:4",
      kind: "suppressed_firsts",
      subject: "summary",
      suppressedCount: 4,
    })]);
    await pollArrivalAlerts({ ...second.input, alert: first.input.alert, nowMs: 1_000 });
    expect(first.sent.map((payload) => payload.items[0]?.id)).toEqual([
      "suppressed_firsts:1000:3",
      "suppressed_firsts:1000:4",
    ]);
  });

  it("a failed poll keeps the last ready list and does not send again inside the gap", async () => {
    const { sent, input } = harness([alert({})]);
    const first = await pollArrivalAlerts({ ...input, nowMs: 1_000, minIntervalMs: 5 * 60 * 1000 });
    expect(first.ready).toHaveLength(1);
    expect(sent).toHaveLength(1);

    let calls = 0;
    const hung = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return { ok: false, status: 500, json: async () => ({}) };
    }) as typeof fetch;
    const failed = await pollArrivalAlerts({
      ...input,
      fetchImpl: hung,
      nowMs: 10_000,
      timeoutMs: 20,
      minIntervalMs: 0,
    });
    expect(failed.ready[0]?.id).toBe("external_wallet_first:0xabc");
    expect(failed.stale).toBe(true);
    expect(failed.unavailable).toBe("timeout");
    expect(sent).toHaveLength(1);

    const skipped = await pollArrivalAlerts({
      ...input,
      fetchImpl: hung,
      nowMs: 20_000,
      timeoutMs: 20,
      minIntervalMs: 5 * 60 * 1000,
    });
    expect(calls).toBe(1);
    expect(skipped.ready[0]?.id).toBe("external_wallet_first:0xabc");
    expect(sent).toHaveLength(1);
  });

  it("polls /admin/arrivals/alerts", async () => {
    let requested = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return { ok: true, status: 200, json: async () => body([]) };
    }) as typeof fetch;
    await pollArrivalAlerts({
      baseUrl: "https://api.example/",
      getSession: async () => ({ token: "t" }),
      fetchImpl,
      alert: async () => true,
      nowMs: 0,
      minIntervalMs: 0,
    });
    expect(requested).toBe("https://api.example/admin/arrivals/alerts");
  });
});
