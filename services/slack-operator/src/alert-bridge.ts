// D4 — the off-device operator alert bridge.
//
// A SERVER-SIDE routine (not the browser notifications of #232, which need a
// tab open) pings the operator off-device whenever the board's action-needed
// count crosses 0 → ≥1, so they can act away from the Mac. This is the O4
// autopilot prerequisite: "Hermes needs you" has to reach you with no tab.
//
// This module is the pure, testable core + a pluggable channel adapter:
//   - evaluateAlertBridge: the rising-edge / de-dup / cooldown / suppression
//     state machine (pure — injected clock + state).
//   - AlertChannel: the pluggable dispatch interface (Slack now; a push
//     adapter — ntfy / Pushover / native — drops in later with no routine change).
//   - server-side mute: a shared mute state the board's /mute also sets, so
//     muting on the board silences off-device alerts too.

import { logger, optionalEnv } from "@avg/mcp-common";

export interface AlertItem {
  id: string;
  title: string;
}

export interface AlertPayload {
  /** Total action-needed count (the headline). */
  count: number;
  /** The item(s) driving this alert (rising-edge: all; otherwise the new ones). */
  items: AlertItem[];
  /** Deep link into the board (the card, or the needs-attention lane). */
  boardUrl: string;
  /** Rendered message text. */
  text: string;
}

/** Pluggable off-device channel. Slack now; ntfy/Pushover/native later. */
export interface AlertChannel {
  readonly name: string;
  /** Dispatch the alert. Returns true if actually sent (false = no-op, e.g. unconfigured). */
  dispatch(payload: AlertPayload): Promise<boolean>;
}

// ── De-dup state machine ────────────────────────────────────────────

export interface AlertBridgeState {
  /** action-needed count at the previous tick (for the 0→≥1 rising edge). */
  prevCount: number;
  /** ids already alerted in the current ≥1 episode (cleared when it returns to 0). */
  alertedIds: string[];
  /** when the last alert was dispatched (for the cooldown re-alert). */
  lastAlertAtMs: number;
}

export function initialAlertBridgeState(): AlertBridgeState {
  return { prevCount: 0, alertedIds: [], lastAlertAtMs: 0 };
}

export interface QuietHours {
  /** minutes-of-day [0,1440), in the configured tz. */
  startMinute: number;
  endMinute: number;
}

export interface AlertBridgeConfig {
  /** Re-alert while still ≥1 after this long, even with no new items (0 = never). */
  cooldownMs: number;
  /** Server-side mute: suppress while now < muteUntilMs. */
  muteUntilMs?: number;
  /** Quiet-hours window (caller supplies the tz-adjusted minute-of-day). */
  quietHours?: QuietHours;
}

export interface EvaluateInput {
  items: AlertItem[];
  nowMs: number;
  /** Minute-of-day in the quiet-hours tz (caller computes). */
  nowMinuteOfDay: number;
  state: AlertBridgeState;
  config: AlertBridgeConfig;
}

export interface EvaluateResult {
  state: AlertBridgeState;
  dispatch: boolean;
  reason: "clear" | "deduped" | "rising_edge" | "new_items" | "cooldown" | "muted" | "quiet_hours";
  suppressedBy?: "mute" | "quiet-hours";
  /** The items to put in the alert when dispatch is true. */
  payloadItems: AlertItem[];
}

/** True when minuteOfDay falls inside the quiet-hours window (wraps midnight). */
export function inQuietHours(minuteOfDay: number, q?: QuietHours): boolean {
  if (!q || q.startMinute === q.endMinute) return false;
  return q.startMinute < q.endMinute
    ? minuteOfDay >= q.startMinute && minuteOfDay < q.endMinute
    : minuteOfDay >= q.startMinute || minuteOfDay < q.endMinute;
}

/**
 * The core decision. Pure: same (items, now, state, config) → same result.
 *  - count 0 → reset the episode (no alert).
 *  - rising edge (prev 0 → ≥1) → alert once.
 *  - stays ≥1 → alert only on a NEW distinct item, or once the cooldown elapses.
 *  - mute / quiet-hours → suppress the dispatch, and do NOT advance the alerted
 *    state, so the alert fires as soon as the suppression lifts.
 */
export function evaluateAlertBridge(input: EvaluateInput): EvaluateResult {
  const { items, nowMs, nowMinuteOfDay, state, config } = input;
  const count = items.length;

  if (count === 0) {
    return {
      state: { prevCount: 0, alertedIds: [], lastAlertAtMs: state.lastAlertAtMs },
      dispatch: false,
      reason: "clear",
      payloadItems: [],
    };
  }

  const newItems = items.filter((i) => !state.alertedIds.includes(i.id));
  const rising = state.prevCount === 0;
  const cooldownElapsed = config.cooldownMs > 0 && nowMs - state.lastAlertAtMs >= config.cooldownMs;
  const wouldDispatch = rising || newItems.length > 0 || cooldownElapsed;

  if (!wouldDispatch) {
    return { state: { ...state, prevCount: count }, dispatch: false, reason: "deduped", payloadItems: [] };
  }

  // De-dup says alert — now honor suppression. Don't advance alertedIds /
  // lastAlertAtMs while suppressed, so the alert fires once it lifts.
  if (config.muteUntilMs !== undefined && nowMs < config.muteUntilMs) {
    return { state: { ...state, prevCount: count }, dispatch: false, reason: "muted", suppressedBy: "mute", payloadItems: [] };
  }
  if (inQuietHours(nowMinuteOfDay, config.quietHours)) {
    return { state: { ...state, prevCount: count }, dispatch: false, reason: "quiet_hours", suppressedBy: "quiet-hours", payloadItems: [] };
  }

  const payloadItems = rising ? items : newItems.length > 0 ? newItems : items;
  const alertedIds = Array.from(new Set([...state.alertedIds, ...items.map((i) => i.id)]));
  return {
    state: { prevCount: count, alertedIds, lastAlertAtMs: nowMs },
    dispatch: true,
    reason: rising ? "rising_edge" : newItems.length > 0 ? "new_items" : "cooldown",
    payloadItems,
  };
}

// ── Payload rendering ───────────────────────────────────────────────

export function buildAlertPayload(payloadItems: AlertItem[], totalCount: number, boardBaseUrl: string): AlertPayload {
  const base = (boardBaseUrl || "").replace(/\/+$/, "");
  const boardUrl =
    payloadItems.length === 1 && payloadItems[0]
      ? `${base}?card=${encodeURIComponent(payloadItems[0].id)}`
      : `${base}?lane=needs-attention`;
  const head = totalCount === 1 ? "1 card needs your review" : `${totalCount} cards need your review`;
  const titles = payloadItems.slice(0, 3).map((i) => `• ${i.title}`).join("\n");
  const more = payloadItems.length > 3 ? `\n…and ${payloadItems.length - 3} more` : "";
  const text = `:rotating_light: Hermes — ${head}\n${titles}${more}\n${boardUrl}`;
  return { count: totalCount, items: payloadItems, boardUrl, text };
}

// ── Slack channel adapter (the one channel today) ───────────────────

/**
 * Slack via SLACK_WEBHOOK_URL (the Slack mobile app gives phone push for free).
 * No-op + no crash when the webhook is unset. A push adapter implements the
 * same AlertChannel interface later — the routine never changes.
 */
export function slackAlertChannel(webhookUrl: string | undefined = optionalEnv("SLACK_WEBHOOK_URL")): AlertChannel {
  return {
    name: "slack",
    async dispatch(payload: AlertPayload): Promise<boolean> {
      if (!webhookUrl) return false;
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: payload.text }),
        });
        if (!res.ok) logger.warn({ status: res.status }, "d4_alert_bridge_slack_post_failed");
        return res.ok;
      } catch (error) {
        logger.warn({ err: error }, "d4_alert_bridge_slack_post_failed");
        return false;
      }
    },
  };
}

// ── Server-side mute (shared with the board's /mute) ────────────────
//
// The board's mute was browser-only (#232). D4 needs it server-side so muting
// on the board also silences off-device alerts. Single in-process timestamp;
// the board POSTs an absolute "until" ms to the alert-mute endpoint.

let serverMuteUntilMs = 0;

/** Mute server-side alerts until `untilMs` (absolute epoch ms). 0/​past clears it. */
export function setServerAlertMute(untilMs: number): void {
  serverMuteUntilMs = Number.isFinite(untilMs) && untilMs > 0 ? untilMs : 0;
}

export function clearServerAlertMute(): void {
  serverMuteUntilMs = 0;
}

export function getServerAlertMuteUntilMs(): number {
  return serverMuteUntilMs;
}

/** Minute-of-day in a tz given by a fixed UTC offset (minutes). For quiet-hours. */
export function minuteOfDayForOffset(nowMs: number, tzOffsetMin: number): number {
  const shifted = nowMs + tzOffsetMin * 60_000;
  const d = new Date(shifted);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
