#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  aggregateBurninLedger,
  BurninLedgerError,
  readBurninLedger,
  writeBurninSummary,
} from "./burnin-ledger.mjs";

export async function runBurninStatus(
  argv,
  {
    output = (text) => process.stdout.write(text),
    errorOutput = (text) => process.stderr.write(text),
    generatedAt,
  } = {},
) {
  let evidenceDirectory;
  try {
    evidenceDirectory = parseEvidenceArgument(argv);
  } catch (error) {
    errorOutput(`burnin-status: ${error.message}\n`);
    return 2;
  }
  try {
    const ledger = await readBurninLedger(evidenceDirectory);
    const aggregation = aggregateBurninLedger(ledger);
    const summary = await writeBurninSummary(
      evidenceDirectory,
      aggregation,
      generatedAt ? { generatedAt } : {},
    );
    output(summary);
    return aggregation.violations.length === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof BurninLedgerError
      ? error.message
      : `burn-in status failed: ${error.message}`;
    errorOutput(`burnin-status: ${message}\n`);
    return 1;
  }
}

function parseEvidenceArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--evidence" || !argv[1]?.trim()) {
    throw new Error("usage: burnin-status.mjs --evidence <dir>");
  }
  return path.resolve(argv[1]);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exitCode = await runBurninStatus(process.argv.slice(2));
}
