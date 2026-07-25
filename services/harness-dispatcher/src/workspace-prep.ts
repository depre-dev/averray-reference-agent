import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp as copyPath,
  mkdir as mkdirPath,
  readFile as readFilePath,
  realpath as resolveRealPath,
  rename as renamePath,
  rm as removePath,
  stat as statPath,
} from "node:fs/promises";
import path from "node:path";

import type { AgentTaskV1 } from "@avg/schemas";
import {
  DISPATCH_WORKSPACE_ROOT,
  workspacePathForTask,
} from "@avg/averray-mcp/workspace-path";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 256 * 1024;
const REPOSITORY_NAME = /^[^/\s]+\/[^/\s]+$/;
const UNSAFE_REPOSITORY_URL_CHARACTER = /[@\\:?#]/;

export type WorkspacePrepReason =
  | "path_outside_root"
  | "clone_failed"
  | "revision_mismatch"
  | "cleanup_failed"
  | "invalid_repository"
  | "dependency_cache_missing"
  | "dependency_cache_stale"
  | "dependency_seed_failed";

export type DependencySeedOutcome = "skipped" | "seeded";

export class WorkspacePrepError extends Error {
  constructor(
    readonly reason: WorkspacePrepReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePrepError";
  }
}

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorkspacePrepDeps {
  runGit(
    args: readonly string[],
    cwd?: string,
  ): Promise<GitCommandResult>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  seedDependencies(
    task: AgentTaskV1,
    workspacePath: string,
  ): Promise<DependencySeedOutcome>;
  logger?: {
    info(fields: Record<string, unknown>, message: string): void;
  };
}

interface FileStatus {
  isDirectory(): boolean;
  isFile(): boolean;
}

interface DependencyCopyOptions {
  recursive: true;
  dereference: true;
  force: false;
  errorOnExist: true;
  filter(source: string): Promise<boolean>;
}

export interface DependencySeedDeps {
  environment: Readonly<Record<string, string | undefined>>;
  cp(
    source: string,
    destination: string,
    options: DependencyCopyOptions,
  ): Promise<void>;
  stat(target: string): Promise<FileStatus>;
  readFile(target: string): Promise<Buffer>;
  realpath(target: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(target: string): Promise<void>;
}

export async function prepareTaskWorkspace(
  task: AgentTaskV1,
  deps: Partial<WorkspacePrepDeps> = {},
): Promise<string> {
  const resolved = workspacePrepDeps(deps);
  const target = deriveContainedWorkspacePath(task);
  const cloneUrl = publicCloneUrl(task);

  try {
    await resolved.rm(target);
    await resolved.mkdir(target);
  } catch {
    throw new WorkspacePrepError(
      "cleanup_failed",
      "Could not create a clean task workspace",
    );
  }

  await runRequiredGitStep(resolved.runGit, ["init"], target, "init");
  await runRequiredGitStep(
    resolved.runGit,
    ["remote", "add", "origin", cloneUrl],
    target,
    "remote setup",
  );
  await runRequiredGitStep(
    resolved.runGit,
    ["fetch", "--depth", "1", "origin", task.repository.baseRevision],
    target,
    "fetch",
  );
  await runRequiredGitStep(
    resolved.runGit,
    ["checkout", "--detach", "FETCH_HEAD"],
    target,
    "checkout",
  );
  const head = await runRequiredGitStep(
    resolved.runGit,
    ["rev-parse", "HEAD"],
    target,
    "revision verification",
  );
  if (head.stdout.trim() !== task.repository.baseRevision) {
    throw new WorkspacePrepError(
      "revision_mismatch",
      "Prepared workspace revision does not match the approved revision",
    );
  }

  const dependencySeedOutcome = await resolved.seedDependencies(task, target);
  if (dependencySeedOutcome === "seeded") {
    await assertDependencySeedIsIgnored(resolved.runGit, target);
  }
  resolved.logger?.info({
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    dependencySeedOutcome,
  }, "Prepared Harness task workspace dependencies");

  return target;
}

export async function seedWorkspaceDependencies(
  task: AgentTaskV1,
  workspacePath: string,
  deps: Partial<DependencySeedDeps> = {},
): Promise<DependencySeedOutcome> {
  const resolved = dependencySeedDeps(deps);
  const cacheRootInput =
    resolved.environment.HARNESS_DISPATCH_DEP_CACHE_DIR?.trim();
  if (!cacheRootInput) return "skipped";

  const workspaceRoot = await requiredRealPath(
    resolved,
    workspacePath,
    "Prepared workspace could not be resolved for dependency seeding",
  );
  const lockfilePath = path.join(workspaceRoot, "package-lock.json");
  const lockfileStatus = await optionalStatus(resolved, lockfilePath);
  if (!lockfileStatus) return "skipped";
  if (!lockfileStatus.isFile()) {
    throw dependencyError(
      "dependency_seed_failed",
      "Prepared workspace package-lock.json is not a regular file",
    );
  }

  let lockfileBytes: Buffer;
  try {
    lockfileBytes = await resolved.readFile(lockfilePath);
  } catch {
    throw dependencyError(
      "dependency_seed_failed",
      "Prepared workspace package-lock.json could not be read",
    );
  }
  const lockfileSha256 = createHash("sha256")
    .update(lockfileBytes)
    .digest("hex");
  const expectedHash = `sha256:${lockfileSha256}`;
  const cacheRoot = path.resolve(cacheRootInput);
  const cacheRootStatus = await optionalStatus(resolved, cacheRoot);
  if (!cacheRootStatus || !cacheRootStatus.isDirectory()) {
    throw dependencyError(
      "dependency_cache_missing",
      `Dependency cache root is unavailable; expected ${expectedHash}`,
    );
  }

  const cacheEntry = path.join(cacheRoot, lockfileSha256);
  assertContainedPath(cacheRoot, cacheEntry, "dependency_seed_failed");
  const cacheEntryStatus = await optionalStatus(resolved, cacheEntry);
  if (!cacheEntryStatus || !cacheEntryStatus.isDirectory()) {
    throw dependencyError(
      "dependency_cache_stale",
      `No exact dependency cache exists for expected ${expectedHash}`,
    );
  }

  const manifestPath = path.join(cacheEntry, "manifest.json");
  const cachedNodeModules = path.join(cacheEntry, "node_modules");
  const [manifestStatus, nodeModulesStatus] = await Promise.all([
    optionalStatus(resolved, manifestPath),
    optionalStatus(resolved, cachedNodeModules),
  ]);
  if (!manifestStatus?.isFile() || !nodeModulesStatus?.isDirectory()) {
    throw dependencyError(
      "dependency_cache_missing",
      `Dependency cache entry is incomplete for expected ${expectedHash}`,
    );
  }
  await verifyDependencyCacheManifest(
    resolved,
    manifestPath,
    lockfileSha256,
  );

  const cacheRootReal = await requiredRealPath(
    resolved,
    cacheRoot,
    "Dependency cache root could not be resolved",
  );
  const cachedNodeModulesReal = await requiredRealPath(
    resolved,
    cachedNodeModules,
    "Cached node_modules could not be resolved",
  );
  assertContainedOrEqual(
    cacheRootReal,
    cachedNodeModulesReal,
    "dependency_seed_failed",
  );

  const target = path.join(workspaceRoot, "node_modules");
  assertContainedPath(workspaceRoot, target, "dependency_seed_failed");
  if (await optionalStatus(resolved, target)) {
    throw dependencyError(
      "dependency_seed_failed",
      "Prepared workspace already contains node_modules",
    );
  }

  const staging = path.join(
    workspaceRoot,
    `.node_modules.seed-${randomUUID()}`,
  );
  assertContainedPath(workspaceRoot, staging, "dependency_seed_failed");
  try {
    await resolved.cp(cachedNodeModulesReal, staging, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: async (source) => {
        const sourceReal = await resolved.realpath(source);
        assertContainedOrEqual(
          cachedNodeModulesReal,
          sourceReal,
          "dependency_seed_failed",
        );
        return true;
      },
    });
    await resolved.rename(staging, target);
  } catch (error) {
    try {
      await resolved.rm(staging);
    } catch {
      // The refusal reason remains deterministic even if staging cleanup fails.
    }
    if (error instanceof WorkspacePrepError) throw error;
    throw dependencyError(
      "dependency_seed_failed",
      "Cached dependencies could not be copied into the prepared workspace",
    );
  }

  return "seeded";
}

export async function disposeTaskWorkspace(
  task: AgentTaskV1,
  deps: Partial<WorkspacePrepDeps> = {},
): Promise<void> {
  const resolved = workspacePrepDeps(deps);
  const target = deriveContainedWorkspacePath(task);
  try {
    await resolved.rm(target);
  } catch {
    throw new WorkspacePrepError(
      "cleanup_failed",
      "Could not remove the task workspace",
    );
  }
}

function workspacePrepDeps(
  deps: Partial<WorkspacePrepDeps>,
): WorkspacePrepDeps {
  return {
    runGit: deps.runGit ?? runGit,
    rm: deps.rm ?? (async (target) => {
      await removePath(target, { recursive: true, force: true });
    }),
    mkdir: deps.mkdir ?? (async (target) => {
      await mkdirPath(target, { recursive: true });
    }),
    seedDependencies: deps.seedDependencies ?? seedWorkspaceDependencies,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
}

function dependencySeedDeps(
  deps: Partial<DependencySeedDeps>,
): DependencySeedDeps {
  return {
    environment: deps.environment ?? process.env,
    cp: deps.cp ?? (async (source, destination, options) => {
      await copyPath(source, destination, options);
    }),
    stat: deps.stat ?? statPath,
    readFile: deps.readFile ?? readFilePath,
    realpath: deps.realpath ?? resolveRealPath,
    rename: deps.rename ?? renamePath,
    rm: deps.rm ?? (async (target) => {
      await removePath(target, { recursive: true, force: true });
    }),
  };
}

function deriveContainedWorkspacePath(task: AgentTaskV1): string {
  let target: string;
  try {
    target = workspacePathForTask(task.workItemId, task.taskVersion);
  } catch {
    throw new WorkspacePrepError(
      "path_outside_root",
      "Task workspace path could not be contained under the dispatch root",
    );
  }
  assertContained(target);
  return target;
}

function assertContained(target: string): void {
  const relative = path.relative(DISPATCH_WORKSPACE_ROOT, target);
  if (
    !relative
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) {
    throw new WorkspacePrepError(
      "path_outside_root",
      "Task workspace path must remain under the dispatch root",
    );
  }
}

function assertContainedPath(
  root: string,
  target: string,
  reason: WorkspacePrepReason,
): void {
  const relative = path.relative(root, target);
  if (
    !relative
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) {
    throw dependencyError(
      reason,
      "Dependency seed path escaped its required root",
    );
  }
}

function assertContainedOrEqual(
  root: string,
  target: string,
  reason: WorkspacePrepReason,
): void {
  if (root === target) return;
  assertContainedPath(root, target, reason);
}

function publicCloneUrl(task: AgentTaskV1): string {
  const { provider, nameWithOwner } = task.repository;
  if (
    provider !== "github"
    || !REPOSITORY_NAME.test(nameWithOwner)
    || UNSAFE_REPOSITORY_URL_CHARACTER.test(nameWithOwner)
  ) {
    throw new WorkspacePrepError(
      "invalid_repository",
      "Task repository must be a public GitHub owner/name pair",
    );
  }
  return `https://github.com/${nameWithOwner}.git`;
}

async function runRequiredGitStep(
  execute: WorkspacePrepDeps["runGit"],
  args: readonly string[],
  cwd: string,
  label: string,
): Promise<GitCommandResult> {
  let result: GitCommandResult;
  try {
    result = await execute(args, cwd);
  } catch {
    throw new WorkspacePrepError(
      "clone_failed",
      `Git ${label} could not be completed`,
    );
  }
  if (result.code !== 0) {
    // Deliberately omit raw stderr: Git output can contain credential material
    // supplied by the host even though this adapter never supplies credentials.
    throw new WorkspacePrepError(
      "clone_failed",
      `Git ${label} failed with exit ${result.code}`,
    );
  }
  return result;
}

async function assertDependencySeedIsIgnored(
  execute: WorkspacePrepDeps["runGit"],
  cwd: string,
): Promise<void> {
  let result: GitCommandResult;
  try {
    result = await execute(
      ["status", "--porcelain", "--untracked-files=all"],
      cwd,
    );
  } catch {
    throw dependencyError(
      "dependency_seed_failed",
      "Git status could not verify the seeded dependency directory",
    );
  }
  if (result.code !== 0 || result.stdout.trim()) {
    throw dependencyError(
      "dependency_seed_failed",
      "Seeded dependencies changed the prepared workspace Git status",
    );
  }
}

async function verifyDependencyCacheManifest(
  deps: DependencySeedDeps,
  manifestPath: string,
  expectedLockfileSha256: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse((await deps.readFile(manifestPath)).toString("utf8"));
  } catch {
    throw dependencyError(
      "dependency_cache_stale",
      `Dependency cache manifest is invalid for expected sha256:${expectedLockfileSha256}`,
    );
  }
  if (
    !isRecord(value)
    || value.lockfileSha256 !== expectedLockfileSha256
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.sourceRevision !== "string"
    || value.sourceRevision.trim().length === 0
  ) {
    throw dependencyError(
      "dependency_cache_stale",
      `Dependency cache manifest does not match expected sha256:${expectedLockfileSha256}`,
    );
  }
}

async function optionalStatus(
  deps: DependencySeedDeps,
  target: string,
): Promise<FileStatus | undefined> {
  try {
    return await deps.stat(target);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw dependencyError(
      "dependency_seed_failed",
      "Dependency seed path could not be inspected",
    );
  }
}

async function requiredRealPath(
  deps: DependencySeedDeps,
  target: string,
  message: string,
): Promise<string> {
  try {
    return await deps.realpath(target);
  } catch {
    throw dependencyError("dependency_seed_failed", message);
  }
}

function dependencyError(
  reason: WorkspacePrepReason,
  message: string,
): WorkspacePrepError {
  return new WorkspacePrepError(reason, message);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const runGit: WorkspacePrepDeps["runGit"] = (
  args,
  cwd,
) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > DEFAULT_GIT_MAX_OUTPUT_BYTES) {
        fail("Git output exceeded the configured limit");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", () => fail("Git could not be started"));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    timer = setTimeout(() => {
      fail("Git command timed out");
    }, DEFAULT_GIT_TIMEOUT_MS);
    timer.unref();
  });
