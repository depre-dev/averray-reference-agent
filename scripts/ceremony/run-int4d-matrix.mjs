import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadInt4dMatrix,
  renderInt4Exit,
  renderInt4dLedger,
  validateInt4dMatrix,
} from "./int4d-matrix.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mutation = argument("--mutation");
const validateOnly = process.argv.includes("--validate-only");
const render = process.argv.includes("--render");
const allowedMutations = new Set([
  "citation-drift",
  "delete-deferral-reason",
  "drop-owner",
  "fake-proven",
]);
if (mutation && !allowedMutations.has(mutation)) {
  throw new Error(`INT4D_UNKNOWN_MUTATION name=${mutation}`);
}

const records = structuredClone(await loadInt4dMatrix(root));
applyMutation(records, mutation);
const counts = await validateInt4dMatrix(records, root);
console.info(`INT4D_MATRIX_VALID executed=${counts.executed} cited_ci=${counts["cited-ci"]} deferred=${counts.deferred} total=${records.length}`);
if (render) {
  await writeFile(path.join(root, "docs/HARNESS_INT4_DRILL_LEDGER.md"), renderInt4dLedger(records));
  await writeFile(path.join(root, "docs/HARNESS_INT4_EXIT.md"), renderInt4Exit(records));
  console.info("INT4D_MATRIX_RENDERED ledger=docs/HARNESS_INT4_DRILL_LEDGER.md exit=docs/HARNESS_INT4_EXIT.md");
}
if (!validateOnly) {
  const result = spawnSync(process.execPath, [
    "scripts/ceremony/run-int4d-drills.mjs",
  ], { cwd: root, encoding: "utf8", env: process.env });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exitCode = result.status ?? 1;
}

function applyMutation(records, name) {
  if (!name) return;
  console.info(`INT4D_MATRIX_MUTATION_APPLIED=${name}`);
  if (name === "citation-drift") {
    records.find((row) => row.source === "cited-ci").auditRefs[0].caseName += " renamed";
  } else if (name === "delete-deferral-reason") {
    delete records.find((row) => row.source === "deferred").deferred.reason;
  } else if (name === "drop-owner") {
    delete records[0].owner;
  } else if (name === "fake-proven") {
    const row = records.find((candidate) => candidate.source === "deferred" && candidate.auditRefs.length === 0);
    row.source = "cited-ci";
    delete row.deferred;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
