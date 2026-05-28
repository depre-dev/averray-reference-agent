// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useActionAlerts, type UseActionAlertsOptions } from "./useActionAlerts.js";
import { MUTE_STORAGE_KEY } from "../lib/monitor/notifications.js";
import type { MinimalAudioContext } from "../lib/monitor/alert-audio.js";
import type { StorageLike } from "../lib/monitor/snapshot-store.js";

afterEach(cleanup);

beforeAll(() => {
  // Silence jsdom's "canvas getContext not implemented" log; the favicon
  // badge no-ops without a 2D context, which a null return models exactly.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

function memStorage(seed?: Record<string, string>): StorageLike {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

function fakeAudio() {
  let plays = 0;
  class FakeCtx implements MinimalAudioContext {
    currentTime = 0;
    destination = {} as AudioNode;
    createOscillator() {
      plays += 1;
      return {
        type: "",
        frequency: { value: 0 },
        connect() {},
        start() {},
        stop() {},
      } as unknown as OscillatorNode;
    }
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      } as unknown as GainNode;
    }
  }
  return { Ctor: FakeCtx as unknown as new () => MinimalAudioContext, plays: () => plays };
}

function fakeNotification(permission: string) {
  const built: string[] = [];
  const Ctor = function (this: unknown, title: string) {
    built.push(title);
  } as unknown as UseActionAlertsOptions["notificationCtor"] & { permission: string; requestPermission: () => void };
  (Ctor as unknown as { permission: string }).permission = permission;
  (Ctor as unknown as { requestPermission: () => void }).requestPermission = vi.fn();
  return { Ctor, built };
}

function baseOpts(over: Partial<UseActionAlertsOptions> = {}): UseActionAlertsOptions {
  return {
    storage: memStorage(),
    isVisible: () => true,
    now: () => 1_000,
    ...over,
  };
}

describe("useActionAlerts — passive badge/title", () => {
  test("title tracks the count on every change", () => {
    const { rerender } = renderHook((count: number) => useActionAlerts(count, baseOpts()), { initialProps: 0 });
    expect(document.title).toBe("Hermes — Averray");
    rerender(3);
    expect(document.title).toBe("(3) Hermes — Averray");
    rerender(0);
    expect(document.title).toBe("Hermes — Averray");
  });
});

describe("useActionAlerts — chime (visible)", () => {
  test("plays on the 0→>0 edge, not on the initial observation or 1→2", () => {
    const audio = fakeAudio();
    const opts = baseOpts({ audioContextCtor: audio.Ctor, isVisible: () => true });
    const { rerender } = renderHook((count: number) => useActionAlerts(count, opts), { initialProps: 2 });
    // First observation establishes the baseline — no chime even though >0.
    expect(audio.plays()).toBe(0);
    rerender(3); // 2→3, still >0, no fresh edge
    expect(audio.plays()).toBe(0);
    rerender(0); // cleared
    rerender(1); // 0→1 edge → chime
    expect(audio.plays()).toBe(1);
  });

  test("does not chime while muted, but the title still updates", () => {
    const audio = fakeAudio();
    const opts = baseOpts({
      audioContextCtor: audio.Ctor,
      storage: memStorage({ [MUTE_STORAGE_KEY]: "999999" }), // muted until far future
      now: () => 1_000,
    });
    const { rerender } = renderHook((count: number) => useActionAlerts(count, opts), { initialProps: 0 });
    rerender(2);
    expect(audio.plays()).toBe(0);
    expect(document.title).toBe("(2) Hermes — Averray");
  });
});

describe("useActionAlerts — desktop notification (hidden)", () => {
  test("fires when hidden + permission granted, on the 0→>0 edge", () => {
    const notif = fakeNotification("granted");
    const opts = baseOpts({ notificationCtor: notif.Ctor, isVisible: () => false });
    const { rerender } = renderHook((count: number) => useActionAlerts(count, opts), { initialProps: 0 });
    rerender(1);
    expect(notif.built).toEqual(["Hermes — action needed"]);
  });

  test("does not fire without granted permission", () => {
    const notif = fakeNotification("default");
    const opts = baseOpts({ notificationCtor: notif.Ctor, isVisible: () => false });
    const { rerender } = renderHook((count: number) => useActionAlerts(count, opts), { initialProps: 0 });
    rerender(1);
    expect(notif.built).toEqual([]);
  });
});

describe("useActionAlerts — mute controls", () => {
  test("mute/unmute persist and reflect in `muted`", () => {
    const storage = memStorage();
    const { result } = renderHook(() => useActionAlerts(0, baseOpts({ storage, now: () => 1_000 })));
    expect(result.current.muted).toBe(false);

    act(() => result.current.mute(5_000));
    expect(result.current.muted).toBe(true);
    expect(result.current.muteUntil).toBe(5_000);
    expect(storage.getItem(MUTE_STORAGE_KEY)).toBe("5000");

    act(() => result.current.unmute());
    expect(result.current.muted).toBe(false);
    expect(storage.getItem(MUTE_STORAGE_KEY)).toBeNull();
  });

  test("hydrates the muted state from storage", () => {
    const { result } = renderHook(() =>
      useActionAlerts(0, baseOpts({ storage: memStorage({ [MUTE_STORAGE_KEY]: "9999" }), now: () => 1_000 })),
    );
    expect(result.current.muted).toBe(true);
  });
});
