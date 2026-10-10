// First-external arrival alerts. The platform records them and does not send.
// GET /admin/arrivals/alerts (admin:status + ops:view) returns pending and
// ready. This poller sends only ready alerts through the existing Slack alert
// bridge, and it dedupes on the alert id.
//
// A summary id is `suppressed_firsts:<window start>:<count>`. The count is
// part of the id, so a new distinct count is a new id and sends an update.
// Pending alerts are never sent. A failed poll keeps the last reading and
// waits out the same gap as a successful one, the way the GitHub authors
// poll does.

import type { AlertPayload } from "./alert-bridge.js";

export const ARRIVAL_ALERTS_SCHEMA = "averray.arrival-alerts.v1";
export const ARRIVAL_ALERTS_POLL_MS = 5 * 60 * 1000;
export const ARRIVAL_ALERTS_TIMEOUT_MS = 8_000;
const SENT_ID_CAP = 500;

export type ArrivalAlertsUnavailable = "unauthorised" | "timeout" | "missing" | "unreachable";

export interface ArrivalAlert {
  id: string;
  kind: string;
  subject: string;
  status: "ready" | "pending";
  atMs: number | null;
  readyAtMs: number | null;
  href: string | null;
  trail: string | null;
  suppressedCount: number | null;
}

export interface ArrivalAlertsReading {
  ready: ArrivalAlert[];
  pending: ArrivalAlert[];
  unavailable?: ArrivalAlertsUnavailable | null;
  stale?: boolean;
  at: number | null;
  ageMs?: number | null;
}

interface AlertsCache {
  reading: ArrivalAlertsReading;
  attemptedAt: number;
}

let cache: AlertsCache | null = null;
const sentIds = new Set<string>();
const sentOrder: string[] = [];

export function __resetArrivalAlertsForTests(): void {
  cache = null;
  sentIds.clear();
  sentOrder.length = 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function arrivalAlert(value: unknown): ArrivalAlert | null {
  const alert = record(value);
  if (!alert || typeof alert.id !== "string" || !alert.id.trim()) return null;
  if (alert.status !== "ready" && alert.status !== "pending") return null;
  if (typeof alert.kind !== "string" || typeof alert.subject !== "string") return null;
  return {
    id: alert.id,
    kind: alert.kind,
    subject: alert.subject,
    status: alert.status,
    atMs: num(alert.atMs),
    readyAtMs: num(alert.readyAtMs),
    href: typeof alert.href === "string" && alert.href.trim() ? alert.href : null,
    trail: typeof alert.trail === "string" ? alert.trail : null,
    suppressedCount: num(alert.suppressedCount),
  };
}

/** The id is the dedupe key. A summary id includes the distinct count, so a new count is a new key. */
function dedupeKey(alert: ArrivalAlert): string {
  return alert.id;
}

/** Ready alerts whose id has not been sent. Pending is dropped here. */
export function readyToSend(alerts: readonly ArrivalAlert[]): ArrivalAlert[] {
  return alerts.filter((alert) => alert.status === "ready" && !sentIds.has(dedupeKey(alert)));
}

function rememberSent(alert: ArrivalAlert): void {
  const id = dedupeKey(alert);
  if (sentIds.has(id)) return;
  sentIds.add(id);
  sentOrder.push(id);
  while (sentOrder.length > SENT_ID_CAP) {
    const dropped = sentOrder.shift();
    if (dropped) sentIds.delete(dropped);
  }
}

function aged(reading: ArrivalAlertsReading, at: number, nowMs: number): ArrivalAlertsReading {
  return { ...reading, at, ageMs: at === 0 ? 0 : Math.max(0, nowMs - at) };
}

function noteAttempt(nowMs: number, unavailable: ArrivalAlertsUnavailable): ArrivalAlertsReading {
  if (cache) {
    const reading = { ...cache.reading, unavailable, stale: true };
    cache = { reading, attemptedAt: nowMs };
    return aged(reading, cache.reading.at ?? nowMs, nowMs);
  }
  const reading: ArrivalAlertsReading = { ready: [], pending: [], unavailable, stale: false, at: nowMs, ageMs: 0 };
  cache = { reading, attemptedAt: nowMs };
  return reading;
}

function abortAsTimeout(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error("timed out");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export function arrivalAlertPayload(alert: ArrivalAlert, boardUrl: string, baseUrl: string): AlertPayload {
  const platform = baseUrl.replace(/\/+$/, "");
  const href = alert.href?.startsWith("/") ? `${platform}${alert.href}` : boardUrl;
  const count = alert.suppressedCount == null ? "" : ` · ${alert.suppressedCount} distinct`;
  const text = [
    `:rotating_light: Hermes — arrival ${alert.kind}`,
    `${alert.subject}${count}`,
    alert.id,
    href,
  ].join("\n");
  return {
    count: 1,
    items: [{ id: alert.id, title: `${alert.kind}: ${alert.subject}` }],
    boardUrl: href,
    text,
  };
}

export async function pollArrivalAlerts(input: {
  baseUrl?: string;
  getSession: () => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
  alert: (payload: AlertPayload) => Promise<boolean>;
  boardUrl?: string;
  nowMs?: number;
  timeoutMs?: number;
  minIntervalMs?: number;
}): Promise<ArrivalAlertsReading> {
  const nowMs = input.nowMs ?? Date.now();
  const interval = input.minIntervalMs ?? ARRIVAL_ALERTS_POLL_MS;
  if (cache && nowMs - cache.attemptedAt < interval) {
    return aged(cache.reading, cache.reading.at ?? cache.attemptedAt, nowMs);
  }

  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) return noteAttempt(nowMs, "unreachable");

  const timeoutMs = input.timeoutMs ?? ARRIVAL_ALERTS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stage: "session" | "fetch" = "session";
  try {
    const session = await Promise.race([input.getSession(), abortAsTimeout(controller.signal)]);
    stage = "fetch";
    const response = await input.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/admin/arrivals/alerts`, {
      headers: { accept: "application/json", authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return noteAttempt(nowMs, "unauthorised");
    if (!response.ok) return noteAttempt(nowMs, "missing");
    const body = record(await response.json());
    if (!body || body.schemaVersion !== ARRIVAL_ALERTS_SCHEMA || typeof body.unavailable === "string") {
      return noteAttempt(nowMs, "missing");
    }
    const parsed = [...(Array.isArray(body.ready) ? body.ready : []), ...(Array.isArray(body.pending) ? body.pending : [])]
      .flatMap((item) => {
        const alert = arrivalAlert(item);
        return alert ? [alert] : [];
      });
    const ready = parsed.filter((alert) => alert.status === "ready");
    const pending = parsed.filter((alert) => alert.status === "pending");
    const boardUrl = input.boardUrl ?? "https://monitor.averray.com/monitor";
    for (const alert of readyToSend(parsed)) {
      const sent = await input.alert(arrivalAlertPayload(alert, boardUrl, baseUrl));
      if (sent) rememberSent(alert);
    }
    const reading: ArrivalAlertsReading = { ready, pending, unavailable: null, stale: false, at: nowMs, ageMs: 0 };
    cache = { reading, attemptedAt: nowMs };
    return reading;
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    const unavailable: ArrivalAlertsUnavailable = aborted
      ? "timeout"
      : stage === "session"
        ? "unauthorised"
        : "unreachable";
    return noteAttempt(nowMs, unavailable);
  } finally {
    clearTimeout(timer);
  }
}
