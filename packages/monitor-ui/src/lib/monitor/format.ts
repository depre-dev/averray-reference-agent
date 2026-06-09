// Shared number/time formatters for the monitor surfaces. Extracted verbatim
// from BoardView so the Utilities panel (UtilitiesPanel, UsagePanel) and the
// board can share one honest implementation instead of duplicating it.

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "last active unknown";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "last active unknown";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
