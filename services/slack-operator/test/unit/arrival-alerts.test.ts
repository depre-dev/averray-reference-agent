import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@avg/mcp-common";

import { slackAlertChannel, type AlertPayload } from "../../src/alert-bridge.js";
import {
  __resetArrivalAlertsForTests,
  ARRIVAL_ALERTS_MAX_SENDS_PER_POLL,
  ARRIVAL_ALERTS_SCHEMA,
  ARRIVAL_ALERTS_TIMEOUT_MS,
  ARRIVAL_PAGING_NO_WEBHOOK,
  arrivalAlertPayload,
  arrivalAlertsBoardStatus,
  arrivalAlertsSlackEnabled,
  deliverArrivalAlerts,
  pollArrivalAlerts,
  readArrivalAlerts,
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
    expect(payload.text).toContain("&lt;!channel&gt; &lt;https:\u2044\u2044evil[.]example|board&gt;@1");
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

  it("escapes the kind, not only the subject", () => {
    const payload = arrivalAlertPayload(alert({
      kind: INJECTION,
      subject: "plain-wallet",
    }), "https://monitor.example/monitor");
    expect(payload.text).toContain("arrival &lt;!channel&gt; &lt;https:\u2044\u2044evil[.]example|board&gt;@1");
    expect(payload.text).not.toContain("<!channel>");
    expect(payload.text).not.toContain("<https://");
    const withoutBoard = payload.text.replaceAll("https://monitor.example/monitor", "");
    expect(withoutBoard).not.toContain("://");
  });

  it("defangs urls in the subject and does not repeat the id", () => {
    const payload = arrivalAlertPayload(alert({
      id: "external_wallet_first:0xabc",
      kind: "external_wallet_first",
      subject: "opened https://evil.example/phish",
    }), "https://monitor.example/monitor");
    const withoutBoard = payload.text.replaceAll("https://monitor.example/monitor", "");
    expect(withoutBoard).not.toContain("://");
    expect(payload.text).toContain("https:\u2044\u2044evil[.]example/phish");
    expect(payload.text.split("\n")).not.toContain("external_wallet_first:0xabc");
    expect(payload.items[0]?.id).toBe("external_wallet_first:0xabc");
  });

  it("defangs a bare domain Slack would autolink", () => {
    const payload = arrivalAlertPayload(alert({
      kind: "external_wallet_first",
      subject: "opened from evil.com today",
    }), "https://monitor.example/monitor");
    expect(payload.text).toContain("evil[.]com");
    expect(payload.text).not.toContain("evil.com");
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

  it("a failed first read does not seed, so the first success still sends nothing", async () => {
    const historical = Array.from({ length: 55 }, (_, index) => alert({
      id: `external_wallet_first:0x${index}`,
      subject: `0x${index}`,
    }));
    let calls = 0;
    const sent: AlertPayload[] = [];
    const reading = await pollArrivalAlerts({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body(historical) };
      }) as typeof fetch,
      alert: async (payload: AlertPayload) => {
        sent.push(payload);
        return true;
      },
      nowMs: 0,
      minIntervalMs: 0,
    });
    expect(reading.unavailable).toBe("missing");
    expect(sent).toHaveLength(0);
    const firstSuccess = await pollArrivalAlerts({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => body(historical) })) as typeof fetch,
      alert: async (payload: AlertPayload) => {
        sent.push(payload);
        return true;
      },
      nowMs: 1_000,
      minIntervalMs: 0,
    });
    expect(firstSuccess.unavailable ?? null).toBeNull();
    expect(firstSuccess.ready).toHaveLength(55);
    expect(sent).toHaveLength(0);
  });

  it("does not deliver a stale reading", async () => {
    const sent: AlertPayload[] = [];
    const { input } = harness([[]]);
    await pollArrivalAlerts({ ...input, nowMs: 0 });
    const result = await deliverArrivalAlerts({
      reading: {
        ready: [alert({ id: "external_wallet_first:0xnew", subject: "0xnew" })],
        pending: [],
        stale: true,
        unavailable: null,
        at: 1_000,
      },
      alert: async (payload) => {
        sent.push(payload);
        return true;
      },
      boardUrl: "https://monitor.example/monitor",
      nowMs: 2_000,
    });
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("logs a poll failure once per state change", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
    const failed = () => warn.mock.calls.filter((call) => call[1] === "arrival_alerts_poll_failed");
    const recovered = () => info.mock.calls.filter((call) => call[0] === "arrival_alerts_poll_recovered");
    const input = {
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      alert: async () => true,
      minIntervalMs: 0,
    };
    const missing = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as typeof fetch;
    await pollArrivalAlerts({ ...input, fetchImpl: missing, nowMs: 0 });
    await pollArrivalAlerts({ ...input, fetchImpl: missing, nowMs: 1_000 });
    expect(failed()).toHaveLength(1);
    const timeout = (async () => {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    await pollArrivalAlerts({ ...input, fetchImpl: timeout, nowMs: 2_000 });
    expect(failed()).toHaveLength(2);
    await pollArrivalAlerts({
      ...input,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => body([]) })) as typeof fetch,
      nowMs: 3_000,
    });
    await pollArrivalAlerts({
      ...input,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => body([]) })) as typeof fetch,
      nowMs: 4_000,
    });
    expect(recovered()).toHaveLength(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("a fetch that ignores abort still settles as a timeout", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = readArrivalAlerts({
        baseUrl: "https://api.example",
        getSession: async () => ({ token: "t" }),
        fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
        nowMs: 0,
        timeoutMs: 40,
        minIntervalMs: 0,
      }).then((reading) => {
        settled = true;
        return reading;
      });
      await vi.advanceTimersByTimeAsync(40);
      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({ unavailable: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("paging on without a Slack webhook is not announced as paging on", () => {
    const status = arrivalAlertsBoardStatus(
      { ready: [], pending: [], at: 1, stale: false, unavailable: null },
      true,
      null,
      false,
    );
    expect(status.paging).toBe("on");
    expect(status.pagingDetail).toBe(ARRIVAL_PAGING_NO_WEBHOOK);
    expect(arrivalAlertsBoardStatus(
      { ready: [], pending: [], at: 1, stale: false, unavailable: null },
      true,
      null,
      true,
    ).pagingDetail).toBeNull();
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

  it("the default Slack timeout settles a fetch that ignores abort", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      let settled = false;
      const pending = slackAlertChannel("https://hooks.example/slack", { timeoutMs: 30 }).dispatch({
        count: 1,
        items: [{ id: "a", title: "a" }],
        boardUrl: "https://monitor.example/monitor",
        text: "hello",
      }).then((sent) => {
        settled = true;
        return sent;
      });
      await vi.advanceTimersByTimeAsync(30);
      expect(settled).toBe(true);
      await expect(pending).resolves.toBe(false);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });

  it("records a Slack POST that succeeds after the timeout", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    let finish: (value: Response) => void = () => {};
    const late: string[] = [];
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
    try {
      const pending = slackAlertChannel("https://hooks.example/slack", {
        timeoutMs: 30,
        onLateSuccess: (payload) => late.push(payload.items[0]?.id ?? ""),
      }).dispatch({
        count: 1,
        items: [{ id: "external_wallet_first:0xlate", title: "late" }],
        boardUrl: "https://monitor.example/monitor",
        text: "hello",
      });
      await vi.advanceTimersByTimeAsync(30);
      await expect(pending).resolves.toBe(false);
      expect(late).toEqual([]);
      finish(new Response("ok", { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(late).toEqual(["external_wallet_first:0xlate"]);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });
});
