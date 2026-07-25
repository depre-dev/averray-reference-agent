import { spawn } from "node:child_process";
import {
  mkdir as mkdirPath,
  rm as removePath,
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
  | "invalid_repository";

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

  return target;
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
