// Deadlines for the product-health heartbeat.
//
// On 2026-10-10 the 17:00:50Z tick started and never finished. `running` stayed
// true, every later tick was skipped, and the board served a five-hour-old
// snapshot labelled only "data stale, poll failing". Nothing was logged, and
// the container held no socket to the backend — a promise that neither
// resolves nor rejects, not a hung TCP connection.
//
// Two clocks stop that from happening again:
//   · every awaited probe and feed races an explicit deadline and comes back
//     degraded ("timed out after Ns") so the tick can finish
//   · the whole tick has a watchdog at 2 × the check interval. Past that, the
//     running flag clears, an incident names the probes still pending, and the
//     next tick starts. A generation counter drops the abandoned tick's late
//     write so it cannot paint over the newer result.

import { logger } from "@avg/mcp-common";
import {
  MONITOR_REFRESH_MULTIPLE,
  type MonitorRefreshClock,
  monitorRefreshOverdue,
} from "@avg/schemas/ops-verdict";

export const PROBE_DEADLINE_MS = 20_000;
export const SLOW_PROBE_WARN_MS = 10_000;

export function probeTimeoutDetail(deadlineMs: number): string {
  const seconds = Math.max(1, Math.round(deadlineMs / 1000));
  return `timed out after ${seconds}s`;
}

export interface ProbeLog {
  debug(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Names still inside an awaited probe. `enter` returns the matching `leave`. */
export interface ProbePending {
  enter(name: string): () => void;
}

const defaultLog: ProbeLog = logger;

export async function runWithDeadline<T>(input: {
  name: string;
  run: () => Promise<T>;
  onTimeout: (detail: string) => T;
  deadlineMs?: number;
  slowMs?: number;
  now?: () => number;
  log?: ProbeLog;
  pending?: ProbePending;
}): Promise<T> {
  const deadlineMs = input.deadlineMs ?? PROBE_DEADLINE_MS;
  const slowMs = input.slowMs ?? SLOW_PROBE_WARN_MS;
  const now = input.now ?? Date.now;
  const log = input.log ?? defaultLog;
  const started = now();
  const leave = input.pending?.enter(input.name);
  log.debug({ probe: input.name }, "product_health_probe_start");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      input.run().then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      timeout,
    ]);
    const durationMs = Math.max(0, now() - started);
    if (outcome.kind === "timeout") {
      log.warn(
        { probe: input.name, durationMs, deadlineMs },
        "product_health_probe_deadline",
      );
      return input.onTimeout(probeTimeoutDetail(deadlineMs));
    }
    log.debug({ probe: input.name, durationMs }, "product_health_probe_done");
    if (outcome.kind === "error") {
      if (durationMs >= slowMs) {
        log.warn({ probe: input.name, durationMs }, "product_health_probe_slow");
      }
      throw outcome.error;
    }
    if (durationMs >= slowMs) {
      log.warn({ probe: input.name, durationMs }, "product_health_probe_slow");
    }
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
    leave?.();
  }
}

export function stuckTickNote(sinceMs: number, pending: readonly string[]): string {
  const names = pending.length > 0 ? [...pending].sort().join(", ") : "unknown";
  const since = new Date(sinceMs).toISOString();
  return `product-health tick stuck since ${since} in ${names}`;
}

export interface StuckTickEvent {
  sinceMs: number;
  pending: string[];
  note: string;
}

/**
 * The running-flag + generation gate around one product-health tick.
 *
 * `tryBegin` fails while a tick is in progress. The watchdog clears that flag
 * without advancing the generation; the next `tryBegin` advances it. `finish`
 * applies a result only when the generation is still the latest one, so an
 * abandoned tick cannot write over a newer one.
 */
export class ProductHealthTickGate implements ProbePending {
  private running = false;
  private generation = 0;
  private settledGeneration = 0;
  private startedAt = 0;
  private readonly pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastCompletedAtMs: number | null = null;

  constructor(private readonly deps: {
    intervalMs: () => number;
    now: () => number;
    onStuck: (event: StuckTickEvent) => void;
  }) {}

  lastCompletedAt(): number | null {
    return this.lastCompletedAtMs;
  }

  tryBegin(): { generation: number } | null {
    if (this.running) return null;
    this.running = true;
    this.generation += 1;
    this.pending.clear();
    this.startedAt = this.deps.now();
    this.arm(this.generation);
    return { generation: this.generation };
  }

  /** True only for the tick that is still the latest one started. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * Apply `write` if this tick is still the latest generation.
   * Returns false when the result was discarded.
   */
  finish(generation: number, write: () => void): boolean {
    if (!this.isCurrent(generation)) return false;
    if (this.settledGeneration === generation) return false;
    write();
    this.settledGeneration = generation;
    this.lastCompletedAtMs = this.deps.now();
    if (this.running && this.generation === generation) {
      this.running = false;
      this.clearTimer();
      this.pending.clear();
    }
    return true;
  }

  /** Clear the running flag if this tick is still current and still marked running. */
  settle(generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
  }

  enter(name: string): () => void {
    const generation = this.generation;
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (generation !== this.generation) return;
      const next = (this.pending.get(name) ?? 0) - 1;
      if (next <= 0) this.pending.delete(name);
      else this.pending.set(name, next);
    };
  }

  pendingNames(): string[] {
    return [...this.pending.keys()].sort();
  }

  private arm(generation: number): void {
    this.clearTimer();
    const waitMs = Math.max(1, this.deps.intervalMs()) * MONITOR_REFRESH_MULTIPLE;
    this.timer = setTimeout(() => {
      if (generation !== this.generation || !this.running) return;
      this.running = false;
      const pending = this.pendingNames();
      this.deps.onStuck({
        sinceMs: this.startedAt,
        pending,
        note: stuckTickNote(this.startedAt, pending),
      });
    }, waitMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export interface MonitorRefreshAlertInput extends MonitorRefreshClock {
  /** Repeat interval of an unchanged episode. The caller stores `pagedForMs`. */
  pagedForMs: number | null;
  muted: boolean;
  quiet: boolean;
}

/**
 * Page once per freeze. Mute and quiet hours suppress the send and do not
 * consume the episode, so the page still goes out when the suppression lifts.
 * A completed tick (no longer overdue) re-arms the next freeze.
 */
export function decideMonitorRefreshAlert(input: MonitorRefreshAlertInput): {
  page: boolean;
  sinceMs: number | null;
  pagedForMs: number | null;
} {
  const overdue = monitorRefreshOverdue(input);
  if (!overdue) return { page: false, sinceMs: null, pagedForMs: null };
  if (input.muted || input.quiet) {
    return { page: false, sinceMs: overdue.sinceMs, pagedForMs: input.pagedForMs };
  }
  if (input.pagedForMs === overdue.sinceMs) {
    return { page: false, sinceMs: overdue.sinceMs, pagedForMs: input.pagedForMs };
  }
  return { page: true, sinceMs: overdue.sinceMs, pagedForMs: overdue.sinceMs };
}

export function monitorRefreshAlertText(sinceMs: number, boardUrl: string): string {
  return [
    `:rotating_light: Averray monitor not refreshing since ${new Date(sinceMs).toISOString()}`,
    "The product-health heartbeat has not finished a check.",
    `Inspect: ${boardUrl}`,
  ].join("\n");
}
