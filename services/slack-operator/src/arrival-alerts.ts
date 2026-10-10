// First-external arrival alerts. The platform records them and does not send.
// GET /admin/arrivals/alerts (admin:status + ops:view) returns pending and
// ready. This module reads that route and, when paging is enabled, sends
// ready alerts through the Slack alert channel.
//
// Deduped on the alert id. A summary id is
// `suppressed_firsts:<window start>:<count>`, so a new distinct count is a
// new id and sends an update. Pending is never sent. The first successful
// read after process start seeds the sent-ids from the ready list and sends
// nothing — a restart must not page the backend's retained history. Later
// polls send at most ARRIVAL_ALERTS_MAX_SENDS_PER_POLL new alerts.
//
// Mute and quiet hours hold a new alert without marking it sent. A failed
// poll keeps the last reading, logs once per failure state, and does not send.

import { logger } from "@avg/mcp-common";

import {
  inQuietHours,
  type AlertPayload,
  type QuietHours,
} from "./alert-bridge.js";

export const ARRIVAL_ALERTS_SCHEMA = "averray.arrival-alerts.v1";
export const ARRIVAL_ALERTS_POLL_MS = 5 * 60 * 1000;
export const ARRIVAL_ALERTS_TIMEOUT_MS = 8_000;
export const ARRIVAL_ALERTS_SLACK_TIMEOUT_MS = 4_000;
export const ARRIVAL_ALERTS_MAX_SENDS_PER_POLL = 5;
const SENT_ID_CAP = 500;

export type ArrivalAlertsUnavailable = "unauthorised" | "timeout" | "missing" | "unreachable";
export type ArrivalAlertHold = "mute" | "quiet-hours";

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

/** Board-facing poll status. Counts are null until a read has succeeded. */
export interface ArrivalAlertsBoardStatus {
  paging: "on" | "off";
  unavailable: ArrivalAlertsUnavailable | null;
  stale: boolean;
  readyCount: number | null;
  pendingCount: number | null;
  held: ArrivalAlertHold | null;
}

interface AlertsCache {
  reading: ArrivalAlertsReading;
  attemptedAt: number;
}

let cache: AlertsCache | null = null;
let seeded = false;
const sentIds = new Set<string>();
const sentOrder: string[] = [];
let lastLoggedUnavailable: ArrivalAlertsUnavailable | null = null;
let lastLoggedHold: ArrivalAlertHold | "clear" | null = null;

export function __resetArrivalAlertsForTests(): void {
  cache = null;
  seeded = false;
  sentIds.clear();
  sentOrder.length = 0;
  lastLoggedUnavailable = null;
  lastLoggedHold = null;
}

/** Paging is opt-in. Unset, empty, and anything other than 1/true/yes stay off. */
export function arrivalAlertsSlackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ARRIVAL_ALERTS_SLACK_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Slack mrkdwn: &, <, and > are special. Everything else is literal text. */
export function slackMrkdwnEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function logUnavailable(next: ArrivalAlertsUnavailable | null): void {
  if (lastLoggedUnavailable === next) return;
  const previous = lastLoggedUnavailable;
  lastLoggedUnavailable = next;
  if (next) logger.warn({ unavailable: next }, "arrival_alerts_poll_failed");
  else if (previous) logger.info("arrival_alerts_poll_recovered");
}

function noteAttempt(nowMs: number, unavailable: ArrivalAlertsUnavailable): ArrivalAlertsReading {
  logUnavailable(unavailable);
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

/**
 * Same mute and quiet-hours gate as the D4 bridge. A hold does not mark the
 * alert sent, so it pages once the suppression lifts.
 */
export function arrivalAlertHold(input: {
  nowMs: number;
  nowMinuteOfDay: number;
  muteUntilMs?: number;
  quietHours?: QuietHours;
}): ArrivalAlertHold | null {
  if (input.muteUntilMs !== undefined && input.nowMs < input.muteUntilMs) return "mute";
  if (inQuietHours(input.nowMinuteOfDay, input.quietHours)) return "quiet-hours";
  return null;
}

/**
 * Text for Slack. Attacker-controlled fields are escaped and never placed
 * inside `<url|label>` link syntax. The only URL is the operator's board.
 */
export function arrivalAlertPayload(alert: ArrivalAlert, boardUrl: string): AlertPayload {
  const count = alert.suppressedCount == null ? "" : ` · ${alert.suppressedCount} distinct`;
  const kind = slackMrkdwnEscape(alert.kind);
  const subject = slackMrkdwnEscape(alert.subject);
  const id = slackMrkdwnEscape(alert.id);
  const text = [
    `:rotating_light: Hermes — arrival ${kind}`,
    `${subject}${count}`,
    id,
    boardUrl,
  ].join("\n");
  return {
    count: 1,
    items: [{ id: alert.id, title: `${kind}: ${subject}` }],
    boardUrl,
    text,
  };
}

export function arrivalAlertsBoardStatus(
  reading: ArrivalAlertsReading,
  paging: boolean,
  held: ArrivalAlertHold | null,
): ArrivalAlertsBoardStatus {
  const counted = reading.unavailable == null || reading.stale === true;
  return {
    paging: paging ? "on" : "off",
    unavailable: reading.unavailable ?? null,
    stale: reading.stale === true,
    readyCount: counted ? reading.ready.length : null,
    pendingCount: counted ? reading.pending.length : null,
    held,
  };
}

function seedHistory(ready: readonly ArrivalAlert[]): void {
  if (seeded) return;
  for (const alert of ready) {
    if (alert.status === "ready") rememberSent(alert);
  }
  seeded = true;
}

export async function readArrivalAlerts(input: {
  baseUrl?: string;
  getSession: () => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
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
    seedHistory(ready);
    logUnavailable(null);
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

export async function deliverArrivalAlerts(input: {
  alert: (payload: AlertPayload) => Promise<boolean>;
  boardUrl: string;
  nowMs?: number;
  nowMinuteOfDay?: number;
  muteUntilMs?: number;
  quietHours?: QuietHours;
  maxSends?: number;
}): Promise<{ sent: number; held: ArrivalAlertHold | null }> {
  const nowMs = input.nowMs ?? Date.now();
  const held = arrivalAlertHold({
    nowMs,
    nowMinuteOfDay: input.nowMinuteOfDay ?? 0,
    ...(input.muteUntilMs !== undefined ? { muteUntilMs: input.muteUntilMs } : {}),
    ...(input.quietHours ? { quietHours: input.quietHours } : {}),
  });
  if (held) {
    if (lastLoggedHold !== held) {
      lastLoggedHold = held;
      logger.info({ held }, "arrival_alerts_held");
    }
    return { sent: 0, held };
  }
  if (lastLoggedHold && lastLoggedHold !== "clear") lastLoggedHold = "clear";
  if (cache?.reading.unavailable) return { sent: 0, held: null };
  const cap = input.maxSends ?? ARRIVAL_ALERTS_MAX_SENDS_PER_POLL;
  let sent = 0;
  for (const alert of readyToSend(cache?.reading.ready ?? [])) {
    if (sent >= cap) break;
    const ok = await input.alert(arrivalAlertPayload(alert, input.boardUrl));
    if (!ok) break;
    rememberSent(alert);
    sent += 1;
  }
  return { sent, held: null };
}

/** Read, then deliver. Tests and any caller that wants both in one step. */
export async function pollArrivalAlerts(input: {
  baseUrl?: string;
  getSession: () => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
  alert: (payload: AlertPayload) => Promise<boolean>;
  boardUrl?: string;
  nowMs?: number;
  nowMinuteOfDay?: number;
  muteUntilMs?: number;
  quietHours?: QuietHours;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxSends?: number;
}): Promise<ArrivalAlertsReading> {
  const reading = await readArrivalAlerts(input);
  if (!reading.unavailable) {
    await deliverArrivalAlerts({
      alert: input.alert,
      boardUrl: input.boardUrl ?? "https://monitor.averray.com/monitor",
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      ...(input.nowMinuteOfDay !== undefined ? { nowMinuteOfDay: input.nowMinuteOfDay } : {}),
      ...(input.muteUntilMs !== undefined ? { muteUntilMs: input.muteUntilMs } : {}),
      ...(input.quietHours ? { quietHours: input.quietHours } : {}),
      ...(input.maxSends !== undefined ? { maxSends: input.maxSends } : {}),
    });
  }
  return reading;
}
