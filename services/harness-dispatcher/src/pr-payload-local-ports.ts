import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { artifactRefSchema, type ArtifactRef } from "@avg/schemas";

import {
  PrPayloadActuationError,
  type PrPayloadArtifactPort,
  type PrPayloadRepositoryPort,
} from "./pr-payload-actuator.js";

const FULL_GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const REPOSITORY_NAME = /^[^/\s]+\/[^/\s]+$/;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createFilePrPayloadArtifactPort(
  rootInput: string,
): PrPayloadArtifactPort {
  const root = path.resolve(rootInput);
  return {
    async read(refInput): Promise<Uint8Array> {
      const ref = artifactRefSchema.parse(refInput);
      const digest = digestFromRef(ref);
      return readFile(path.join(root, digest));
    },
    async write(bytes, mediaType): Promise<ArtifactRef> {
      const buffer = Buffer.from(bytes);
      const digest = createHash("sha256").update(buffer).digest("hex");
      const target = path.join(root, digest);
      await mkdir(root, { recursive: true });
      try {
        await writeFile(target, buffer, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(target);
        if (!existing.equals(buffer)) {
          throw new PrPayloadActuationError(
            "payload_artifact_mismatch",
            "Existing content-addressed artifact has different bytes",
          );
        }
      }
      return artifactRefSchema.parse({
        uri: `artifact://sha256/${digest}`,
        sha256: `sha256:${digest}`,
        mediaType,
        sizeBytes: buffer.byteLength,
      });
    },
  };
}

export interface LocalGitPrPayloadRepositoryConfig {
  repositoryRoot: string;
  repository: string;
  baseRef: string;
}

/**
 * A local-only repository port. Every Git invocation uses a fixed argument
 * vector with shell=false; there is no fetch, push, remote URL, or credential.
 */
export function createLocalGitPrPayloadRepositoryPort(
  config: LocalGitPrPayloadRepositoryConfig,
): PrPayloadRepositoryPort {
  if (!REPOSITORY_NAME.test(config.repository)) {
    throw new PrPayloadActuationError(
      "repository_mismatch",
      "Pinned repository must be an owner/name pair",
    );
  }
  if (!isSafeGitRef(config.baseRef)) {
    throw new PrPayloadActuationError(
      "repository_mismatch",
      "Pinned base ref is not a safe Git ref",
    );
  }
  const configuredRoot = path.resolve(config.repositoryRoot);

  return {
    async readCurrentBase(repository) {
      assertPinnedRepository(config.repository, repository);
      const repositoryRoot = await resolvedRepositoryRoot(configuredRoot);
      const result = await runGit(
        ["rev-parse", "--verify", `refs/heads/${config.baseRef}^{commit}`],
        repositoryRoot,
      );
      if (result.code !== 0 || !FULL_GIT_OBJECT_ID.test(result.stdout.trim())) {
        throw new PrPayloadActuationError(
          "repository_unavailable",
          `Pinned base ref is unavailable for ${repository}`,
        );
      }
      return {
        ref: config.baseRef,
        revision: result.stdout.trim(),
      };
    },

    async applyPatch(input) {
      assertPinnedRepository(config.repository, input.repository);
      if (!FULL_GIT_OBJECT_ID.test(input.baseRevision)) {
        throw new PrPayloadActuationError(
          "base_revision_invalid",
          "Patch base is not a full Git object id",
        );
      }
      const repositoryRoot = await resolvedRepositoryRoot(configuredRoot);
      const stagingRoot = await mkdtemp(path.join(tmpdir(), "int3a-payload-"));
      const stagingRepository = path.join(stagingRoot, "repository");
      try {
        await requiredGit(
          [
            "clone",
            "--local",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            repositoryRoot,
            stagingRepository,
          ],
          stagingRoot,
          undefined,
          "local clone",
        );
        await requiredGit(
          ["checkout", "--detach", input.baseRevision],
          stagingRepository,
          undefined,
          "base checkout",
        );
        await requiredGit(
          ["apply", "--index", "--binary", "--whitespace=nowarn", "-"],
          stagingRepository,
          input.patch,
          "patch apply",
        );
        const paths = await requiredGit(
          ["diff", "--cached", "--name-only", "-z", "--no-renames"],
          stagingRepository,
          undefined,
          "touched-path inspection",
        );
        const tree = await requiredGit(
          ["write-tree"],
          stagingRepository,
          undefined,
          "tree materialization",
        );
        const treeSha = tree.stdout.trim();
        if (!FULL_GIT_OBJECT_ID.test(treeSha)) {
          throw new PrPayloadActuationError(
            "patch_apply_failed",
            "Git did not produce a full tree object id",
          );
        }
        return {
          treeSha,
          touchedPaths: paths.stdout.split("\0").filter(Boolean),
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    },
  };
}

interface GitResult {
  code: number;
  stdout: string;
}

async function requiredGit(
  args: readonly string[],
  cwd: string,
  input: Uint8Array | undefined,
  label: string,
): Promise<GitResult> {
  const result = await runGit(args, cwd, input);
  if (result.code !== 0) {
    throw new PrPayloadActuationError(
      "patch_apply_failed",
      `Git ${label} failed with exit ${result.code}`,
    );
  }
  return result;
}

function runGit(
  args: readonly string[],
  cwd: string,
  input?: Uint8Array,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || (input && !stdinStream)) {
      child.kill("SIGKILL");
      reject(new PrPayloadActuationError(
        "repository_unavailable",
        "Local Git command streams were unavailable",
      ));
      return;
    }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new PrPayloadActuationError(
        "repository_unavailable",
        `Local Git command timed out after ${GIT_TIMEOUT_MS}ms`,
      ));
    }, GIT_TIMEOUT_MS);

    const capture = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > GIT_MAX_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new PrPayloadActuationError(
            "repository_unavailable",
            "Local Git command exceeded its output limit",
          ));
        }
        return;
      }
      stdout.push(chunk);
    };
    stdoutStream.on("data", capture);
    // Drain stderr without recording it. Even a local Git configuration can
    // contain sensitive values, and refusal evidence must never echo them.
    stderrStream.on("data", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    if (input) stdinStream?.end(Buffer.from(input));
  });
}

async function resolvedRepositoryRoot(configuredRoot: string): Promise<string> {
  try {
    return await realpath(configuredRoot);
  } catch {
    throw new PrPayloadActuationError(
      "repository_unavailable",
      "Pinned local repository root is unavailable",
    );
  }
}

function assertPinnedRepository(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new PrPayloadActuationError(
      "repository_mismatch",
      `Actuation is pinned to ${expected}; refused ${actual}`,
    );
  }
}

function isSafeGitRef(value: string): boolean {
  const components = value.split("/");
  return value.length > 0
    && value.length <= 240
    && value !== "@"
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !components.some(
      (component) => component.startsWith(".") || component.endsWith(".lock"),
    )
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20
        || code === 0x7f
        || "~^:?*[\\".includes(character);
    });
}

function digestFromRef(ref: ArtifactRef): string {
  const digest = ref.sha256.slice("sha256:".length);
  if (ref.uri !== `artifact://sha256/${digest}`) {
    throw new PrPayloadActuationError(
      "artifact_hash_mismatch",
      "Artifact URI does not match its declared content hash",
    );
  }
  return digest;
}
