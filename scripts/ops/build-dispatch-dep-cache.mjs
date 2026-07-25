#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const options = parseArguments(process.argv.slice(2));

try {
  const result = await buildDependencyCache(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error
    ? error.message
    : "Dependency cache build failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function buildDependencyCache({ checkout, cacheRoot }) {
  const checkoutRoot = path.resolve(checkout);
  const cacheRootPath = path.resolve(cacheRoot);
  const lockfilePath = path.join(checkoutRoot, "package-lock.json");
  const lockfileBytes = await readFile(lockfilePath);
  const lockfileSha256 = createHash("sha256")
    .update(lockfileBytes)
    .digest("hex");
  const sourceRevision = (
    await runCaptured("git", ["rev-parse", "HEAD"], checkoutRoot)
  ).trim();
  const status = await runCaptured(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    checkoutRoot,
  );
  if (status.trim()) {
    throw new Error("Dependency cache source checkout must be clean");
  }

  await mkdir(cacheRootPath, { recursive: true });
  const target = path.join(cacheRootPath, lockfileSha256);
  const existing = await cacheEntryState(target, lockfileSha256);
  if (existing === "valid") {
    return {
      outcome: "reused",
      lockfileSha256,
      sourceRevision,
      cachePath: target,
    };
  }
  if (existing === "invalid") {
    throw new Error(
      `Existing dependency cache entry is incomplete for sha256:${lockfileSha256}`,
    );
  }

  const buildRoot = await mkdtemp(
    path.join(tmpdir(), "harness-dispatch-deps-"),
  );
  const buildCheckout = path.join(buildRoot, "checkout");
  const staging = path.join(
    cacheRootPath,
    `.staging-${lockfileSha256}-${randomUUID()}`,
  );
  try {
    await cp(checkoutRoot, buildCheckout, {
      recursive: true,
      verbatimSymlinks: true,
      filter(source) {
        const relative = path.relative(checkoutRoot, source);
        if (!relative) return true;
        const firstSegment = relative.split(path.sep)[0];
        return firstSegment !== ".git" && firstSegment !== "node_modules";
      },
    });
    await runInherited("npm", ["ci"], buildCheckout);

    const builtNodeModules = path.join(buildCheckout, "node_modules");
    if (!(await statusOrUndefined(builtNodeModules))?.isDirectory()) {
      throw new Error("npm ci did not produce a node_modules directory");
    }

    await mkdir(staging);
    await cp(builtNodeModules, path.join(staging, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(
      path.join(staging, "manifest.json"),
      `${JSON.stringify({
        lockfileSha256,
        createdAt: new Date().toISOString(),
        sourceRevision,
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      await rename(staging, target);
    } catch {
      if (await cacheEntryState(target, lockfileSha256) !== "valid") {
        throw new Error(
          `Could not publish dependency cache for sha256:${lockfileSha256}`,
        );
      }
    }
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }

  return {
    outcome: "created",
    lockfileSha256,
    sourceRevision,
    cachePath: target,
  };
}

async function cacheEntryState(target, expectedHash) {
  const targetStatus = await statusOrUndefined(target);
  if (!targetStatus) return "missing";
  if (!targetStatus.isDirectory()) return "invalid";
  const modules = await statusOrUndefined(path.join(target, "node_modules"));
  if (!modules?.isDirectory()) return "invalid";
  try {
    const manifest = JSON.parse(
      await readFile(path.join(target, "manifest.json"), "utf8"),
    );
    return manifest?.lockfileSha256 === expectedHash
      && typeof manifest.createdAt === "string"
      && typeof manifest.sourceRevision === "string"
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function statusOrUndefined(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function runCaptured(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => reject(new Error(`${command} could not start`)));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}

function runInherited(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", () => reject(new Error(`${command} could not start`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}

function parseArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      "Usage: build-dispatch-dep-cache.mjs --checkout <path> --cache-root <path>\n",
    );
    process.exit(0);
  }
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--checkout" && name !== "--cache-root")
      || !value
      || value.startsWith("--")
    ) {
      throw new Error(
        "Usage: build-dispatch-dep-cache.mjs --checkout <path> --cache-root <path>",
      );
    }
    values.set(name, value);
  }
  if (
    values.size !== 2
    || !values.get("--checkout")
    || !values.get("--cache-root")
  ) {
    throw new Error(
      "Usage: build-dispatch-dep-cache.mjs --checkout <path> --cache-root <path>",
    );
  }
  return {
    checkout: values.get("--checkout"),
    cacheRoot: values.get("--cache-root"),
  };
}
