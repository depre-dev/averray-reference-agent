import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { optionalEnv } from "./config.js";
import { logger } from "./logger.js";

/**
 * Record which MCP bundle each running server process was started from.
 *
 * WHY THIS EXISTS. The five MCP servers are not in the consumer's image — they
 * live in the `avg-app` volume, which the `mcp-bundle` service rewrites on
 * every deploy (see ops/compose.yml). `hermes` and `hermes-gateway` mount that
 * volume read-only at /app and spawn the servers from it, and an MCP client
 * registers its tool list ONCE, at process startup. A consumer that is not
 * restarted therefore keeps advertising the previous tool list against the new
 * files, and nothing errors.
 *
 * On 2026-08-02 `averray_board_health` (#657) shipped while hermes-gateway had
 * been up nine hours. It never saw the tool, so the Buzz inbound listener
 * answered an operator's question about system health from `averray_ops_health`
 * — the Postgres control plane, which is explicitly not the board — and
 * reported "No issues on the board" having never read the board. A stale tool
 * registry looks exactly like a working agent.
 *
 * ops/deploy-monitor.sh is the fix: it restarts every consumer of the volume.
 * This is the backstop for every path that is not that script — a hand
 * `docker compose up`, a restart that failed, a consumer nobody remembered.
 * Each process stamps the bundle it loaded; skills-observer compares those
 * stamps against the volume and reports when they disagree.
 *
 * Three rules this obeys, all of them load-bearing:
 *
 *   IT NEVER BREAKS THE SERVER. Every operation is best-effort and swallows its
 *   own errors. An observability record that can take down the agent's tool
 *   surface would be a worse bug than the one it reports.
 *
 *   IT IS SYNCHRONOUS. This runs in the startup path of a stdio server. An
 *   async write that hangs would delay `server.connect`, and one that rejects
 *   later would be an unhandled rejection in a process whose job is to stay up.
 *   The payload is a couple of hundred bytes.
 *
 *   IT NEVER TOUCHES STDOUT. stdout IS the MCP transport — a stray write
 *   corrupts the protocol. `logger` goes to stderr (logger.ts); keep it there.
 */

/** Written into the volume by `mcp-bundle` as the last step of publishing it. */
export const BUNDLE_ID_FILE = ".mcp-bundle-id";

/**
 * What an unstamped bundle reports. NOT a bundle id that can match another: a
 * consumer running an unstamped copy is unknown, not current, and the observer
 * has to be able to tell those apart rather than folding one into the other.
 */
export const UNKNOWN_BUNDLE_ID = "unknown";

/** The `avg-data` volume, which every bundle consumer already mounts at /data. */
const DEFAULT_REGISTRY_DIR = "/data/mcp-bundle-registry";

/**
 * A record only means something while the process it describes is alive. A dead
 * process's stamp would report drift forever, and drift that never clears is
 * drift nobody reads (see services/skills-observer/src/drift-alert.ts). So each
 * process rewrites its own record on this interval, and the reader ignores
 * records that have stopped being refreshed.
 */
const DEFAULT_HEARTBEAT_MS = 60_000;

/** Beyond this a record describes a process that is gone. Five missed beats. */
export const RECORD_LIVE_MS = 5 * DEFAULT_HEARTBEAT_MS;

/**
 * Records this old are from containers that no longer exist — every consumer is
 * recreated far more often than this. Pruned so a volume that is never emptied
 * does not accumulate one file per server per container for the life of the box.
 */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface McpProcessRecord {
  /** The file that was executed, as the consumer sees it inside its own mounts. */
  entry: string;
  /** Container hostname — the identity of the consumer holding this process. */
  host: string;
  pid: number;
  /** When this process started, not when the record was last refreshed. */
  startedAt: string;
  /** The bundle it loaded, read once at startup. Never re-read afterwards. */
  bundleId: string;
}

/**
 * One file per (consumer, entry point), so a restart overwrites its predecessor
 * instead of leaving a second record that looks like a second live process.
 */
export function bundleRecordFileName(host: string, entry: string): string {
  const slug = `${host}__${entry}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "unnamed"}.json`;
}

/**
 * Find the stamp of the bundle `entryPath` was loaded from, by walking up from
 * the entry towards the root.
 *
 * Deliberately derived from the executed file rather than from a configured
 * path: what matters is the copy this process actually ran, and only the entry
 * knows that. A dev run from a source checkout finds no stamp and reports
 * unknown, which is the truth — there is no published bundle to be stale
 * against.
 */
export function readBundleId(entryPath: string): string {
  let dir = path.dirname(path.resolve(entryPath));
  for (;;) {
    try {
      const contents = fs.readFileSync(path.join(dir, BUNDLE_ID_FILE), "utf8").trim();
      if (contents) return contents;
    } catch {
      // Not here — keep climbing. An unreadable stamp is the same as no stamp:
      // nothing can be claimed either way.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return UNKNOWN_BUNDLE_ID;
    dir = parent;
  }
}

export function buildMcpProcessRecord(entryPath: string, startedAt: Date): McpProcessRecord {
  return {
    entry: entryPath,
    host: os.hostname(),
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    bundleId: readBundleId(entryPath)
  };
}

/** Best-effort. Returns whether the record reached disk, and never throws. */
export function writeMcpProcessRecord(directory: string, record: McpProcessRecord): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, bundleRecordFileName(record.host, record.entry)),
      `${JSON.stringify(record, null, 2)}\n`
    );
    return true;
  } catch {
    return false;
  }
}

/** Best-effort. Returns how many records it removed, and never throws. */
export function pruneMcpProcessRecords(directory: string, now: number, olderThanMs: number): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(directory, name);
    try {
      if (now - fs.statSync(filePath).mtimeMs <= olderThanMs) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch {
      // Another process may own or have just replaced it. Not ours to insist on.
    }
  }
  return removed;
}

/**
 * Stamp this process into the registry and keep the stamp fresh for as long as
 * it runs. Call once, at startup.
 *
 * The heartbeat timer is unref'd: a stdio server is kept alive by its transport,
 * and a referenced timer would outlive it and leave the process hanging after
 * the client disconnects. Bookkeeping must not decide when the server exits.
 */
export function registerMcpProcess(options: {
  entryPath?: string;
  directory?: string;
  heartbeatMs?: number;
  now?: () => Date;
} = {}): void {
  const entryPath = options.entryPath ?? process.argv[1];
  if (!entryPath) return;

  const directory = options.directory ?? optionalEnv("MCP_BUNDLE_REGISTRY_DIR", DEFAULT_REGISTRY_DIR);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? (() => new Date());

  const record = buildMcpProcessRecord(entryPath, now());
  if (!writeMcpProcessRecord(directory, record)) {
    // Worth a line, but only a line. The registry is a backstop; the deploy is
    // the guarantee. Note that skills-observer reads the ABSENCE of records as
    // unknown rather than as agreement, so a consumer failing this write cannot
    // make the fleet look current — it makes it look unreadable, which it is.
    logger.warn(
      { directory, entry: entryPath },
      "mcp_bundle_record_write_failed: this process cannot record which bundle it loaded, so " +
        "drift detection cannot speak for it. ops/deploy-monitor.sh remains the guarantee."
    );
    return;
  }

  pruneMcpProcessRecords(directory, now().getTime(), PRUNE_AFTER_MS);
  logger.info(
    { entry: record.entry, bundleId: record.bundleId },
    "mcp_bundle_record_written"
  );

  // Rewriting beats touching the mtime: it repairs a record that was deleted
  // out from under us, and costs the same at this size.
  setInterval(() => writeMcpProcessRecord(directory, record), heartbeatMs).unref();
}
