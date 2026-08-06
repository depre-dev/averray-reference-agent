import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const suffix = `${process.pid}-${Date.now()}`;
const reference = `int4b-reference-${suffix}`;
const harness = `int4b-harness-${suffix}`;
const mutation = argument("--mutation");

try {
  startDatabase(reference, "reference_int4b");
  startDatabase(harness, "harness_int4b");
  waitForDatabase(reference, "reference_int4b");
  waitForDatabase(harness, "harness_int4b");
  const referencePort = publishedPort(reference);
  const harnessPort = publishedPort(harness);
  console.info(`INT4B_DATABASE_LIVE boundary=reference container=${reference}`);
  console.info(`INT4B_DATABASE_LIVE boundary=harness container=${harness}`);
  const result = spawnSync(
    "npx",
    ["vitest", "run", "test/integration/int4b-quarantine.test.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        INT4B_REFERENCE_DATABASE_URL:
          `postgresql://postgres:int4b-local@127.0.0.1:${referencePort}/reference_int4b`,
        INT4B_HARNESS_DATABASE_URL:
          `postgresql://postgres:int4b-local@127.0.0.1:${harnessPort}/harness_int4b`,
        INT4B_PRINT_EVIDENCE: "1",
        ...(mutation ? { INT4B_MUTATION: mutation } : {}),
      },
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
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
    "POSTGRES_PASSWORD=int4b-local",
    "--env",
    `POSTGRES_DB=${database}`,
    "postgres:16-alpine",
  ]);
  if (result.status !== 0) {
    throw new Error(`INT4B_DATABASE_START_FAILED boundary=${database}`);
  }
}

function waitForDatabase(name, database) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = docker([
      "exec",
      "--env",
      "PGPASSWORD=int4b-local",
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
    const sleep = spawnSync("sleep", ["1"]);
    if (sleep.status !== 0) break;
  }
  throw new Error(`INT4B_DATABASE_NEVER_READY boundary=${database}`);
}

function publishedPort(name) {
  const result = docker(["port", name, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout);
  if (result.status !== 0 || !match?.[1]) {
    throw new Error(`INT4B_DATABASE_PORT_MISSING container=${name}`);
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
