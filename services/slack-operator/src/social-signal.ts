// The morning digest's social line — one sentence of public record, daily.
//
// This reads the SAME public `/transparency` payload that averray.com/transparency
// renders and that the signal sweep in the `agent` repo evaluates. It deliberately
// does NOT re-implement that sweep.
//
// The division is: **this observes, CI decides.**
//
// The sweep owns the announcement decision — edge-triggered thresholds, the
// truth-boundary veto, committed state saying what has already been said. That
// lives in the `agent` repo beside the schema constant it depends on and the
// tests that pin it. Porting the veto here would put two implementations of a
// truth boundary in two repositories, and two implementations of a rule that
// exists to stop false claims is exactly the rule you cannot afford to have
// drift.
//
// This line makes no claim and publishes nothing. It reports a reading and how
// fresh it is, so the operator sees the two numbers that matter every morning —
// above all `composition24h.external`, because the day it stops being 0 is the
// day the interesting thing happened.
//
// Truth boundary, in order of how badly each would mislead:
//
//  1. A failed or unreadable read NEVER shows figures. "0 external agents" and
//     "we could not ask" must never render the same, because the first is a
//     fact about the product and the second is a fact about our instruments.
//  2. A stale field is labelled stale. The transparency service already decided
//     it could not vouch for the reading; this line does not get to overrule it.
//  3. The line never counts toward "needs you now". A post worth writing is not
//     an operational incident, and inflating the urgency count with one is how
//     the urgency count stops meaning anything.

const TRANSPARENCY_PATH = "/transparency";
const EXPECTED_SCHEMA_VERSION = "averray.transparency.v1";

export interface SocialSignalLine {
  text: string;
  /** "ok" — a real reading. "degraded" — we could not look. Never counted as urgent. */
  tone: "ok" | "degraded";
}

interface TransparencyField {
  value: number | null;
  status: string;
}

/** Read a dotted path, tolerating a missing branch rather than throwing. */
function field(snapshot: unknown, path: string): TransparencyField {
  const node = path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      snapshot,
    );
  if (!node || typeof node !== "object") return { value: null, status: "unknown" };
  const record = node as Record<string, unknown>;
  const raw = Number(record.value);
  return {
    value: Number.isFinite(raw) ? raw : null,
    status: typeof record.status === "string" ? record.status : "unknown",
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Compose the line from an already-fetched payload. Pure, so every rendering
 * decision — especially the degraded ones — is testable without a network.
 */
export function buildSocialSignalLine(snapshot: unknown): SocialSignalLine {
  if (!snapshot || typeof snapshot !== "object") {
    return { text: "could not read the public record — no figures either way", tone: "degraded" };
  }

  const version = (snapshot as Record<string, unknown>).schemaVersion;
  if (version !== EXPECTED_SCHEMA_VERSION) {
    // Reading fields out of a payload whose shape we do not recognise is how a
    // wrong number gets published with confidence.
    return {
      text: `public record is a shape we do not know (${String(version ?? "no version")}) — no figures either way`,
      tone: "degraded",
    };
  }

  const settled = field(snapshot, "flow.jobsSettled.allTime");
  const external = field(snapshot, "flow.composition24h.external");

  if (settled.status === "unknown" && external.status === "unknown") {
    return { text: "public record answered but carried no figures", tone: "degraded" };
  }

  const parts: string[] = [];
  parts.push(
    settled.status === "unknown"
      ? "settled jobs unreadable"
      : `${settled.value} settled${settled.status === "fresh" ? "" : ` (${settled.status})`}`,
  );

  if (external.status === "unknown") {
    parts.push("external agents unreadable");
  } else {
    const count = external.value ?? 0;
    const suffix = external.status === "fresh" ? "" : ` (${external.status})`;
    parts.push(
      count === 0
        ? `no external agents in 24h${suffix}`
        : `${count} external ${plural(count, "agent", "agents")} in 24h${suffix}`,
    );
  }

  const anyStale = [settled.status, external.status].some((s) => s !== "fresh");
  const line = parts.join(", ");

  // The one transition worth interrupting a morning for. Flagged, never
  // announced — whether it is postable is the sweep's call, not this line's.
  const worthSaying = (external.value ?? 0) >= 1 && external.status === "fresh";

  return {
    text: worthSaying ? `${line} — first outside activity, worth a post` : line,
    tone: anyStale ? "degraded" : "ok",
  };
}

/**
 * Fetch and compose. Returns `null` when the feature is simply not configured —
 * an absent line, the way the bank line is absent when there is no bank lane.
 * That is distinct from `degraded`, which means we were meant to look and could
 * not.
 */
export async function readSocialSignal({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<SocialSignalLine | null> {
  const base = env.AVERRAY_API_BASE_URL;
  if (!base) return null;

  const url = `${base.replace(/\/+$/, "")}${TRANSPARENCY_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        text: `public record unreachable (HTTP ${response.status}) — no figures either way`,
        tone: "degraded",
      };
    }
    return buildSocialSignalLine(await response.json());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `public record unreachable (${reason}) — no figures either way`, tone: "degraded" };
  } finally {
    clearTimeout(timer);
  }
}
