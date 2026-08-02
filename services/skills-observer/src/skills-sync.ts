import fs from "node:fs/promises";
import path from "node:path";

import { diffSkillTrees, isInSync, readSkillTree, type SkillDrift, type SkillTree } from "./skills-tree.js";

/**
 * Copy the repo's skill tree into the volume Hermes reads.
 *
 * Kept separate from the sync entrypoint (sync.ts) so the two properties that
 * actually matter can be tested:
 *
 *   NEVER DELETES. Only paths the repo ships are written. Hermes authors its
 *   own skills into this same volume at runtime — that is what skills-observer
 *   watches for — so mirroring the repo would destroy the agent's own work.
 *
 *   VERIFIES, THEN REPORTS. Hermes owns the volume as UID 10000 and
 *   continuously re-secures it to 0700 as it writes, so an individual write can
 *   lose that race and fail EACCES. What matters is not whether every write
 *   succeeded but whether the volume ends up matching the repo, so the verdict
 *   comes from re-reading the tree afterwards. A write that failed on a file
 *   that was already correct is not a failure.
 */

export interface SyncOptions {
  repoDir: string;
  volumeDir: string;
  /** Retries per file, for losing a race with Hermes re-securing the volume. */
  writeAttempts?: number;
  writeRetryMs?: number;
}

export interface SyncFailure {
  relativePath: string;
  code?: string;
  message: string;
}

export type SyncStatus =
  /** The repo tree could not be read at all — almost always a broken mount. */
  | "repo-unreadable"
  /** The repo tree is empty, which no real checkout is. Treated as a fault. */
  | "repo-empty"
  /** The volume could not be read, so nothing about it can be established. */
  | "volume-unreadable"
  /** The volume already matched; nothing was written. */
  | "current"
  /** Files were copied and the volume now matches. */
  | "synced"
  /** Writes were attempted and the volume still does not match. */
  | "incomplete";

export interface SyncResult {
  status: SyncStatus;
  /** Repo-managed paths written during this run. */
  synced: string[];
  /** Individual write failures — informational; `drift` is the verdict. */
  failures: SyncFailure[];
  /** How the volume compares to the repo AFTER the attempt. */
  drift: SkillDrift;
  error?: unknown;
}

const ACCESS_CODES = new Set(["EACCES", "EPERM"]);
const NO_DRIFT: SkillDrift = { missing: [], modified: [] };

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readVolumeTree(volumeDir: string): Promise<SkillTree> {
  try {
    return await readSkillTree(volumeDir);
  } catch (error) {
    // An absent volume directory is the normal first-boot state, not a fault:
    // treat it as empty and let the copy below create it.
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }
}

export async function syncSkills(options: SyncOptions): Promise<SyncResult> {
  const { repoDir, volumeDir } = options;
  const writeAttempts = Math.max(1, options.writeAttempts ?? 3);
  const writeRetryMs = Math.max(0, options.writeRetryMs ?? 250);

  let repoTree: SkillTree;
  try {
    repoTree = await readSkillTree(repoDir);
  } catch (error) {
    // Fail closed and loudly. A missing repo mount that silently syncs nothing
    // is indistinguishable from the bug this exists to fix.
    return { status: "repo-unreadable", synced: [], failures: [], drift: NO_DRIFT, error };
  }

  if (repoTree.size === 0) {
    return { status: "repo-empty", synced: [], failures: [], drift: NO_DRIFT };
  }

  // An unreadable volume is the failure this whole service is shaped around
  // (Hermes secures it to 0700 as UID 10000), so it gets its own status and its
  // own remediation rather than escaping as an unhandled rejection.
  let before: SkillDrift;
  try {
    before = diffSkillTrees(repoTree, await readVolumeTree(volumeDir));
  } catch (error) {
    return { status: "volume-unreadable", synced: [], failures: [], drift: NO_DRIFT, error };
  }

  const stale = [...before.missing, ...before.modified];
  if (stale.length === 0) {
    return { status: "current", synced: [], failures: [], drift: NO_DRIFT };
  }

  const synced: string[] = [];
  const failures: SyncFailure[] = [];
  for (const relativePath of stale) {
    const failure = await copyOne(repoDir, volumeDir, relativePath, writeAttempts, writeRetryMs);
    if (failure) failures.push(failure);
    else synced.push(relativePath);
  }

  let drift: SkillDrift;
  try {
    drift = diffSkillTrees(repoTree, await readVolumeTree(volumeDir));
  } catch (error) {
    // Writes may well have landed, but with no way to re-read the tree we
    // cannot claim they did. Unverified is not the same as done.
    return { status: "volume-unreadable", synced, failures, drift: NO_DRIFT, error };
  }
  return { status: isInSync(drift) ? "synced" : "incomplete", synced, failures, drift };
}

async function copyOne(
  repoDir: string,
  volumeDir: string,
  relativePath: string,
  writeAttempts: number,
  writeRetryMs: number
): Promise<SyncFailure | undefined> {
  const destination = path.join(volumeDir, relativePath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= writeAttempts; attempt += 1) {
    try {
      // Read inside the loop so a retry cannot write a stale buffer, and copy
      // raw bytes so the volume file is byte-identical to the repo's.
      const bytes = await fs.readFile(path.join(repoDir, relativePath));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
      return undefined;
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      // Only an access error is worth retrying — it is the race with Hermes
      // re-securing the directory. Anything else will fail the same way again.
      if (!code || !ACCESS_CODES.has(code)) break;
      if (attempt < writeAttempts) await sleep(writeRetryMs);
    }
  }
  return {
    relativePath,
    code: errorCode(lastError),
    message: lastError instanceof Error ? lastError.message : String(lastError)
  };
}
