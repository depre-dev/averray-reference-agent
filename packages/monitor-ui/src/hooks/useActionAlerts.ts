// Hermes Handoff Monitor — action-needed alerts (M9', §17).
//
// Watches the action-needed count and drives all three notification
// tiers on the 0 → >0 edge:
//   1. in-app: a procedural Web Audio chime when the tab is visible
//   2. tab badge + title: document.title + canvas favicon + Badging API
//      (these track the count on every change, not just the edge)
//   3. desktop Notification when the tab is hidden (permission granted)
//
// Mute is honoured for tiers 1 & 3 (the operator silenced alerts) but the
// passive tab badge/title still reflect reality — muting shouldn't hide
// that action is pending. Everything is dependency-injected so the whole
// orchestration is testable without real audio/notification/DOM backends.

import { useCallback, useEffect, useRef, useState } from "react";
import { playAlertTone, type MinimalAudioContext } from "../lib/monitor/alert-audio.js";
import { setAppBadge, setFaviconBadge } from "../lib/monitor/favicon.js";
import {
  DEFAULT_TITLE,
  documentTitleFor,
  isMuted,
  readMuteUntil,
  shouldAlert,
  writeMuteUntil,
} from "../lib/monitor/notifications.js";
import type { StorageLike } from "../lib/monitor/snapshot-store.js";

interface NotificationCtorLike {
  new (title: string, options?: { body?: string }): unknown;
  permission: string;
  requestPermission?: () => Promise<string> | void;
}

export interface UseActionAlertsOptions {
  enabled?: boolean;
  now?: () => number;
  storage?: StorageLike;
  audioContextCtor?: new () => MinimalAudioContext;
  notificationCtor?: NotificationCtorLike;
  /** Is the tab visible? Default reads document.visibilityState. */
  isVisible?: () => boolean;
  doc?: Document;
  nav?: Navigator;
  baseTitle?: string;
}

export interface ActionAlertsState {
  muted: boolean;
  muteUntil: number | null;
  /** Mute until an absolute timestamp (from parseMuteArg). */
  mute: (untilMs: number) => void;
  unmute: () => void;
  /** Best-effort desktop-notification permission prompt (needs a gesture). */
  requestPermission: () => void;
}

function noopStorage(): StorageLike {
  return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, length: 0, key: () => null };
}

function resolveStorage(override?: StorageLike): StorageLike {
  if (override) return override;
  const ls = typeof globalThis !== "undefined" ? (globalThis as { localStorage?: unknown }).localStorage : undefined;
  // Only trust it if it actually conforms — some environments expose a
  // non-Storage value here, which would crash on getItem.
  if (ls && typeof (ls as StorageLike).getItem === "function" && typeof (ls as StorageLike).setItem === "function") {
    return ls as StorageLike;
  }
  return noopStorage();
}

export function useActionAlerts(actionCount: number, opts: UseActionAlertsOptions = {}): ActionAlertsState {
  const enabled = opts.enabled ?? true;
  // Date.now is a stable reference (unlike `() => Date.now()`), so it
  // won't churn the alert effect's dependency array.
  const now = opts.now ?? Date.now;
  const base = opts.baseTitle ?? DEFAULT_TITLE;

  // Latest-value refs so the alert effect depends only on the count.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const storage = resolveStorage(opts.storage);
  const storageRef = useRef(storage);
  storageRef.current = storage;

  const [muteUntil, setMuteUntil] = useState<number | null>(() => readMuteUntil(storage));
  const muteUntilRef = useRef(muteUntil);
  muteUntilRef.current = muteUntil;

  // Skip the very first observed count so opening the page with pending
  // action doesn't fire an alert — only live transitions do.
  const prevRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const o = optsRef.current;
    const doc = o.doc ?? (typeof document !== "undefined" ? document : undefined);
    const nav = o.nav ?? (typeof navigator !== "undefined" ? navigator : undefined);

    // Tiers 2: passive badge/title — always reflect the count.
    if (doc) doc.title = documentTitleFor(actionCount, base);
    setFaviconBadge(actionCount, doc);
    setAppBadge(actionCount, nav);

    const prev = prevRef.current;
    prevRef.current = actionCount;
    if (prev === null) return; // first observation — establish baseline only

    if (!shouldAlert(prev, actionCount)) return;
    if (isMuted(muteUntilRef.current, now)) return;

    const visible = (o.isVisible ?? defaultIsVisible)();
    if (visible) {
      const Ctor = o.audioContextCtor ?? defaultAudioContextCtor();
      if (Ctor) {
        try {
          playAlertTone(new Ctor());
        } catch {
          /* autoplay blocked / unsupported */
        }
      }
    } else {
      fireDesktopNotification(actionCount, o.notificationCtor ?? defaultNotificationCtor());
    }
  }, [actionCount, enabled, base, now]);

  const mute = useCallback((untilMs: number) => {
    writeMuteUntil(storageRef.current, untilMs);
    setMuteUntil(untilMs);
  }, []);

  const unmute = useCallback(() => {
    writeMuteUntil(storageRef.current, null);
    setMuteUntil(null);
  }, []);

  const requestPermission = useCallback(() => {
    const Ctor = optsRef.current.notificationCtor ?? defaultNotificationCtor();
    if (Ctor && typeof Ctor.requestPermission === "function" && Ctor.permission === "default") {
      void Ctor.requestPermission();
    }
  }, []);

  return { muted: isMuted(muteUntil, now), muteUntil, mute, unmute, requestPermission };
}

function fireDesktopNotification(count: number, Ctor: NotificationCtorLike | undefined): void {
  if (!Ctor || Ctor.permission !== "granted") return;
  try {
    new Ctor("Hermes — action needed", {
      body: count === 1 ? "1 card needs your review." : `${count} cards need your review.`,
    });
  } catch {
    /* unsupported */
  }
}

function defaultIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function defaultAudioContextCtor(): (new () => MinimalAudioContext) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: new () => MinimalAudioContext; webkitAudioContext?: new () => MinimalAudioContext };
  return w.AudioContext ?? w.webkitAudioContext;
}

function defaultNotificationCtor(): NotificationCtorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Notification?: NotificationCtorLike }).Notification;
}
