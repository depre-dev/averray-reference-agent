import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { syncSkills } from "../../services/skills-observer/src/skills-sync.js";

const roots: string[] = [];

// chmod-based tests are meaningless as root, which ignores the mode bits.
const asRoot = process.getuid?.() === 0;

/** Undo any chmod 0o500 below so the tree can actually be removed. */
async function restoreModes(dir: string): Promise<void> {
  await fs.chmod(dir, 0o755).catch(() => undefined);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await restoreModes(path.join(dir, entry.name));
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await restoreModes(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeDir(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

function read(root: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

describe("syncSkills", () => {
  it("copies a repo skill into an empty volume, preserving category/name nesting", async () => {
    const repoDir = await makeDir({ "ops/averray-ops/SKILL.md": "# watching averray" });
    const volumeDir = await makeDir();

    const result = await syncSkills({ repoDir, volumeDir });

    expect(result.status).toBe("synced");
    expect(result.synced).toEqual(["ops/averray-ops/SKILL.md"]);
    // Hermes reads the NAME from the parent dir and the CATEGORY from its
    // grandparent, so a flattened copy would be discovered as a different skill.
    expect(await read(volumeDir, "ops/averray-ops/SKILL.md")).toBe("# watching averray");
  });

  it("overwrites a volume copy that has drifted from the repo", async () => {
    const repoDir = await makeDir({ "ops/x/SKILL.md": "current" });
    const volumeDir = await makeDir({ "ops/x/SKILL.md": "edited by hand months ago" });

    const result = await syncSkills({ repoDir, volumeDir });

    expect(result.status).toBe("synced");
    expect(await read(volumeDir, "ops/x/SKILL.md")).toBe("current");
  });

  it("never deletes a skill Hermes authored into the volume itself", async () => {
    const repoDir = await makeDir({ "ops/x/SKILL.md": "from git" });
    const volumeDir = await makeDir({ "learned/self-heal/SKILL.md": "written by the agent" });

    const result = await syncSkills({ repoDir, volumeDir });

    expect(result.status).toBe("synced");
    expect(await read(volumeDir, "learned/self-heal/SKILL.md")).toBe("written by the agent");
  });

  it("writes nothing and reports `current` when the volume already matches", async () => {
    const repoDir = await makeDir({ "ops/x/SKILL.md": "same" });
    const volumeDir = await makeDir({ "ops/x/SKILL.md": "same" });
    const before = (await fs.stat(path.join(volumeDir, "ops/x/SKILL.md"))).mtimeMs;

    const result = await syncSkills({ repoDir, volumeDir });

    expect(result.status).toBe("current");
    expect(result.synced).toEqual([]);
    expect((await fs.stat(path.join(volumeDir, "ops/x/SKILL.md"))).mtimeMs).toBe(before);
  });

  it("copies a skill's supporting files, not just SKILL.md", async () => {
    const repoDir = await makeDir({
      "ops/x/SKILL.md": "# x",
      "ops/x/references/verdicts.md": "| reason | means |"
    });
    const volumeDir = await makeDir();

    await syncSkills({ repoDir, volumeDir });

    expect(await read(volumeDir, "ops/x/references/verdicts.md")).toBe("| reason | means |");
  });

  it("reports repo-unreadable rather than silently syncing nothing when the mount is missing", async () => {
    const volumeDir = await makeDir();

    const result = await syncSkills({
      repoDir: path.join(os.tmpdir(), "skills-sync-no-such-mount"),
      volumeDir
    });

    expect(result.status).toBe("repo-unreadable");
    expect(result.synced).toEqual([]);
  });

  it("treats an empty repo tree as a fault, not as a successful no-op sync", async () => {
    const result = await syncSkills({ repoDir: await makeDir(), volumeDir: await makeDir() });

    expect(result.status).toBe("repo-empty");
  });

  it.skipIf(asRoot)("reports volume-unreadable rather than throwing when it cannot be read", async () => {
    // The documented failure mode: Hermes owns the volume as UID 10000 and
    // secures it to 0700. An unreadable volume has to arrive as a status with a
    // remediation, not as an unhandled rejection.
    const repoDir = await makeDir({ "ops/x/SKILL.md": "from git" });
    const volumeDir = await makeDir({ "ops/x/SKILL.md": "stale" });
    await fs.chmod(volumeDir, 0o000);

    const result = await syncSkills({ repoDir, volumeDir });

    expect(result.status).toBe("volume-unreadable");
    expect(["EACCES", "EPERM"]).toContain(
      (result.error as NodeJS.ErrnoException | undefined)?.code
    );
  });

  it.skipIf(asRoot)("reports incomplete, with the drift, when the volume cannot be written", async () => {
    const repoDir = await makeDir({ "ops/x/SKILL.md": "from git" });
    const volumeDir = await makeDir();
    // Stand in for Hermes having secured the volume against this user.
    await fs.chmod(volumeDir, 0o500);

    const result = await syncSkills({ repoDir, volumeDir, writeAttempts: 2, writeRetryMs: 0 });

    expect(result.status).toBe("incomplete");
    expect(result.drift.missing).toEqual(["ops/x/SKILL.md"]);
    expect(result.failures[0]?.relativePath).toBe("ops/x/SKILL.md");
    expect(["EACCES", "EPERM"]).toContain(result.failures[0]?.code);
  });

  it.skipIf(asRoot)("takes its verdict from the resulting tree, not from the writes", async () => {
    // One destination is writable and one is not, so the run both succeeds and
    // fails. What it reports has to come from re-reading the volume: the file
    // that landed is not drift, and the one that did not is — regardless of how
    // many write calls threw.
    const repoDir = await makeDir({ "ops/x/SKILL.md": "x-current", "ops/y/SKILL.md": "y-current" });
    const volumeDir = await makeDir({ "ops/y/SKILL.md": "y-stale" });
    // The file, not its directory: overwriting an existing entry is governed by
    // the file's own mode, while creating ops/x needs the directory's.
    await fs.chmod(path.join(volumeDir, "ops/y/SKILL.md"), 0o400);

    const result = await syncSkills({ repoDir, volumeDir, writeAttempts: 2, writeRetryMs: 0 });

    expect(result.status).toBe("incomplete");
    expect(result.synced).toEqual(["ops/x/SKILL.md"]);
    expect(result.drift.missing).toEqual([]);
    expect(result.drift.modified).toEqual(["ops/y/SKILL.md"]);
    expect(await read(volumeDir, "ops/x/SKILL.md")).toBe("x-current");
  });
});
