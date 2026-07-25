import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  agentTaskV1Schema,
  type AgentTaskV1,
} from "../../packages/schemas/src/index.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  disposeTaskWorkspace,
  prepareTaskWorkspace,
  WorkspacePrepError,
  type GitCommandResult,
  type WorkspacePrepDeps,
} from "../../services/harness-dispatcher/src/workspace-prep.js";

const FAKE_CREDENTIAL = "ghp_this-must-never-appear";

describe("task workspace preparation", () => {
  it("cleans first, uses fixed Git argv, verifies HEAD, and returns the path", async () => {
    const task = agentTaskFixture();
    const target = workspacePathForTask(task.workItemId, task.taskVersion);
    const order: string[] = [];
    const deps = workspacePrepDeps({
      runGit: vi.fn(async (args) => {
        order.push(`git:${args.join(" ")}`);
        return gitResult(
          args[0] === "rev-parse" ? task.repository.baseRevision : "",
        );
      }),
      rm: vi.fn(async () => {
        order.push("rm");
      }),
      mkdir: vi.fn(async () => {
        order.push("mkdir");
      }),
    });

    await expect(prepareTaskWorkspace(task, deps)).resolves.toBe(target);

    expect(order.slice(0, 3)).toEqual(["rm", "mkdir", "git:init"]);
    expect(deps.runGit).toHaveBeenCalledTimes(5);
    expect(deps.runGit).toHaveBeenNthCalledWith(1, ["init"], target);
    expect(deps.runGit).toHaveBeenNthCalledWith(
      2,
      [
        "remote",
        "add",
        "origin",
        `https://github.com/${task.repository.nameWithOwner}.git`,
      ],
      target,
    );
    expect(deps.runGit).toHaveBeenNthCalledWith(
      3,
      [
        "fetch",
        "--depth",
        "1",
        "origin",
        task.repository.baseRevision,
      ],
      target,
    );
    expect(deps.runGit).toHaveBeenNthCalledWith(
      4,
      ["checkout", "--detach", "FETCH_HEAD"],
      target,
    );
    expect(deps.runGit).toHaveBeenNthCalledWith(
      5,
      ["rev-parse", "HEAD"],
      target,
    );
    for (const [args] of vi.mocked(deps.runGit).mock.calls) {
      expect(Array.isArray(args)).toBe(true);
      expect(args.every((argument) => typeof argument === "string")).toBe(true);
    }

    const remoteArgs = vi.mocked(deps.runGit).mock.calls[1]?.[0];
    const cloneUrl = remoteArgs?.[3];
    expect(cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(cloneUrl).not.toContain("@");
    expect(cloneUrl).not.toContain(FAKE_CREDENTIAL);
    expect(cloneUrl).not.toContain(task.repository.baseRevision);
  });

  it("refuses a checked-out revision other than the exact approved revision", async () => {
    const task = agentTaskFixture();
    const deps = workspacePrepDeps({
      runGit: vi.fn(async (args) =>
        gitResult(args[0] === "rev-parse" ? "f".repeat(40) : "")),
    });

    const error = await capturedWorkspacePrepError(
      prepareTaskWorkspace(task, deps),
    );

    expect(error.reason).toBe("revision_mismatch");
  });

  it("maps a non-zero Git exit without exposing raw stderr credentials", async () => {
    const task = agentTaskFixture();
    const deps = workspacePrepDeps({
      runGit: vi.fn(async (args) =>
        args[0] === "fetch"
          ? gitResult("", 128, `Authorization: Bearer ${FAKE_CREDENTIAL}`)
          : gitResult("")),
    });

    const error = await capturedWorkspacePrepError(
      prepareTaskWorkspace(task, deps),
    );

    expect(error.reason).toBe("clone_failed");
    expect(error.message).not.toContain(FAKE_CREDENTIAL);
    expect(error.message).not.toContain("Authorization");
  });

  it.each([
    "owner-only",
    "owner/repo/extra",
    "owner@host/repo",
  ])("rejects invalid repository name %s before touching the workspace", async (
    nameWithOwner,
  ) => {
    const task = agentTaskFixture();
    const invalidTask = {
      ...task,
      repository: { ...task.repository, nameWithOwner },
    } as AgentTaskV1;
    const deps = workspacePrepDeps();

    const error = await capturedWorkspacePrepError(
      prepareTaskWorkspace(invalidTask, deps),
    );

    expect(error.reason).toBe("invalid_repository");
    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("maps clean-slate failures and never starts Git", async () => {
    const task = agentTaskFixture();
    const deps = workspacePrepDeps({
      rm: vi.fn(async () => {
        throw new Error("filesystem unavailable");
      }),
    });

    const error = await capturedWorkspacePrepError(
      prepareTaskWorkspace(task, deps),
    );

    expect(error.reason).toBe("cleanup_failed");
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("disposes only the same derived workspace path", async () => {
    const task = agentTaskFixture();
    const deps = workspacePrepDeps();

    await disposeTaskWorkspace(task, deps);

    expect(deps.rm).toHaveBeenCalledOnce();
    expect(deps.rm).toHaveBeenCalledWith(
      workspacePathForTask(task.workItemId, task.taskVersion),
    );
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.runGit).not.toHaveBeenCalled();
  });
});

function workspacePrepDeps(
  overrides: Partial<WorkspacePrepDeps> = {},
): WorkspacePrepDeps {
  return {
    runGit: overrides.runGit ?? vi.fn(async (args) =>
      gitResult(args[0] === "rev-parse"
        ? agentTaskFixture().repository.baseRevision
        : "")),
    rm: overrides.rm ?? vi.fn(async () => undefined),
    mkdir: overrides.mkdir ?? vi.fn(async () => undefined),
  };
}

function gitResult(
  stdout = "",
  code = 0,
  stderr = "",
): GitCommandResult {
  return { code, stdout, stderr };
}

async function capturedWorkspacePrepError(
  promise: Promise<unknown>,
): Promise<WorkspacePrepError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspacePrepError);
    return error as WorkspacePrepError;
  }
  throw new Error("Expected workspace preparation to fail");
}

function agentTaskFixture(): AgentTaskV1 {
  return agentTaskV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/agent-integration/agent-task-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
}
