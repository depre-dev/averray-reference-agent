import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISPATCH_WORKSPACE_ROOT,
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";

describe("dispatch workspace paths", () => {
  it("is deterministic, absolute, and contained under the fixed root", () => {
    const first = workspacePathForTask("Issue ABC_123", 4);
    const second = workspacePathForTask("Issue ABC_123", 4);

    expect(first).toBe(second);
    expect(first).toBe(
      `${DISPATCH_WORKSPACE_ROOT}/issue-abc-123-v4`,
    );
    expect(path.isAbsolute(first)).toBe(true);
    expect(first.startsWith(`${DISPATCH_WORKSPACE_ROOT}/`)).toBe(true);
  });

  it("uses a distinct directory for each task version", () => {
    expect(workspacePathForTask("issue-123", 1)).not.toBe(
      workspacePathForTask("issue-123", 2),
    );
  });

  it.each([
    ["../../etc", "etc"],
    ["a/b", "a-b"],
  ])("keeps traversal-shaped id %s inside the root", (workItemId, slug) => {
    const target = workspacePathForTask(workItemId, 1);

    expect(target).toBe(`${DISPATCH_WORKSPACE_ROOT}/${slug}-v1`);
    expect(path.relative(DISPATCH_WORKSPACE_ROOT, target)).not.toMatch(/^\.\./);
  });

  it.each(["", "...", "///"])(
    "rejects work item ids with an empty slug: %j",
    (workItemId) => {
      expect(() => workspacePathForTask(workItemId, 1)).toThrow(
        "non-empty work item slug",
      );
    },
  );
});
