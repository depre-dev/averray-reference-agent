import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PrPayloadSendError,
  PullRequestCreateConflictError,
  type GitHubWriteAuthorization,
  type PrPayloadGitHubClient,
  type RemotePullRequest,
} from "./pr-payload-sender.js";
import type { PrPayloadActuationResult } from "./pr-payload-actuator.js";

const FULL_GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_BASE_URL = "https://api.github.com";
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubPrClientConfig {
  repository: string;
  /** GitHub App installation access token. Never pass it as a CLI argument. */
  installationToken: string;
  /**
   * Token-issuance response metadata after the token field was removed. GitHub
   * installation tokens can list their live repositories but cannot call the
   * app-JWT installation-detail endpoint; this binds that live list to the
   * actual permissions returned when this short-lived token was issued.
   */
  issuedAuthorization: {
    identity: string;
    repositorySelection: "selected" | "all";
    permissions: {
      contents: "read" | "write" | "none";
      pullRequests: "read" | "write" | "none";
      extraWriteScopes: string[];
    };
  };
  fetchImpl?: FetchImplementation;
}

/**
 * Operator-side GitHub App client. The installation token stays in this
 * process, is passed to GitHub only via HTTP headers or Git's askpass channel,
 * and is never included in command arguments, return values, or errors.
 */
export function createGitHubPrClient(
  config: GitHubPrClientConfig,
): PrPayloadGitHubClient {
  const repositoryParts = config.repository.split("/");
  if (
    !REPOSITORY_NAME.test(config.repository)
    || repositoryParts.some((part) => part === "." || part === "..")
  ) {
    throw new PrPayloadSendError(
      "credential_scope_invalid",
      "GitHub client repository must be a pinned owner/name pair",
      true,
    );
  }
  if (!config.installationToken) {
    throw new PrPayloadSendError(
      "credential_scope_unavailable",
      "GitHub App installation authorization is unavailable",
      true,
    );
  }
  const repository = config.repository;
  const issuedAuthorization = structuredClone(config.issuedAuthorization);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const [owner] = repository.split("/");
  if (!owner) {
    throw new PrPayloadSendError(
      "credential_scope_invalid",
      "GitHub client repository owner is unavailable",
      true,
    );
  }

  const request = async (
    method: "GET" | "POST",
    requestPath: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<unknown | undefined> => {
    const response = await fetchImpl(`${GITHUB_API_BASE_URL}${requestPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.installationToken}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (
      method === "POST"
      && requestPath === repositoryApiPath(repository, "/pulls")
      && response.status === 422
    ) {
      throw new PullRequestCreateConflictError();
    }
    if (!response.ok) {
      throw new Error(`GitHub ${method} request failed with HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  };

  const readCommitTree = async (commitSha: string): Promise<string> => {
    assertFullObjectId(commitSha, "GitHub commit");
    const commit = asRecord(await request(
      "GET",
      repositoryApiPath(repository, `/git/commits/${commitSha}`),
    ));
    const tree = asRecord(commit.tree);
    return requiredObjectId(tree.sha, "GitHub commit tree");
  };

  const readHead = async (
    headRef: string,
  ): Promise<{ revision: string; treeSha: string } | undefined> => {
    const found = await request(
      "GET",
      repositoryApiPath(repository, `/git/ref/heads/${encodeURIComponent(headRef)}`),
      undefined,
      true,
    );
    if (found === undefined) return undefined;
    const object = asRecord(asRecord(found).object);
    const revision = requiredObjectId(object.sha, "GitHub head commit");
    return { revision, treeSha: await readCommitTree(revision) };
  };

  return {
    async readWriteAuthorization(): Promise<GitHubWriteAuthorization> {
      const repositoriesResponse = asRecord(await request(
        "GET",
        "/installation/repositories?per_page=100",
      ));
      const repositories = Array.isArray(repositoriesResponse.repositories)
        ? repositoriesResponse.repositories
        : [];
      const totalCount = Number.isSafeInteger(repositoriesResponse.total_count)
        ? Number(repositoriesResponse.total_count)
        : repositories.length;
      const writeRepositories = repositories.map((candidate) => {
        const item = asRecord(candidate);
        return requiredString(item.full_name, "GitHub installation repository");
      });
      if (totalCount !== writeRepositories.length) {
        // The sender accepts exactly one live repository. A truncated or
        // internally inconsistent list must therefore fail the length check.
        writeRepositories.push("invalid/scope-list-incomplete");
      }
      return {
        identity: issuedAuthorization.identity,
        repositorySelection: issuedAuthorization.repositorySelection,
        writeRepositories,
        permissions: structuredClone(issuedAuthorization.permissions),
      };
    },

    async readCurrentBase(requestedRepository, baseRef) {
      assertPinnedRepository(repository, requestedRepository);
      const found = asRecord(await request(
        "GET",
        repositoryApiPath(repository, `/git/ref/heads/${encodeURIComponent(baseRef)}`),
      ));
      const object = asRecord(found.object);
      return {
        ref: baseRef,
        revision: requiredObjectId(object.sha, "GitHub base commit"),
      };
    },

    async listPullRequestsByHead(requestedRepository, headRef) {
      assertPinnedRepository(repository, requestedRepository);
      const query = new URLSearchParams({
        state: "all",
        head: `${owner}:${headRef}`,
        per_page: "100",
      });
      const response = await request(
        "GET",
        `${repositoryApiPath(repository, "/pulls")}?${query.toString()}`,
      );
      if (!Array.isArray(response)) {
        throw new Error("GitHub pull-request list was not an array");
      }
      return Promise.all(response.map(async (candidate) => {
        const pullRequest = parsePullRequest(repository, candidate);
        return {
          ...pullRequest,
          head: {
            ...pullRequest.head,
            treeSha: await readCommitTree(pullRequest.head.revision),
          },
        };
      }));
    },

    async materializeHead(actuation) {
      assertPinnedRepository(repository, actuation.payload.repository);
      await materializeVerifiedHead(
        actuation,
        config.installationToken,
        readHead,
      );
    },

    async openPullRequest(actuation) {
      assertPinnedRepository(repository, actuation.payload.repository);
      const created = await request(
        "POST",
        repositoryApiPath(repository, "/pulls"),
        {
          title: actuation.payload.title,
          body: actuation.payload.body,
          base: actuation.payload.base.ref,
          head: actuation.payload.head.ref,
        },
      );
      const pullRequest = parsePullRequest(repository, created);
      return {
        ...pullRequest,
        head: {
          ...pullRequest.head,
          treeSha: await readCommitTree(pullRequest.head.revision),
        },
      };
    },
  };
}

async function materializeVerifiedHead(
  actuation: PrPayloadActuationResult,
  installationToken: string,
  readHead: (
    headRef: string,
  ) => Promise<{ revision: string; treeSha: string } | undefined>,
): Promise<void> {
  const payload = actuation.payload;
  if (
    !payload.head.ref.startsWith("harness/")
    || payload.head.ref === payload.base.ref
  ) {
    throw new PrPayloadSendError(
      "head_conflict",
      "Verified head is not an isolated deterministic Harness branch",
      true,
    );
  }
  const existing = await readHead(payload.head.ref);
  if (existing) {
    if (existing.treeSha !== payload.head.treeSha) {
      throw new PrPayloadSendError(
        "head_conflict",
        `Derived head ${payload.head.ref} has a different tree`,
        true,
      );
    }
    return;
  }

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "int3b-sender-"));
  const repositoryRoot = path.join(stagingRoot, "repository");
  const askpassPath = path.join(stagingRoot, "git-askpass.sh");
  try {
    await writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  *Username*) printf '%s\\n' 'x-access-token' ;;",
        "  *Password*) printf '%s\\n' \"$INT3B_GITHUB_TOKEN\" ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(askpassPath, 0o700);
    const gitEnvironment = {
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      INT3B_GITHUB_TOKEN: installationToken,
    };
    await requiredGit(
      [
        "clone",
        "--no-checkout",
        "--no-tags",
        "--filter=blob:none",
        "--",
        `https://github.com/${payload.repository}.git`,
        repositoryRoot,
      ],
      stagingRoot,
      gitEnvironment,
      undefined,
      "clone",
    );
    await requiredGit(
      ["checkout", "--detach", payload.base.revision],
      repositoryRoot,
      gitEnvironment,
      undefined,
      "base checkout",
    );
    await requiredGit(
      ["apply", "--index", "--binary", "--whitespace=nowarn", "-"],
      repositoryRoot,
      gitEnvironment,
      Buffer.from(payload.patch.bytes, "utf8"),
      "verified patch apply",
    );
    const tree = await requiredGit(
      ["write-tree"],
      repositoryRoot,
      gitEnvironment,
      undefined,
      "tree materialization",
    );
    const treeSha = tree.stdout.trim();
    if (treeSha !== payload.head.treeSha) {
      throw new PrPayloadSendError(
        "pull_request_identity_mismatch",
        "Sender materialized a tree different from the verified payload",
        true,
      );
    }
    const commit = await requiredGit(
      ["commit-tree", treeSha, "-p", payload.base.revision],
      repositoryRoot,
      {
        ...gitEnvironment,
        GIT_AUTHOR_NAME: "Supervised Harness",
        GIT_AUTHOR_EMAIL: "harness@users.noreply.github.com",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "Supervised Harness",
        GIT_COMMITTER_EMAIL: "harness@users.noreply.github.com",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
      Buffer.from(`Verified payload ${actuation.artifact.sha256}\n`, "utf8"),
      "commit materialization",
    );
    const commitSha = commit.stdout.trim();
    assertFullObjectId(commitSha, "materialized head commit");
    const pushed = await runGit(
      [
        "push",
        "origin",
        `${commitSha}:refs/heads/${payload.head.ref}`,
      ],
      repositoryRoot,
      gitEnvironment,
    );
    if (pushed.code !== 0) {
      const raced = await readHead(payload.head.ref);
      if (!raced || raced.treeSha !== payload.head.treeSha) {
        throw new PrPayloadSendError(
          "pull_request_create_failed",
          "Derived head could not be created without force-pushing",
          true,
        );
      }
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

interface GitResult {
  code: number;
  stdout: string;
}

interface GitEnvironment {
  GIT_ASKPASS: string;
  GIT_ASKPASS_REQUIRE: string;
  GIT_CONFIG_GLOBAL: string;
  GIT_CONFIG_NOSYSTEM: string;
  GIT_TERMINAL_PROMPT: string;
  INT3B_GITHUB_TOKEN: string;
  GIT_AUTHOR_NAME?: string;
  GIT_AUTHOR_EMAIL?: string;
  GIT_AUTHOR_DATE?: string;
  GIT_COMMITTER_NAME?: string;
  GIT_COMMITTER_EMAIL?: string;
  GIT_COMMITTER_DATE?: string;
}

async function requiredGit(
  args: readonly string[],
  cwd: string,
  environment: GitEnvironment,
  input: Uint8Array | undefined,
  label: string,
): Promise<GitResult> {
  const result = await runGit(args, cwd, environment, input);
  if (result.code !== 0) {
    throw new PrPayloadSendError(
      "pull_request_create_failed",
      `Git ${label} failed with exit ${result.code}`,
      true,
    );
  }
  return result;
}

function runGit(
  args: readonly string[],
  cwd: string,
  environment: GitEnvironment,
  input?: Uint8Array,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        ...environment,
      },
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || (input && !stdinStream)) {
      child.kill("SIGKILL");
      reject(new Error("Git command streams were unavailable"));
      return;
    }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Git command timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    stdoutStream.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error("Git command exceeded its output limit"));
        }
        return;
      }
      stdout.push(chunk);
    });
    // Git stderr can contain remote details. Drain it without recording it.
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

function parsePullRequest(
  repository: string,
  input: unknown,
): RemotePullRequest {
  const candidate = asRecord(input);
  const base = asRecord(candidate.base);
  const head = asRecord(candidate.head);
  const state = candidate.state === "closed" ? "closed" : "open";
  return {
    repository,
    number: requiredPositiveInteger(candidate.number, "GitHub pull request number"),
    state,
    title: requiredString(candidate.title, "GitHub pull request title"),
    body: typeof candidate.body === "string" ? candidate.body : "",
    base: {
      ref: requiredString(base.ref, "GitHub pull request base ref"),
      revision: requiredObjectId(base.sha, "GitHub pull request base commit"),
    },
    head: {
      ref: requiredString(head.ref, "GitHub pull request head ref"),
      revision: requiredObjectId(head.sha, "GitHub pull request head commit"),
      treeSha: "",
    },
  };
}

function repositoryApiPath(repository: string, suffix: string): string {
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("Pinned GitHub repository is invalid");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

function assertPinnedRepository(expected: string, actual: string): void {
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new PrPayloadSendError(
      "credential_scope_invalid",
      `GitHub client is pinned to ${expected}; refused ${actual}`,
      true,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub response did not match the expected object shape");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is unavailable`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} is unavailable`);
  }
  return Number(value);
}

function requiredObjectId(value: unknown, label: string): string {
  const candidate = requiredString(value, label);
  assertFullObjectId(candidate, label);
  return candidate;
}

function assertFullObjectId(value: string, label: string): void {
  if (!FULL_GIT_OBJECT_ID.test(value)) {
    throw new Error(`${label} is not a full Git object id`);
  }
}
