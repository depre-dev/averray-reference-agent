// One shared in-flight slot that must not stay occupied forever.
//
// The product-health freeze on 2026-10-10 was a tick that never finished and
// logged nothing. The container had no socket to the backend, which is what a
// shared promise looks like when it never settles and never rejects: the
// `running` flag stays true, and every later refresh bails out.
//
// `beginAttempt` is the slot. It clears itself on success, on rejection (the
// caller calls `finish` from `finally`), and when `timeoutMs` elapses even if
// the underlying promise is still pending. A result that arrives after the
// timeout — or after a newer attempt has replaced this one — sees `current()`
// false and must not write.

export interface InflightAttempt {
  /** False once `finish` runs or the timeout wins. */
  current(): boolean;
  /** Disarm the timer. No-op if the timeout already took the slot. */
  finish(): void;
}

export function beginAttempt(timeoutMs: number, onTimeout: () => void): InflightAttempt {
  let open = true;
  const timer = setTimeout(() => {
    if (!open) return;
    open = false;
    onTimeout();
  }, timeoutMs);
  // A background refresh must not keep a short-lived process alive. The
  // monitor's own interval already does that; this timer only frees the slot.
  timer.unref?.();
  return {
    current: () => open,
    finish: () => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
    },
  };
}

/**
 * Settle `work` or reject with `AbortError` when `timeoutMs` elapses.
 *
 * `Promise.race` attaches a handler to `work`, so a rejection that arrives
 * after the deadline is not an unhandled rejection. The caller ignores that
 * late result because this promise has already rejected.
 */
export function raceDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("timed out");
      error.name = "AbortError";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
