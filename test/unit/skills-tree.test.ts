import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeDrift,
  diffSkillTrees,
  driftSignature,
  isInSync,
  readSkillTree,
  type SkillTree
} from "../../services/skills-observer/src/skills-tree.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** Build a throwaway tree from relative path -> content. */
async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-tree-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

function tree(entries: Record<string, string>): SkillTree {
  return new Map(Object.entries(entries));
}

describe("readSkillTree", () => {
  it("keys files by their path relative to the root, preserving the category/name nesting", async () => {
    const root = await makeTree({
      "ops/averray-ops/SKILL.md": "# ops",
      "autonomous-ai-agents/codex/SKILL.md": "# codex"
    });

    const result = await readSkillTree(root);

    // Hermes takes the skill NAME from the parent dir and the CATEGORY from its
    // grandparent, so these exact keys are what the sync has to reproduce.
    expect([...result.keys()].sort()).toEqual([
      "autonomous-ai-agents/codex/SKILL.md",
      "ops/averray-ops/SKILL.md"
    ]);
  });

  it("hashes content, so identical trees compare equal and any edit shows up", async () => {
    const a = await readSkillTree(await makeTree({ "ops/x/SKILL.md": "same" }));
    const b = await readSkillTree(await makeTree({ "ops/x/SKILL.md": "same" }));
    const c = await readSkillTree(await makeTree({ "ops/x/SKILL.md": "same " }));

    expect(a.get("ops/x/SKILL.md")).toBe(b.get("ops/x/SKILL.md"));
    expect(a.get("ops/x/SKILL.md")).not.toBe(c.get("ops/x/SKILL.md"));
  });

  it("carries non-SKILL.md files too, so a skill's supporting files sync with it", async () => {
    const result = await readSkillTree(
      await makeTree({ "ops/x/SKILL.md": "# x", "ops/x/references/table.md": "| a |" })
    );

    expect(result.has("ops/x/references/table.md")).toBe(true);
  });

  it("skips dot-prefixed entries at every level (the repo side is a working checkout)", async () => {
    const result = await readSkillTree(
      await makeTree({
        "ops/x/SKILL.md": "# x",
        ".DS_Store": "junk",
        "ops/.DS_Store": "junk",
        ".git/config": "[core]"
      })
    );

    expect([...result.keys()]).toEqual(["ops/x/SKILL.md"]);
  });

  it("throws ENOENT for an absent root rather than reporting an empty tree", async () => {
    // An unmounted directory must not be able to masquerade as "no skills",
    // which would read as in-sync.
    await expect(readSkillTree(path.join(os.tmpdir(), "skills-tree-does-not-exist"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });
});

describe("diffSkillTrees", () => {
  it("reports a repo file the volume does not have", () => {
    const drift = diffSkillTrees(tree({ "ops/x/SKILL.md": "aaa" }), tree({}));

    expect(drift.missing).toEqual(["ops/x/SKILL.md"]);
    expect(drift.modified).toEqual([]);
    expect(isInSync(drift)).toBe(false);
  });

  it("reports a repo file the volume has with different content", () => {
    const drift = diffSkillTrees(
      tree({ "ops/x/SKILL.md": "aaa" }),
      tree({ "ops/x/SKILL.md": "bbb" })
    );

    expect(drift.modified).toEqual(["ops/x/SKILL.md"]);
    expect(drift.missing).toEqual([]);
  });

  it("does NOT report a volume-only file — Hermes authors its own skills there", () => {
    const drift = diffSkillTrees(
      tree({ "ops/x/SKILL.md": "aaa" }),
      tree({ "ops/x/SKILL.md": "aaa", "learned/self-heal/SKILL.md": "written by the agent" })
    );

    expect(isInSync(drift)).toBe(true);
    expect(drift.missing).toEqual([]);
    expect(drift.modified).toEqual([]);
  });

  it("is in sync when every repo path matches", () => {
    const both = { "ops/x/SKILL.md": "aaa", "ops/y/SKILL.md": "bbb" };
    expect(isInSync(diffSkillTrees(tree(both), tree(both)))).toBe(true);
  });

  it("sorts each list so the signature is stable across walk order", () => {
    const drift = diffSkillTrees(
      tree({ "b/x/SKILL.md": "1", "a/x/SKILL.md": "2" }),
      tree({})
    );
    const reordered = diffSkillTrees(
      tree({ "a/x/SKILL.md": "2", "b/x/SKILL.md": "1" }),
      tree({})
    );

    expect(drift.missing).toEqual(["a/x/SKILL.md", "b/x/SKILL.md"]);
    expect(driftSignature(drift)).toBe(driftSignature(reordered));
  });
});

describe("driftSignature", () => {
  it("distinguishes a missing file from a modified one at the same path", () => {
    const missing = diffSkillTrees(tree({ "ops/x/SKILL.md": "aaa" }), tree({}));
    const modified = diffSkillTrees(
      tree({ "ops/x/SKILL.md": "aaa" }),
      tree({ "ops/x/SKILL.md": "bbb" })
    );

    expect(driftSignature(missing)).not.toBe(driftSignature(modified));
  });

  it("changes when a further file drifts, so a widening problem is re-announced", () => {
    const one = diffSkillTrees(tree({ "a/x/SKILL.md": "1" }), tree({}));
    const two = diffSkillTrees(tree({ "a/x/SKILL.md": "1", "b/x/SKILL.md": "2" }), tree({}));

    expect(driftSignature(one)).not.toBe(driftSignature(two));
  });
});

describe("describeDrift", () => {
  it("names the files rather than only counting them", () => {
    const drift = diffSkillTrees(
      tree({ "ops/x/SKILL.md": "aaa", "ops/y/SKILL.md": "bbb" }),
      tree({ "ops/y/SKILL.md": "changed" })
    );

    expect(describeDrift(drift)).toContain("ops/x/SKILL.md");
    expect(describeDrift(drift)).toContain("ops/y/SKILL.md");
    expect(describeDrift(drift)).toMatch(/missing from the volume/);
    expect(describeDrift(drift)).toMatch(/changed in the volume/);
  });

  it("states a match plainly when there is no drift", () => {
    expect(describeDrift({ missing: [], modified: [] })).toBe("the skills volume matches the repo");
  });
});
