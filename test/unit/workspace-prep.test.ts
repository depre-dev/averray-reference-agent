import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readlink,
  rm as removePath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentTaskV1Schema,
  type AgentTaskV1,
} from "../../packages/schemas/src/index.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  buildTaskIntentArtifact,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";
import {
  disposeTaskWorkspace,
  prepareTaskWorkspace,
  seedWorkspaceDependencies,
  WorkspacePrepError,
  type DependencySeedOutcome,
  type GitCommandResult,
  type WorkspacePrepDeps,
} from "../../services/harness-dispatcher/src/workspace-prep.js";

const FAKE_CREDENTIAL = "ghp_this-must-never-appear";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      removePath(root, { recursive: true, force: true })),
  );
});

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
      seedDependencies: vi.fn(async () => {
        order.push("seed:skipped");
        return "skipped";
      }),
    });

    await expect(prepareTaskWorkspace(task, deps)).resolves.toBe(target);

    expect(order.slice(0, 3)).toEqual(["rm", "mkdir", "git:init"]);
    expect(order.at(-1)).toBe("seed:skipped");
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
    expect(deps.seedDependencies).not.toHaveBeenCalled();
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

  it("seeds only after revision verification and proves Git status is unchanged", async () => {
    const task = agentTaskFixture();
    const order: string[] = [];
    const deps = workspacePrepDeps({
      runGit: vi.fn(async (args) => {
        order.push(`git:${args.join(" ")}`);
        return gitResult(
          args[0] === "rev-parse" ? task.repository.baseRevision : "",
        );
      }),
      seedDependencies: vi.fn(async () => {
        order.push("seed");
        return "seeded";
      }),
    });

    await prepareTaskWorkspace(task, deps);

    expect(order.indexOf("git:rev-parse HEAD")).toBeLessThan(
      order.indexOf("seed"),
    );
    expect(order.at(-1)).toBe("git:status --porcelain --untracked-files=all");
    expect(deps.runGit).toHaveBeenCalledTimes(6);
  });

  it("fails closed when seeded dependencies appear in Git status", async () => {
    const task = agentTaskFixture();
    const deps = workspacePrepDeps({
      runGit: vi.fn(async (args) => {
        if (args[0] === "rev-parse") {
          return gitResult(task.repository.baseRevision);
        }
        if (args[0] === "status") {
          return gitResult("?? node_modules/\n");
        }
        return gitResult();
      }),
      seedDependencies: vi.fn(async () => "seeded"),
    });

    const error = await capturedWorkspacePrepError(
      prepareTaskWorkspace(task, deps),
    );

    expect(error.reason).toBe("dependency_seed_failed");
  });

  it("keeps the TaskIntent template hash identical with or without seeding", async () => {
    const task = agentTaskFixture();
    const skippedPath = await prepareTaskWorkspace(
      task,
      workspacePrepDeps({
        seedDependencies: vi.fn(async () => "skipped"),
      }),
    );
    const seededPath = await prepareTaskWorkspace(
      task,
      workspacePrepDeps({
        seedDependencies: vi.fn(async () => "seeded"),
      }),
    );

    const [skipped, seeded] = await Promise.all([
      buildTaskIntentArtifact(task, { workspacePath: skippedPath }),
      buildTaskIntentArtifact(task, { workspacePath: seededPath }),
    ]);

    expect(seeded.templateHash).toBe(skipped.templateHash);
    expect(seeded.canonicalBytes).toBe(skipped.canonicalBytes);
  });
});

describe("offline workspace dependency seeding", () => {
  it("skips without a configured cache and never copies", async () => {
    const cp = vi.fn(async () => undefined);

    await expect(seedWorkspaceDependencies(
      agentTaskFixture(),
      "/workspace/does-not-need-to-exist",
      { environment: {}, cp },
    )).resolves.toBe("skipped");

    expect(cp).not.toHaveBeenCalled();
  });

  it("skips a prepared workspace without package-lock.json", async () => {
    const { workspace, cacheRoot } = await emptySeedFixture();
    const cp = vi.fn(async () => undefined);

    await expect(seedWorkspaceDependencies(
      agentTaskFixture(),
      workspace,
      {
        environment: { HARNESS_DISPATCH_DEP_CACHE_DIR: cacheRoot },
        cp,
      },
    )).resolves.toBe("skipped");

    expect(cp).not.toHaveBeenCalled();
  });

  it("copies the exact lockfile cache into workspace node_modules", async () => {
    const fixture = await populatedSeedFixture();

    await expect(seedWorkspaceDependencies(
      agentTaskFixture(),
      fixture.workspace,
      {
        environment: {
          HARNESS_DISPATCH_DEP_CACHE_DIR: fixture.cacheRoot,
        },
      },
    )).resolves.toBe("seeded");

    await expect(readFile(
      path.join(fixture.workspace, "node_modules", "example", "index.js"),
      "utf8",
    )).resolves.toBe("export const seeded = true;\n");
  });

  it("preserves an npm workspace package link as a symlink into the prepared workspace", async () => {
    const fixture = await populatedSeedFixture();
    const declaredTarget = "../../packages/mcp-common";
    await Promise.all([
      mkdir(path.join(fixture.workspace, "packages/mcp-common"), {
        recursive: true,
      }),
      mkdir(path.join(fixture.cacheNodeModules, "@avg"), {
        recursive: true,
      }),
    ]);
    await writeFile(
      path.join(fixture.workspace, "packages/mcp-common/package.json"),
      '{"name":"@avg/mcp-common"}\n',
    );
    await symlink(
      declaredTarget,
      path.join(fixture.cacheNodeModules, "@avg/mcp-common"),
    );

    await expect(seedWorkspaceDependencies(
      agentTaskFixture(),
      fixture.workspace,
      {
        environment: {
          HARNESS_DISPATCH_DEP_CACHE_DIR: fixture.cacheRoot,
        },
      },
    )).resolves.toBe("seeded");

    const seededLink = path.join(
      fixture.workspace,
      "node_modules/@avg/mcp-common",
    );
    expect((await lstat(seededLink)).isSymbolicLink()).toBe(true);
    await expect(readlink(seededLink)).resolves.toBe(declaredTarget);
    await expect(readFile(
      path.join(seededLink, "package.json"),
      "utf8",
    )).resolves.toBe('{"name":"@avg/mcp-common"}\n');
  });

  it("refuses a missing exact lockfile cache as stale without copying or networking", async () => {
    const { workspace, cacheRoot } = await emptySeedFixture();
    await writeFile(
      path.join(workspace, "package-lock.json"),
      "{\"lockfileVersion\":3}\n",
    );
    const cp = vi.fn(async () => undefined);

    const error = await capturedWorkspacePrepError(
      seedWorkspaceDependencies(agentTaskFixture(), workspace, {
        environment: { HARNESS_DISPATCH_DEP_CACHE_DIR: cacheRoot },
        cp,
      }),
    );

    const expectedHash = createHash("sha256")
      .update("{\"lockfileVersion\":3}\n")
      .digest("hex");
    expect(error.reason).toBe("dependency_cache_stale");
    expect(error.message).toContain(`sha256:${expectedHash}`);
    expect(cp).not.toHaveBeenCalled();

    const source = readFileSync(
      new URL(
        "../../services/harness-dispatcher/src/workspace-prep.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toContain("npm install");
    expect(source).not.toContain("npm ci");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("reports a configured but unavailable cache root as missing", async () => {
    const { workspace, root } = await emptySeedFixture();
    await writeFile(path.join(workspace, "package-lock.json"), "{}\n");

    const error = await capturedWorkspacePrepError(
      seedWorkspaceDependencies(agentTaskFixture(), workspace, {
        environment: {
          HARNESS_DISPATCH_DEP_CACHE_DIR: path.join(root, "missing-cache"),
        },
      }),
    );

    expect(error.reason).toBe("dependency_cache_missing");
  });

  it("rejects a cached symlink with an absolute target outside both roots", async () => {
    const fixture = await populatedSeedFixture();
    const externalRoot = await mkdtemp(
      path.join(tmpdir(), "harness-dep-absolute-escape-"),
    );
    temporaryRoots.push(externalRoot);
    const external = path.join(externalRoot, "outside.js");
    await writeFile(external, "do not copy\n");
    await symlink(
      external,
      path.join(fixture.cacheNodeModules, "escape.js"),
    );

    const error = await capturedWorkspacePrepError(
      seedWorkspaceDependencies(agentTaskFixture(), fixture.workspace, {
        environment: {
          HARNESS_DISPATCH_DEP_CACHE_DIR: fixture.cacheRoot,
        },
      }),
    );

    expect(error.reason).toBe("dependency_seed_failed");
    await expect(
      stat(path.join(fixture.workspace, "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a cached symlink whose relative target escapes the workspace", async () => {
    const fixture = await populatedSeedFixture();
    const externalRoot = await mkdtemp(
      path.join(tmpdir(), "harness-dep-relative-escape-"),
    );
    temporaryRoots.push(externalRoot);
    const external = path.join(externalRoot, "outside.js");
    await writeFile(external, "do not copy\n");
    const destinationLink = path.join(
      fixture.workspace,
      "node_modules/escape.js",
    );
    const declaredTarget = path.relative(
      path.dirname(destinationLink),
      external,
    );
    expect(declaredTarget).toMatch(/^\.\.[/\\]/u);
    await symlink(
      declaredTarget,
      path.join(fixture.cacheNodeModules, "escape.js"),
    );

    const error = await capturedWorkspacePrepError(
      seedWorkspaceDependencies(agentTaskFixture(), fixture.workspace, {
        environment: {
          HARNESS_DISPATCH_DEP_CACHE_DIR: fixture.cacheRoot,
        },
      }),
    );

    expect(error.reason).toBe("dependency_seed_failed");
    await expect(
      stat(path.join(fixture.workspace, "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
    seedDependencies: overrides.seedDependencies
      ?? vi.fn(async (): Promise<DependencySeedOutcome> => "skipped"),
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  };
}

async function emptySeedFixture(): Promise<{
  root: string;
  workspace: string;
  cacheRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-dep-seed-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const cacheRoot = path.join(root, "cache");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
  ]);
  return { root, workspace, cacheRoot };
}

async function populatedSeedFixture(): Promise<{
  root: string;
  workspace: string;
  cacheRoot: string;
  cacheNodeModules: string;
}> {
  const fixture = await emptySeedFixture();
  const lockfile = "{\"lockfileVersion\":3,\"packages\":{}}\n";
  await writeFile(
    path.join(fixture.workspace, "package-lock.json"),
    lockfile,
  );
  const hash = createHash("sha256").update(lockfile).digest("hex");
  const cacheEntry = path.join(fixture.cacheRoot, hash);
  const cacheNodeModules = path.join(cacheEntry, "node_modules");
  await mkdir(path.join(cacheNodeModules, "example"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(cacheNodeModules, "example", "index.js"),
      "export const seeded = true;\n",
    ),
    writeFile(
      path.join(cacheEntry, "manifest.json"),
      `${JSON.stringify({
        lockfileSha256: hash,
        createdAt: "2026-07-25T12:00:00.000Z",
        sourceRevision: agentTaskFixture().repository.baseRevision,
      })}\n`,
    ),
  ]);
  return { ...fixture, cacheNodeModules };
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
