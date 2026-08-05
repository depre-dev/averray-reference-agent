#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  aggregateBurninLedger,
  appendBurninLedgerLines,
  buildBurninLedgerLine,
  readBurninLedger,
  writeBurninSummary,
} from "./burnin-ledger.mjs";
import { verifyInt2Evidence } from "./int2-evidence.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const CASES = Object.freeze([
  Object.freeze({ family: "lint-format", caseName: "green" }),
  Object.freeze({ family: "docs-fix", caseName: "docs-fix" }),
  Object.freeze({ family: "add-unit-test", caseName: "add-unit-test" }),
  Object.freeze({ family: "small-refactor", caseName: "small-refactor" }),
  Object.freeze({ family: "lint-format-red", caseName: "negative" }),
]);

export async function runBurninBatch(
  argv,
  {
    environment = process.env,
    now = () => new Date(),
    output = (text) => process.stdout.write(text),
    errorOutput = (text) => process.stderr.write(text),
    executeSuite = executeRealSuite,
    verifyEvidence = verifyInt2Evidence,
  } = {},
) {
  let evidenceDirectory;
  try {
    evidenceDirectory = parseEvidenceArgument(argv);
  } catch (error) {
    errorOutput(`run-burnin-batch: ${error.message}\n`);
    return 2;
  }

  try {
    await mkdir(evidenceDirectory, { recursive: true });
    const existing = await readBurninLedger(evidenceDirectory);
    const firstSequence = existing.length + 1;
    const date = now().toISOString().slice(0, 10).replaceAll("-", "");
    const batchPrefix = `burnin-${date}-${String(firstSequence).padStart(6, "0")}`;
    const batchDirectory = path.join(
      evidenceDirectory,
      "batches",
      batchPrefix,
    );
    await mkdir(path.dirname(batchDirectory), { recursive: true });
    await mkdir(batchDirectory, { recursive: false });

    await executeSuite({
      repositoryRoot: REPOSITORY_ROOT,
      evidenceDirectory: batchDirectory,
      batchPrefix,
      environment,
    });

    const lines = [];
    for (const [index, definition] of CASES.entries()) {
      const target = path.join(
        batchDirectory,
        definition.caseName,
        "evidence.json",
      );
      const evidence = JSON.parse(await readFile(target, "utf8"));
      verifyEvidence(evidence, definition.caseName);
      lines.push(buildBurninLedgerLine(evidence, {
        family: definition.family,
        seq: firstSequence + index,
      }));
    }

    const ledger = await appendBurninLedgerLines(evidenceDirectory, lines);
    const aggregation = aggregateBurninLedger(ledger);
    const summary = await writeBurninSummary(evidenceDirectory, aggregation);
    output(
      `BURNIN_BATCH_COMPLETED prefix=${batchPrefix} items=4 sentinel=1\n`,
    );
    output(summary);
    return aggregation.violations.length === 0 ? 0 : 1;
  } catch (error) {
    errorOutput(`run-burnin-batch: ${error.message}\n`);
    return 1;
  }
}

function parseEvidenceArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--evidence" || !argv[1]?.trim()) {
    throw new Error("--evidence <dir> is required; no default evidence path exists");
  }
  return path.resolve(argv[1]);
}

async function executeRealSuite({
  repositoryRoot,
  evidenceDirectory,
  batchPrefix,
  environment,
}) {
  const child = spawn(
    path.join(repositoryRoot, "scripts/ceremony/run-int2-automated-suite.sh"),
    [],
    {
      cwd: repositoryRoot,
      env: {
        ...environment,
        INT2_BURNIN_BATCH_MODE: "1",
        INT2_BURNIN_WORK_ITEM_PREFIX: batchPrefix,
        INT2_SUITE_EVIDENCE_DIR: evidenceDirectory,
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => {
      if (signal) reject(new Error(`INT-2 machinery exited on signal ${signal}`));
      else resolve(value ?? 1);
    });
  });
  if (code !== 0) {
    throw new Error(`INT-2 machinery exited ${code}`);
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exitCode = await runBurninBatch(process.argv.slice(2));
}
