import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EVIDENCE_ENV = "INT4_DRILL_EVIDENCE_DIR";

export function prepareVitestExecution(
  suite,
  environment = process.env,
) {
  const configuredEvidence = environment[EVIDENCE_ENV]?.trim();
  const temporary = !configuredEvidence;
  const evidenceDir = configuredEvidence
    ? path.resolve(configuredEvidence)
    : mkdtempSync(path.join(tmpdir(), "int4-vitest-"));
  mkdirSync(evidenceDir, { recursive: true });
  const reportPath = path.join(evidenceDir, "vitest-report.json");

  return {
    reportPath,
    reporterArgs: [
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    assert(childStatus) {
      return assertVitestExecution({
        suite,
        childStatus,
        reportPath,
        evidenceDir,
      });
    },
    cleanup() {
      if (temporary) rmSync(evidenceDir, { recursive: true, force: true });
    },
  };
}

export function assertVitestExecution({
  suite,
  childStatus,
  reportPath,
  evidenceDir,
}) {
  const status = childStatus ?? 1;
  if (!existsSync(reportPath)) {
    if (status !== 0) return undefined;
    throw new Error(`${suite}_VITEST_REPORT_MISSING path=${reportPath}`);
  }

  let counts;
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const passed = countField(report, "numPassedTests");
    const failed = countField(report, "numFailedTests");
    const skipped = countField(report, "numPendingTests");
    const total = countField(report, "numTotalTests");
    counts = { passed, failed, skipped, executed: passed + failed, total };
  } catch (error) {
    if (status !== 0) return undefined;
    throw new Error(
      `${suite}_VITEST_REPORT_INVALID error=${safeErrorMessage(error)}`,
    );
  }

  const { passed, failed, skipped, executed, total } = counts;
  writeFileSync(
    path.join(evidenceDir, "executed-count.txt"),
    `${executed}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(evidenceDir, "execution-summary.json"),
    `${JSON.stringify({ suite, passed, failed, skipped, executed, total }, null, 2)}\n`,
    "utf8",
  );

  if (status !== 0) return { passed, failed, skipped, executed, total };
  if (skipped > 0) {
    throw new Error(
      `${suite}_DRILLS_SKIPPED passed=${passed} skipped=${skipped} total=${total}`,
    );
  }
  if (passed < 1) {
    throw new Error(
      `${suite}_DRILLS_NOT_EXECUTED passed=${passed} skipped=${skipped} total=${total}`,
    );
  }

  console.info(
    `${suite}_DRILLS_EXECUTED passed=${passed} skipped=${skipped} failed=${failed} total=${total}`,
  );
  return { passed, failed, skipped, executed, total };
}

function countField(report, field) {
  const value = report?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`VITEST_REPORT_COUNT_INVALID field=${field}`);
  }
  return value;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
