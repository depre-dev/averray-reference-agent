import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertKnownMutation,
  assertMutationApplied,
} from "./lib/int4-mutation-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const suffix = `${process.pid}-${Date.now()}`;
const reference = `int4c-reference-${suffix}`;
const harness = `int4c-harness-${suffix}`;
const mutation = argument("--mutation");
const filter = argument("--filter");
const validMutations = [
  "disable-renewal",
  "remove-retry-bound",
  "alert-dedup",
];
assertKnownMutation("INT4C", mutation, validMutations);

try {
  startDatabase(reference, "reference_int4c");
  startDatabase(harness, "harness_int4c");
  waitForDatabase(reference, "reference_int4c");
  waitForDatabase(harness, "harness_int4c");
  const referencePort = publishedPort(reference);
  const harnessPort = publishedPort(harness);
  console.info(`INT4C_DATABASE_LIVE boundary=reference container=${reference}`);
  console.info(`INT4C_DATABASE_LIVE boundary=harness container=${harness}`);
  const result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "test/integration/int4c-lease-takeover.test.ts",
      "--reporter=verbose",
      ...(filter ? ["-t", filter] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        INT4C_REFERENCE_DATABASE_URL:
          `postgresql://postgres:int4c-local@127.0.0.1:${referencePort}/reference_int4c`,
        INT4C_HARNESS_DATABASE_URL:
          `postgresql://postgres:int4c-local@127.0.0.1:${harnessPort}/harness_int4c`,
        INT4C_PRINT_EVIDENCE: "1",
        ...(mutation ? { INT4C_MUTATION: mutation } : {}),
      },
      encoding: "utf8",
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assertMutationApplied("INT4C", mutation, output);
  process.exitCode = result.status ?? 1;
} finally {
  removeDatabase(reference);
  removeDatabase(harness);
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
    "POSTGRES_PASSWORD=int4c-local",
    "--env",
    `POSTGRES_DB=${database}`,
    "postgres:16-alpine",
  ]);
  if (result.status !== 0) {
    throw new Error(`INT4C_DATABASE_START_FAILED boundary=${database}`);
  }
}

function waitForDatabase(name, database) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = docker([
      "exec",
      "--env",
      "PGPASSWORD=int4c-local",
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
  throw new Error(`INT4C_DATABASE_NEVER_READY boundary=${database}`);
}

function publishedPort(name) {
  const result = docker(["port", name, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout);
  if (result.status !== 0 || !match?.[1]) {
    throw new Error(`INT4C_DATABASE_PORT_MISSING container=${name}`);
  }
  return match[1];
}

function removeDatabase(name) {
  docker(["rm", "--force", name], true);
}

function docker(args, allowFailure = false) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
  }
  return result;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
