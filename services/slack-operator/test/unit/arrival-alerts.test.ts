import { afterEach, describe, expect, it } from "vitest";

import { slackAlertChannel, type AlertPayload } from "../../src/alert-bridge.js";
import {
  __resetArrivalAlertsForTests,
  ARRIVAL_ALERTS_MAX_SENDS_PER_POLL,
  ARRIVAL_ALERTS_SCHEMA,
  ARRIVAL_ALERTS_TIMEOUT_MS,
  arrivalAlertPayload,
  arrivalAlertsSlackEnabled,
  pollArrivalAlerts,
} from "../../src/arrival-alerts.js";

afterEach(() => __resetArrivalAlertsForTests());

const INJECTION = "<!channel> <https://evil.example|board>@1";

function alert(over: Record<string, unknown> = {}) {
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

function body(ready: unknown[], pending: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    schemaVersion: ARRIVAL_ALERTS_SCHEMA,
    generatedAtMs: 1_000,
    ready,
    pending,
    saturated: false,
    sending: "monitor_alert_bridge",
    ...over,
  };
}

function harness(payloads: unknown[][], pending: unknown[] = []) {
  const sent: AlertPayload[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    const ready = payloads[Math.min(calls, payloads.length - 1)] ?? [];
    calls += 1;
    return { ok: true, status: 200, json: async () => body(ready, pending) };
  }) as typeof fetch;
  const input = {
    baseUrl: "https://api.example",
    getSession: async () => ({ token: "t" }),
    fetchImpl,
    alert: async (payload: AlertPayload) => {
      sent.push(payload);
      return true;
    },
    boardUrl: "https://monitor.example/monitor",
    minIntervalMs: 0,
  };
  return { sent, input, calls: () => calls };
}

describe("arrival alert text", () => {
  it("escapes the attacker-chosen client name and does not build a Slack link from it", () => {
    const payload = arrivalAlertPayload(alert({
      id: `external_client_first:${INJECTION}`,
      kind: "external_client_first",
      subject: INJECTION,
    }), "https://monitor.example/monitor");
    expect(payload.text).toContain("&lt;!channel&gt; &lt;https://evil.example|board&gt;@1");
    expect(payload.text).not.toContain("<!channel>");
    expect(payload.text).not.toContain("<https://");
    expect(payload.boardUrl).toBe("https://monitor.example/monitor");
    expect(payload.text).toContain("https://monitor.example/monitor");
    expect(payload.text).not.toContain("api.example");
  });

  it("escapes ampersands before angle brackets", () => {
    const payload = arrivalAlertPayload(alert({ subject: "a & b <c>" }), "https://monitor.example/monitor");
    expect(payload.text).toContain("a &amp; b &lt;c&gt;");
    expect(payload.text).not.toContain("&amp;amp;");
  });
});

describe("pollArrivalAlerts", () => {
  it("the admin poll waits 8 seconds", () => {
    expect(ARRIVAL_ALERTS_TIMEOUT_MS).toBe(8_000);
    expect(ARRIVAL_ALERTS_MAX_SENDS_PER_POLL).toBe(5);
  });

  it("paging stays off unless the flag is explicitly on", () => {
    expect(arrivalAlertsSlackEnabled({})).toBe(false);
    expect(arrivalAlertsSlackEnabled({ ARRIVAL_ALERTS_SLACK_ENABLED: "0" })).toBe(false);
    expect(arrivalAlertsSlackEnabled({ ARRIVAL_ALERTS_SLACK_ENABLED: "1" })).toBe(true);
  });

  it("a restart with 55 ready alerts sends nothing, and a later new alert sends", async () => {
    const historical = Array.from({ length: 55 }, (_, index) => alert({
      id: `external_wallet_first:0x${index}`,
      subject: `0x${index}`,
    }));
    const { sent, input } = harness([historical, [...historical, alert({ id: "external_wallet_first:0xnew", subject: "0xnew" })]]);
    const first = await pollArrivalAlerts({ ...input, nowMs: 0 });
    expect(first.ready).toHaveLength(55);
    expect(sent).toHaveLength(0);
    await pollArrivalAlerts({ ...input, nowMs: 1_000 });
    expect(sent.map((payload) => payload.items[0]?.id)).toEqual(["external_wallet_first:0xnew"]);
  });

  it("sends a post-start alert once and does not send it again", async () => {
    const { sent, input } = harness([[], [alert({})], [alert({})]]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    await pollArrivalAlerts({ ...input, nowMs: 1_000 });
    await pollArrivalAlerts({ ...input, nowMs: 2_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.items[0]?.id).toBe("external_wallet_first:0xabc");
  });

  it("does not send pending alerts", async () => {
    const pending = [alert({
      id: "external_client_first:cursor@1",
      kind: "external_client_first",
      subject: "cursor@1",
      status: "pending",
      readyAtMs: null,
    })];
    const { sent, input } = harness([[], []], pending);
    const reading = await pollArrivalAlerts({ ...input, nowMs: 0 });
    expect(sent).toHaveLength(0);
    expect(reading.pending).toHaveLength(1);
    expect(reading.ready).toHaveLength(0);
  });

  it("a new summary count is a new id and sends an update", async () => {
    const firstId = "suppressed_firsts:1000:3";
    const secondId = "suppressed_firsts:1000:4";
    const { sent, input } = harness([
      [],
      [alert({ id: firstId, kind: "suppressed_firsts", subject: "summary", suppressedCount: 3 })],
      [alert({ id: secondId, kind: "suppressed_firsts", subject: "summary", suppressedCount: 4 })],
    ]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    await pollArrivalAlerts({ ...input, nowMs: 1_000 });
    await pollArrivalAlerts({ ...input, nowMs: 2_000 });
    expect(sent.map((payload) => payload.items[0]?.id)).toEqual([firstId, secondId]);
  });

  it("holds a new alert while muted and sends it once mute lifts", async () => {
    const { sent, input } = harness([[], [alert({})], [alert({})]]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    const held = await pollArrivalAlerts({ ...input, nowMs: 1_000, muteUntilMs: 5_000 });
    expect(held.ready).toHaveLength(1);
    expect(sent).toHaveLength(0);
    await pollArrivalAlerts({ ...input, nowMs: 6_000 });
    expect(sent).toHaveLength(1);
  });

  it("holds a new alert during quiet hours and sends it after", async () => {
    const quietHours = { startMinute: 0, endMinute: 60 };
    const { sent, input } = harness([[], [alert({})], [alert({})]]);
    await pollArrivalAlerts({ ...input, nowMs: 0, nowMinuteOfDay: 120 });
    await pollArrivalAlerts({ ...input, nowMs: 1_000, nowMinuteOfDay: 30, quietHours });
    expect(sent).toHaveLength(0);
    await pollArrivalAlerts({ ...input, nowMs: 2_000, nowMinuteOfDay: 120, quietHours });
    expect(sent).toHaveLength(1);
  });

  it("sends at most five new alerts per poll", async () => {
    const many = Array.from({ length: 6 }, (_, index) => alert({
      id: `external_wallet_first:n${index}`,
      subject: `n${index}`,
    }));
    const { sent, input } = harness([[], many, many]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    await pollArrivalAlerts({ ...input, nowMs: 1_000 });
    expect(sent).toHaveLength(5);
    await pollArrivalAlerts({ ...input, nowMs: 2_000 });
    expect(sent).toHaveLength(6);
  });

  it("a failed Slack post is not marked sent", async () => {
    let attempts = 0;
    const { input } = harness([[], [alert({})], [alert({})], [alert({})]]);
    const alertFn = async (payload: AlertPayload) => {
      attempts += 1;
      return attempts > 1;
    };
    await pollArrivalAlerts({ ...input, alert: alertFn, nowMs: 0 });
    await pollArrivalAlerts({ ...input, alert: alertFn, nowMs: 1_000 });
    expect(attempts).toBe(1);
    await pollArrivalAlerts({ ...input, alert: alertFn, nowMs: 2_000 });
    expect(attempts).toBe(2);
    await pollArrivalAlerts({ ...input, alert: alertFn, nowMs: 3_000 });
    expect(attempts).toBe(2);
  });

  it("a failed attempt starts the gap and a 503 sends nothing", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({ unavailable: "arrival alerts could not be read" }) };
    }) as typeof fetch;
    const sent: AlertPayload[] = [];
    const input = {
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl,
      alert: async (payload: AlertPayload) => {
        sent.push(payload);
        return true;
      },
      minIntervalMs: 5 * 60 * 1000,
    };
    const failed = await pollArrivalAlerts({ ...input, nowMs: 0 });
    expect(failed.unavailable).toBe("missing");
    expect(sent).toHaveLength(0);
    await pollArrivalAlerts({ ...input, nowMs: 60_000 });
    expect(calls).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("a wrong schema sends nothing and does not look live", async () => {
    const sent: AlertPayload[] = [];
    const reading = await pollArrivalAlerts({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: "nope", ready: [alert({})], pending: [] }),
      })) as typeof fetch,
      alert: async (payload: AlertPayload) => {
        sent.push(payload);
        return true;
      },
      nowMs: 0,
      minIntervalMs: 0,
    });
    expect(reading.unavailable).toBe("missing");
    expect(sent).toHaveLength(0);
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

describe("arrival slack fetch", () => {
  it("aborts the Slack POST when the timeout fires and reports not sent", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return new Response("ok");
    }) as typeof fetch;
    try {
      const sent = await slackAlertChannel("https://hooks.example/slack", { timeoutMs: 20 }).dispatch({
        count: 1,
        items: [{ id: "a", title: "a" }],
        boardUrl: "https://monitor.example/monitor",
        text: "hello",
      });
      expect(sent).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
