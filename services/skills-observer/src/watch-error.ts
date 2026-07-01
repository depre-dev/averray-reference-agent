/**
 * Classify a chokidar/fs watch error so the observer can react without
 * crash-looping. Access-class errors (the skills volume not readable by this
 * container's user, or not present yet) are operational: log a clear remediation
 * and retry rather than let the process exit. Anything else is a genuine fault.
 */
export interface WatchErrorDisposition {
  /** True when the watcher should be torn down and re-established after a delay. */
  retryable: boolean;
  /** Structured log key. */
  logKey: string;
  /** Operator-facing remediation, present only for retryable access errors. */
  remediation?: string;
}

const RETRYABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT"]);

export function describeWatchError(error: unknown): WatchErrorDisposition {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;

  if (code && RETRYABLE_CODES.has(code)) {
    return {
      retryable: true,
      logKey: "skills_observer_watch_unavailable",
      remediation:
        `cannot watch the skills directory (${code}). The skills volume must be readable by ` +
        `this container's user; Hermes owns it as UID 10000 and secures it to mode 0700, so run ` +
        `skills-observer as user "10000:10000". Will retry.`
    };
  }

  return { retryable: false, logKey: "skills_observer_error" };
}
