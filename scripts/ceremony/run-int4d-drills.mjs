import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertKnownMutation,
  assertMutationApplied,
} from "./lib/int4-mutation-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pin = "3355f4906864b0f0e0fe5fd5eb5220172e174206";
const suffix = `${process.pid}-${Date.now()}`;
const reference = `int4d-reference-${suffix}`;
const harness = `int4d-harness-${suffix}`;
const mutation = argument("--mutation");
const filter = argument("--filter");
const validMutations = [
  "non-idempotent-projection",
  "duplicate-worker-effect",
  "board-replay-write",
  "skip-policy-recheck",
  "disable-size-gate",
];
assertKnownMutation("INT4D", mutation, validMutations);
const scratch = mkdtempSync(path.join(tmpdir(), "int4d-runner-"));
const suppliedCheckout = process.env.HARNESS_CHECKOUT?.trim();
const harnessCheckout = suppliedCheckout || path.join(scratch, "agent-harness");
const checkoutLog = path.join(scratch, "harness-checkout.log");
writeFileSync(checkoutLog, "", "utf8");

try {
  prepareHarnessCheckout();
  startDatabase(reference, "reference_int4d");
  startDatabase(harness, "harness_int4d");
  waitForDatabase(reference, "reference_int4d");
  waitForDatabase(harness, "harness_int4d");
  const referencePort = publishedPort(reference);
  const harnessPort = publishedPort(harness);
  console.info(`INT4D_DATABASE_LIVE boundary=reference container=${reference}`);
  console.info(`INT4D_DATABASE_LIVE boundary=harness container=${harness}`);
  console.info(`INT4D_HARNESS_PIN_VERIFIED pin=${pin}`);
  const result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "test/integration/int4d-drill-matrix.test.ts",
      "--reporter=verbose",
      ...(filter ? ["-t", filter] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HARNESS_CHECKOUT: harnessCheckout,
        INT4D_REFERENCE_DATABASE_URL:
          `postgresql://postgres:int4d-local@127.0.0.1:${referencePort}/reference_int4d`,
        INT4D_HARNESS_DATABASE_URL:
          `postgresql://postgres:int4d-local@127.0.0.1:${harnessPort}/harness_int4d`,
        INT4D_PRINT_EVIDENCE: "1",
        ...(mutation ? { INT4D_MUTATION: mutation } : {}),
      },
      encoding: "utf8",
      timeout: 240_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assertMutationApplied("INT4D", mutation, output);
  process.exitCode = result.status ?? 1;
} finally {
  removeDatabase(reference);
  removeDatabase(harness);
  rmSync(scratch, { recursive: true, force: true });
}

function prepareHarnessCheckout() {
  if (!suppliedCheckout) {
    const checkout = spawnSync(
      "bash",
      [
        "-c",
        "source \"$1\"; int2_checkout_harness \"$2\" \"$3\" \"$4\"",
        "int4d-checkout",
        path.join(root, "scripts/ceremony/lib/int2-harness-checkout.sh"),
        harnessCheckout,
        pin,
        checkoutLog,
      ],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    if (checkout.status !== 0) {
      process.stderr.write(checkout.stderr ?? "");
      throw new Error("INT4D_HARNESS_CHECKOUT_FAILED");
    }
  }
  const clean = git(["-C", harnessCheckout, "status", "--porcelain"]);
  if (clean.status !== 0 || clean.stdout.trim()) {
    throw new Error("INT4D_HARNESS_CHECKOUT_DIRTY");
  }
  let head = git(["-C", harnessCheckout, "rev-parse", "HEAD"]);
  if (head.status !== 0) throw new Error("INT4D_HARNESS_HEAD_UNREADABLE");
  if (head.stdout.trim() !== pin) {
    const checkout = git([
      "-C",
      harnessCheckout,
      "checkout",
      "--quiet",
      "--detach",
      pin,
    ]);
    if (checkout.status !== 0) {
      const detail = checkout.stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
      throw new Error(`INT4D_HARNESS_PIN_UNAVAILABLE${detail ? ` detail=${detail}` : ""}`);
    }
    head = git(["-C", harnessCheckout, "rev-parse", "HEAD"]);
  }
  if (head.stdout.trim() !== pin) throw new Error("INT4D_HARNESS_PIN_MISMATCH");
  const sync = spawnSync("uv", ["sync", "--frozen"], {
    cwd: harnessCheckout,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (sync.status !== 0) {
    process.stderr.write(sync.stderr ?? "");
    throw new Error("INT4D_HARNESS_SYNC_FAILED");
  }
}

function startDatabase(name, database) {
  const result = docker([
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_PASSWORD=int4d-local",
    "--env",
    `POSTGRES_DB=${database}`,
    "postgres:16-alpine",
  ]);
  if (result.status !== 0) throw new Error(`INT4D_DATABASE_START_FAILED boundary=${database}`);
}

function waitForDatabase(name, database) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = docker([
      "exec",
      "--env",
      "PGPASSWORD=int4d-local",
      name,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      database,
      "-Atqc",
      "select 1",
    ], true);
    if (result.status === 0 && result.stdout.trim() === "1") return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`INT4D_DATABASE_NEVER_READY boundary=${database}`);
}

function publishedPort(name) {
  const result = docker(["port", name, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout);
  if (result.status !== 0 || !match?.[1]) {
    throw new Error(`INT4D_DATABASE_PORT_MISSING container=${name}`);
  }
  return match[1];
}

function removeDatabase(name) {
  docker(["rm", "--force", name], true);
}

function docker(args, allowFailure = false) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) process.stderr.write(result.stderr ?? "");
  return result;
}

function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
