#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareVitestExecution } from "./lib/int4-vitest-execution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const databaseUrl = process.env.DISPATCH_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("INT2E_DATABASE_URL_MISSING");
}

// Reuse the already-drilled Vitest JSON accounting while giving INT-2e its own
// evidence directory and vocabulary. Existing INT-4 callers retain their
// default env name and DRILLS label.
const execution = prepareVitestExecution(
  "INT2E",
  process.env,
  "INT2E_SUITE_EVIDENCE_DIR",
  "TESTS",
);
const childEnvironment = { ...process.env };
delete childEnvironment.DISPATCH_TEST_DATABASE_URL;
childEnvironment.DISPATCH_TEST_DATABASE_URL = databaseUrl;
const startedAt = Date.now();

try {
  const result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "test/integration/dispatch-store-postgres.test.ts",
      ...execution.reporterArgs,
    ],
    {
      cwd: root,
      env: childEnvironment,
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const counts = execution.assert(result.status);
  const elapsedMs = Date.now() - startedAt;
  writeFileSync(
    path.join(path.dirname(execution.reportPath), "wall-time-milliseconds.txt"),
    `${elapsedMs}\n`,
    "utf8",
  );
  console.info(
    `INT2E_TESTS_COMPLETED executed=${counts?.executed ?? 0} skipped=${counts?.skipped ?? 0} elapsed_ms=${elapsedMs}`,
  );
  process.exitCode = result.status ?? 1;
} finally {
  execution.cleanup();
}
