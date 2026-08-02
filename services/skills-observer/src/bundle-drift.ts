import fs from "node:fs/promises";
import path from "node:path";

import {
  BUNDLE_ID_FILE,
  RECORD_LIVE_MS,
  UNKNOWN_BUNDLE_ID,
  type McpProcessRecord
} from "@avg/mcp-common";

/**
 * Report when a running consumer's MCP tool registry is older than the bundle.
 *
 * The bundle is the `avg-app` volume: the five MCP servers live there, not in
 * the consumers' images. `mcp-bundle` rewrites it on every deploy, but an MCP
 * client registers its tool list once, at process startup — so a consumer that
 * is not restarted keeps serving the previous tool list against the new files,
 * silently. That is the 2026-08-02 `averray_board_health` incident: the gateway
 * answered a health question from the wrong tool because it had never seen the
 * right one, and looked entirely healthy doing it.
 *
 * ops/deploy-monitor.sh is the guarantee — it restarts every consumer of the
 * volume. This is the backstop for the paths that are not that script.
 *
 * WHAT IT COMPARES. Not tool lists: the bundle id. The tool list is downstream
 * of which copy a process loaded, so the id catches strictly more (a changed
 * description, a changed handler, a removed tool) and needs no build-time
 * manifest to be kept honest. `packages/mcp-common/src/bundle-registry.ts`
 * writes the stamps; this reads them.
 *
 * WHAT IT CANNOT SEE, stated plainly because a check that implies more coverage
 * than it has is the failure it exists to prevent: a consumer whose MCP
 * processes never manage to write a record is invisible here. It cannot make
 * the fleet look current — zero records reads as unknown, never as agreement —
 * but a consumer that is silent while another is healthy will not be singled
 * out. The deploy-side restart, not this, is what makes coverage complete.
 */

/** A record still being refreshed by the process that wrote it. */
export interface LiveMcpProcess extends McpProcessRecord {
  /** How long ago the record was last refreshed. */
  ageMs: number;
}

export type BundleObservation =
  /** Every live process is running the bundle the volume currently holds. */
  | { kind: "current"; live: LiveMcpProcess[] }
  /** At least one live process is serving a tool list from an older copy. */
  | { kind: "stale"; signature: string; stale: LiveMcpProcess[]; live: LiveMcpProcess[] }
  /** The comparison could not be made. Never conflate this with agreement. */
  | { kind: "unknown"; reason: string };

/** One pass over the registry: what was read, and what could not be. */
export interface RegistryReading {
  live: LiveMcpProcess[];
  /**
   * Records present but unreadable this pass. Carried rather than dropped: a
   * record skipped here is a live process the comparison cannot see, and the
   * one thing that must never happen is a process disappearing from view and
   * the remainder then reporting agreement.
   */
  unreadable: string[];
}

/** The published bundle's stamp, or undefined when it could not be read. */
export async function readPublishedBundleId(bundleDir: string): Promise<string | undefined> {
  try {
    const contents = (await fs.readFile(path.join(bundleDir, BUNDLE_ID_FILE), "utf8")).trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every record still being heart-beaten.
 *
 * Liveness is the mtime, not the file's existence: a record left by a container
 * that is gone would otherwise report drift forever, and an alert that never
 * clears is one nobody reads.
 */
export async function readMcpProcessRegistry(
  registryDir: string,
  now: number,
  liveWithinMs = RECORD_LIVE_MS
): Promise<RegistryReading> {
  const entries = await fs.readdir(registryDir);
  const live: LiveMcpProcess[] = [];
  const unreadable: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(registryDir, name);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      const ageMs = now - stat.mtimeMs;
      // Not unreadable — this one was read, and it says its process is gone.
      if (ageMs > liveWithinMs) continue;
      const record = parseRecord(raw);
      if (record) live.push({ ...record, ageMs });
      else unreadable.push(name);
    } catch {
      // Torn mid-rewrite, or unreadable. Skipping it silently would be the
      // dangerous move: if the ONLY stale process is the one we could not read,
      // the survivors all match and the check would report agreement. So it is
      // counted, and agreement is withheld while any record is unaccounted for.
      unreadable.push(name);
    }
  }
  return {
    live: live.sort((a, b) => `${a.host}${a.entry}`.localeCompare(`${b.host}${b.entry}`)),
    unreadable: unreadable.sort()
  };
}

function parseRecord(raw: string): McpProcessRecord | undefined {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return undefined;
  const { entry, host, pid, startedAt, bundleId } = value as Record<string, unknown>;
  if (typeof entry !== "string" || typeof host !== "string" || typeof bundleId !== "string") {
    return undefined;
  }
  return {
    entry,
    host,
    bundleId,
    pid: typeof pid === "number" ? pid : 0,
    startedAt: typeof startedAt === "string" ? startedAt : ""
  };
}

/**
 * Decide what the stamps say about the published bundle.
 *
 * `UNKNOWN_BUNDLE_ID` on either side is not a value that can match: a process
 * that could not read its stamp, or a bundle published without one, tells us
 * nothing about whether they agree — and "nothing" must not round to "yes".
 */
export function compareBundle(
  publishedBundleId: string | undefined,
  reading: RegistryReading
): BundleObservation {
  const { live, unreadable } = reading;
  if (!publishedBundleId) {
    return {
      kind: "unknown",
      reason:
        "the published bundle carries no readable id, so what the consumers should be running " +
        "cannot be established"
    };
  }
  if (publishedBundleId === UNKNOWN_BUNDLE_ID) {
    return {
      kind: "unknown",
      reason:
        "the published bundle is stamped as unknown, so no consumer can be shown to match it"
    };
  }
  if (live.length === 0 && unreadable.length === 0) {
    return {
      kind: "unknown",
      reason:
        "no MCP server process is recording which bundle it loaded — either no consumer of the " +
        "bundle is running, or they cannot write the registry"
    };
  }

  // Stale first: a process demonstrably on an older bundle is a fact, and an
  // unreadable record elsewhere does not make it less true. Reporting the
  // weaker verdict here would bury the finding under its own caveat.
  const stale = live.filter((entry) => entry.bundleId !== publishedBundleId);
  if (stale.length > 0) {
    return { kind: "stale", signature: bundleDriftSignature(stale), stale, live };
  }

  if (unreadable.length > 0) {
    return {
      kind: "unknown",
      reason:
        `${unreadable.length} MCP process record(s) could not be read (${unreadable.join(", ")}), ` +
        "so agreement cannot be claimed — the unread ones could be the stale ones"
    };
  }

  return { kind: "current", live };
}

/**
 * A stable key for "this is the same divergence as last time", so a standing
 * condition is announced on the change rather than on every tick.
 */
export function bundleDriftSignature(stale: LiveMcpProcess[]): string {
  return stale
    .map((entry) => `${entry.host}:${entry.entry}@${entry.bundleId}`)
    .sort()
    .join("|");
}

/** One operator-facing line: which consumers, on what, instead of what. */
export function describeBundleObservation(
  observation: BundleObservation,
  publishedBundleId: string | undefined
): string {
  if (observation.kind === "unknown") return observation.reason;
  if (observation.kind === "current") {
    // NAME THE CONTAINERS, not just the count. "Current" here means only "every
    // process I could see is current", and a consumer whose records never
    // arrive is invisible to this check — which is the same shape as the bug it
    // exists to catch. Listing the containers is what lets an operator who
    // knows there should be two notice that this speaks for one.
    const consumers = [...new Set(observation.live.map((entry) => entry.host))].sort();
    return (
      `${observation.live.length} live MCP server processes across ${consumers.join(", ")} ` +
      `are running ${publishedBundleId} (this speaks only for containers that record)`
    );
  }
  const consumers = [...new Set(observation.stale.map((entry) => entry.host))].sort();
  const loaded = [...new Set(observation.stale.map((entry) => entry.bundleId))].sort();
  return (
    `${observation.stale.length} of ${observation.live.length} live MCP server processes are ` +
    `running ${loaded.join(", ")} while the bundle is ${publishedBundleId} ` +
    `(containers: ${consumers.join(", ")})`
  );
}
