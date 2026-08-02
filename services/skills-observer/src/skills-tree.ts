import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read and compare the two copies of the Hermes skill tree.
 *
 * `hermes/skills/**` in this repo is the source of truth; `/opt/data/skills`
 * (the `avg-hermes-skills` volume) is what the running agent actually loads.
 * Nothing used to connect them — the volume copy was placed by hand — so
 * merging a SKILL.md change had no effect and the two could diverge with no
 * error and no signal. These helpers are the shared basis for both halves of
 * the fix: `sync.ts` writes repo → volume, and the observer re-runs the same
 * comparison on a timer so a divergence is reported instead of sitting silent.
 *
 * Hashes are over raw bytes, so a copy is "the same" only if it is byte-exact.
 */

/** Relative POSIX path → sha256 of the file's bytes. */
export type SkillTree = Map<string, string>;

export interface SkillDrift {
  /** In the repo, absent from the volume — the agent cannot load it at all. */
  missing: string[];
  /** In both, with different bytes — the agent is loading something else. */
  modified: string[];
}

export function hashBytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Walk `root` and hash every file, keyed by its path relative to `root`.
 *
 * Dot-prefixed entries are skipped at every level: the repo side of this is a
 * bind mount of a working checkout, so `.git`, `.DS_Store` and friends turn up
 * there and are not skills.
 *
 * Throws ENOENT if `root` does not exist — an absent tree is a different
 * condition from an empty one, and callers must not be able to confuse the two.
 */
export async function readSkillTree(root: string): Promise<SkillTree> {
  const tree: SkillTree = new Map();
  await walk(root, "", tree);
  return tree;
}

async function walk(root: string, relativeDir: string, tree: SkillTree): Promise<void> {
  const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relativePath, tree);
    } else if (entry.isFile()) {
      tree.set(relativePath, hashBytes(await fs.readFile(path.join(root, relativePath))));
    }
  }
}

/**
 * Compare the volume against the repo.
 *
 * Deliberately asymmetric: a file present ONLY in the volume is not drift.
 * Hermes authors skills at runtime — that is the whole reason skills-observer
 * exists — and treating those as extras to be reported (or worse, deleted)
 * would fight the agent for ownership of its own directory. The repo owns the
 * paths it ships; everything else in the volume belongs to the agent.
 */
export function diffSkillTrees(repo: SkillTree, volume: SkillTree): SkillDrift {
  const missing: string[] = [];
  const modified: string[] = [];
  for (const [relativePath, sha256] of repo) {
    const found = volume.get(relativePath);
    if (found === undefined) missing.push(relativePath);
    else if (found !== sha256) modified.push(relativePath);
  }
  return { missing: missing.sort(), modified: modified.sort() };
}

export function isInSync(drift: SkillDrift): boolean {
  return drift.missing.length === 0 && drift.modified.length === 0;
}

/**
 * A stable key for "the drift is the same as last time", so the observer can
 * report a change of state rather than re-announcing the same divergence on
 * every tick. An alert that repeats every interval stops being read.
 */
export function driftSignature(drift: SkillDrift): string {
  return `missing:${drift.missing.join(",")}|modified:${drift.modified.join(",")}`;
}

/** One operator-facing line naming the files, not just the counts. */
export function describeDrift(drift: SkillDrift): string {
  if (isInSync(drift)) return "the skills volume matches the repo";
  const parts: string[] = [];
  if (drift.missing.length) parts.push(`missing from the volume: ${drift.missing.join(", ")}`);
  if (drift.modified.length) parts.push(`changed in the volume: ${drift.modified.join(", ")}`);
  return parts.join("; ");
}
