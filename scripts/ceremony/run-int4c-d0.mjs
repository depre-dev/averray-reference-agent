import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareVitestExecution } from "./lib/int4-vitest-execution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const container = `int4c-d0-${process.pid}-${Date.now()}`;
const leaseOnly = process.argv.includes("--lease-only");
const vitestExecution = prepareVitestExecution("INT4C_D0");

try {
  const started = docker([
    "run", "--detach", "--name", container,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=int4c-local",
    "--env", "POSTGRES_DB=reference_int4c",
    "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error("INT4C_D0_DATABASE_START_FAILED");
  waitForDatabase();
  const port = publishedPort();
  console.info(`INT4C_D0_MAIN_SHA=${git(["merge-base", "HEAD", "origin/main"]).stdout.trim()}`);
  console.info(`INT4C_D0_PROBE_SHA=${git(["rev-parse", "HEAD"]).stdout.trim()}`);
  console.info(`INT4C_D0_DATABASE_LIVE container=${container}`);
  const args = [
    "vitest", "run", "test/integration/int4c-d0-baseline.test.ts",
    ...vitestExecution.reporterArgs,
    ...(leaseOnly
      ? ["-t", "records dead-holder takeover and the live-holder negative with two processes"]
      : []),
  ];
  const result = spawnSync("npx", args, {
    cwd: root,
    env: {
      ...process.env,
      INT4C_REFERENCE_DATABASE_URL:
        `postgresql://postgres:int4c-local@127.0.0.1:${port}/reference_int4c`,
    },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  vitestExecution.assert(result.status);
  process.exitCode = result.status ?? 1;
} finally {
  docker(["rm", "--force", container], true);
  vitestExecution.cleanup();
}

function waitForDatabase() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = docker([
      "exec", "--env", "PGPASSWORD=int4c-local", container,
      "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "reference_int4c",
      "-Atqc", "select 1",
    ], true);
    if (result.status === 0 && result.stdout.trim() === "1") return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error("INT4C_D0_DATABASE_NEVER_READY");
}

function publishedPort() {
  const result = docker(["port", container, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout);
  if (!match?.[1]) throw new Error("INT4C_D0_DATABASE_PORT_MISSING");
  return match[1];
}

function docker(args, allowFailure = false) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) process.stderr.write(result.stderr ?? "");
  return result;
}

function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}
