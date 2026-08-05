import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const BURNIN_LEDGER_NAME = "LEDGER.jsonl";
export const BURNIN_SUMMARY_NAME = "SUMMARY.md";
export const BURNIN_GREEN_FAMILIES = Object.freeze([
  "lint-format",
  "docs-fix",
  "add-unit-test",
  "small-refactor",
]);
export const BURNIN_SENTINEL_FAMILY = "lint-format-red";
export const DEFAULT_THRESHOLD_LINE = "thresholds: not yet approved";

export class BurninLedgerError extends Error {
  constructor(message) {
    super(`burn-in ledger refused: ${message}`);
    this.name = "BurninLedgerError";
  }
}

export async function readBurninLedger(evidenceDirectory) {
  const ledgerPath = path.join(evidenceDirectory, BURNIN_LEDGER_NAME);
  let bytes = "";
  try {
    bytes = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = [];
  for (const [index, text] of bytes.split(/\r?\n/u).entries()) {
    if (!text.trim()) continue;
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new BurninLedgerError(
        `invalid_json line=${index + 1} detail=${error.message}; summary refused`,
      );
    }
    lines.push(value);
  }
  assertContiguousSequence(lines);
  return lines;
}

export async function appendBurninLedgerLines(evidenceDirectory, additions) {
  const existing = await readBurninLedger(evidenceDirectory);
  const expectedFirst = existing.length + 1;
  additions.forEach((line, index) => {
    const expected = expectedFirst + index;
    if (line?.seq !== expected) {
      throw new BurninLedgerError(
        `append_seq expected=${expected} actual=${String(line?.seq)}`,
      );
    }
  });
  await mkdir(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, BURNIN_LEDGER_NAME);
  const handle = await open(target, "a");
  try {
    await handle.writeFile(
      additions.map((line) => JSON.stringify(line)).join("\n")
        + (additions.length > 0 ? "\n" : ""),
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return [...existing, ...additions];
}

export function aggregateBurninLedger(lines) {
  assertContiguousSequence(lines);
  const violations = [];
  const incidents = [];
  const duplicateWorkItems = duplicateValues(lines, "workItemId");
  const duplicateRuns = duplicateValues(lines, "boundRunId");
  for (const [value, seqs] of duplicateWorkItems) {
    violations.push({
      code: "duplicate_work_item",
      seqs,
      detail: `workItemId=${value}`,
    });
  }
  for (const [value, seqs] of duplicateRuns) {
    const incident = {
      code: "duplicate_dispatch",
      seqs,
      detail: `boundRunId=${value}`,
    };
    violations.push(incident);
    incidents.push(incident);
  }

  const duplicateSeqs = new Set([
    ...duplicateWorkItems.values(),
    ...duplicateRuns.values(),
  ].flat());
  const eligible = [];
  const greenLines = [];
  let correlationPassed = 0;
  let sentinelCount = 0;
  let correctSentinelCount = 0;
  let prOpenings = 0;

  for (const line of lines) {
    const sentinel = line?.family === BURNIN_SENTINEL_FAMILY;
    const green = BURNIN_GREEN_FAMILIES.includes(line?.family);
    if (green) greenLines.push(line);
    if (sentinel) sentinelCount += 1;
    const lineViolations = validateEvidenceLine(line, { green, sentinel });
    for (const violation of lineViolations) violations.push(violation);
    if (line?.intendedRunId && line.intendedRunId === line.boundRunId) {
      if (green) correlationPassed += 1;
    }
    if (line?.prOpened === true) {
      prOpenings += 1;
      const incident = {
        code: "pr_opened",
        seqs: [line.seq],
        detail: `workItemId=${String(line.workItemId)}`,
      };
      incidents.push(incident);
      violations.push(incident);
    }
    if (line?.effectsMutates === true) {
      const incident = {
        code: "unexpected_actuation",
        seqs: [line.seq],
        detail: `workItemId=${String(line.workItemId)}`,
      };
      incidents.push(incident);
      violations.push(incident);
    }
    const invalid = lineViolations.length > 0 || duplicateSeqs.has(line?.seq)
      || line?.prOpened === true || line?.effectsMutates === true;
    if (green && !invalid) eligible.push(line);
    if (sentinel && !invalid) correctSentinelCount += 1;
  }

  const timestamps = lines
    .map((line) => ({ seq: line?.seq, value: timestamp(line?.ts) }))
    .filter((item) => item.value !== null)
    .sort((left, right) => left.value - right.value);
  const incidentTimestamps = incidents.flatMap((incident) =>
    incident.seqs.map((seq) => ({
      seq,
      value: timestamp(lines.find((line) => line?.seq === seq)?.ts),
    }))).filter((item) => item.value !== null);
  const newest = timestamps.at(-1)?.value ?? null;
  const latestIncident = incidentTimestamps
    .sort((left, right) => left.value - right.value)
    .at(-1)?.value ?? null;
  const oldestEligible = eligible
    .map((line) => timestamp(line.ts))
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
  const spanStart = latestIncident ?? oldestEligible;
  const spanDays = newest !== null && spanStart !== null
    ? Math.max(0, newest - spanStart) / 86_400_000
    : 0;

  return {
    items: eligible.length,
    itemTarget: 20,
    families: new Set(eligible.map((line) => line.family)).size,
    familyTarget: 3,
    spanDays,
    spanTargetDays: 14,
    spanResetAt: latestIncident === null
      ? null
      : new Date(latestIncident).toISOString(),
    incidentFree: incidents.length === 0,
    incidents,
    correlationPassed,
    correlationTotal: greenLines.length,
    prOpenings,
    sentinelCount,
    correctSentinelCount,
    violations,
    measurements: measurementsByFamily(eligible),
  };
}

export function renderBurninSummary(
  aggregation,
  {
    generatedAt = new Date().toISOString(),
    thresholdLine = DEFAULT_THRESHOLD_LINE,
  } = {},
) {
  const lines = [
    "# Harness §9.1 Burn-in Summary",
    "",
    thresholdLine,
    `generated: ${generatedAt}`,
    "",
    `items: ${aggregation.items}/${aggregation.itemTarget}   families: ${aggregation.families}/${aggregation.familyTarget}   span: ${aggregation.spanDays.toFixed(2)} days of ${aggregation.spanTargetDays}`,
    `incident-free: ${aggregation.incidentFree} (${aggregation.incidents.length} incidents)`,
    `correlation: ${aggregation.correlationPassed}/${aggregation.correlationTotal}   unverified PR openings: ${aggregation.prOpenings}`,
    `red sentinels: ${aggregation.sentinelCount} recorded, ${aggregation.correctSentinelCount} correctly refused, 0 counted`,
  ];
  if (aggregation.spanResetAt) {
    lines.push(`span reset at: ${aggregation.spanResetAt}`);
  }
  lines.push("", "## Measurements");
  if (aggregation.measurements.length === 0) {
    lines.push("", "No eligible measurements recorded.");
  } else {
    for (const measurement of aggregation.measurements) {
      lines.push(
        "",
        `- ${measurement.family}: n=${measurement.count}; elapsedSeconds p50=${formatNumber(measurement.elapsed.p50)} p95=${formatNumber(measurement.elapsed.p95)}; verificationSeconds p50=${formatNumber(measurement.verification.p50)} p95=${formatNumber(measurement.verification.p95)}; modelTokens p50=${formatNumber(measurement.tokens.p50)} p95=${formatNumber(measurement.tokens.p95)}`,
      );
    }
  }
  lines.push("", "## Violations", "");
  if (aggregation.violations.length === 0) {
    lines.push("None.");
  } else {
    for (const violation of aggregation.violations) {
      lines.push(
        `- ${violation.code} seq=${violation.seqs.join(",")} ${violation.detail}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeBurninSummary(evidenceDirectory, aggregation, options = {}) {
  await mkdir(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, BURNIN_SUMMARY_NAME);
  let thresholdLine = DEFAULT_THRESHOLD_LINE;
  try {
    const existing = await readFile(target, "utf8");
    thresholdLine = existing.match(/^thresholds: .+$/mu)?.[0]
      ?? DEFAULT_THRESHOLD_LINE;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bytes = renderBurninSummary(aggregation, {
    ...options,
    thresholdLine,
  });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, "utf8");
  await rename(temporary, target);
  return bytes;
}

export function buildBurninLedgerLine(evidence, { family, seq }) {
  const handoffs = Array.isArray(evidence?.decisions)
    ? evidence.decisions.filter((decision) => decision?.decisionType === "handoff")
    : [];
  const boundRuns = Array.isArray(evidence?.outbox)
    ? [...new Set(evidence.outbox.map((row) => row?.harness_run_id).filter(Boolean))]
    : [];
  const run = Array.isArray(evidence?.runs)
    ? evidence.runs.find((candidate) => candidate?.runId === evidence?.intendedRunId)
    : undefined;
  const criteria = Array.isArray(evidence?.verification?.details)
    ? evidence.verification.details.map((detail) => ({
        id: detail?.id,
        passed: detail?.passed,
        reason: detail?.reason,
      }))
    : null;
  const pullRequestBound = evidence?.task?.bindings?.pullRequest !== undefined;
  return {
    seq,
    ts: evidence?.metrics?.observedAt ?? run?.updatedAt ?? null,
    workItemId: evidence?.workItemId ?? null,
    family,
    taskVersion: evidence?.task?.taskVersion ?? null,
    intendedRunId: evidence?.intendedRunId ?? null,
    boundRunId: boundRuns.length === 1 ? boundRuns[0] : null,
    lifecycle: evidence?.task?.lifecycle ?? null,
    harnessOutcome: run?.outcome ?? null,
    ...(evidence?.verification?.verdict === undefined
      ? {}
      : { verificationVerdict: evidence.verification.verdict }),
    criteria,
    handoffDecisions: handoffs.length,
    prOpened: pullRequestBound
      || (Array.isArray(evidence?.pullRequestReferences)
        && evidence.pullRequestReferences.length > 0),
    effectsMutates: handoffs.some(
      (decision) => decision?.effects?.mutates === true,
    ),
    elapsedSeconds: evidence?.metrics?.elapsedSeconds ?? null,
    verificationSeconds: evidence?.metrics?.verificationSeconds ?? null,
    modelTokens: evidence?.metrics?.modelTokens ?? null,
    alerts: Array.isArray(evidence?.alerts)
      ? evidence.alerts.map((alert) => ({
          code: alert?.code,
          severity: alert?.severity,
          message: alert?.message,
        }))
      : null,
  };
}

function assertContiguousSequence(lines) {
  lines.forEach((line, index) => {
    const expected = index + 1;
    if (line?.seq !== expected) {
      throw new BurninLedgerError(
        `seq_gap expected=${expected} actual=${String(line?.seq)} line=${index + 1}; summary refused`,
      );
    }
  });
}

function validateEvidenceLine(line, { green, sentinel }) {
  const violations = [];
  const add = (code, detail) => violations.push({
    code,
    seqs: [Number.isSafeInteger(line?.seq) ? line.seq : -1],
    detail,
  });
  if (!green && !sentinel) add("unknown_family", `family=${String(line?.family)}`);
  for (const key of [
    "ts",
    "workItemId",
    "taskVersion",
    "intendedRunId",
    "boundRunId",
    "lifecycle",
    "harnessOutcome",
    "verificationVerdict",
    "criteria",
    "handoffDecisions",
    "prOpened",
    "effectsMutates",
    "elapsedSeconds",
    "verificationSeconds",
    "modelTokens",
    "alerts",
  ]) {
    if (line?.[key] === undefined || line?.[key] === null) {
      add("missing_evidence", `field=${key}`);
    }
  }
  if (timestamp(line?.ts) === null) add("invalid_timestamp", `ts=${String(line?.ts)}`);
  if (!Array.isArray(line?.criteria) || line.criteria.length === 0) {
    add("criteria_missing", "criteria must contain verifier results");
  } else if (line.criteria.some((criterion) =>
    typeof criterion?.id !== "string"
      || typeof criterion?.passed !== "boolean"
      || typeof criterion?.reason !== "string")) {
    add("criteria_ambiguous", "criterion id, passed, or reason is missing");
  }
  if (!Array.isArray(line?.alerts)) add("alerts_missing", "alerts is not an array");
  if (green) {
    if (line?.lifecycle !== "handoff_ready") {
      add("green_lifecycle", `expected=handoff_ready actual=${String(line?.lifecycle)}`);
    }
    if (line?.harnessOutcome !== "completed") {
      add("green_outcome", `expected=completed actual=${String(line?.harnessOutcome)}`);
    }
    if (line?.verificationVerdict !== "completed") {
      add("green_verdict", `expected=completed actual=${String(line?.verificationVerdict)}`);
    }
    if (line?.handoffDecisions !== 1) {
      add("green_handoff_count", `expected=1 actual=${String(line?.handoffDecisions)}`);
    }
    if (Array.isArray(line?.criteria)
        && line.criteria.some((criterion) => criterion?.passed !== true)) {
      add("green_criterion_failed", "at least one criterion did not pass");
    }
  }
  if (sentinel) {
    if (line?.lifecycle !== "failed") {
      add("sentinel_lifecycle", `expected=failed actual=${String(line?.lifecycle)}`);
    }
    if (line?.verificationVerdict !== "failed") {
      add("sentinel_verdict", `expected=failed actual=${String(line?.verificationVerdict)}`);
    }
    if (line?.handoffDecisions !== 0) {
      add("sentinel_handoff_count", `expected=0 actual=${String(line?.handoffDecisions)}`);
    }
  }
  if (line?.intendedRunId !== line?.boundRunId) {
    add(
      "correlation_mismatch",
      `intended=${String(line?.intendedRunId)} bound=${String(line?.boundRunId)}`,
    );
  }
  return violations;
}

function duplicateValues(lines, key) {
  const locations = new Map();
  for (const line of lines) {
    const value = line?.[key];
    if (typeof value !== "string" || !value) continue;
    const seqs = locations.get(value) ?? [];
    seqs.push(line.seq);
    locations.set(value, seqs);
  }
  return new Map([...locations].filter(([, seqs]) => seqs.length > 1));
}

function measurementsByFamily(lines) {
  return BURNIN_GREEN_FAMILIES.flatMap((family) => {
    const rows = lines.filter((line) => line.family === family);
    if (rows.length === 0) return [];
    return [{
      family,
      count: rows.length,
      elapsed: percentiles(rows.map((line) => line.elapsedSeconds)),
      verification: percentiles(rows.map((line) => line.verificationSeconds)),
      tokens: percentiles(rows.map((line) => line.modelTokens)),
    }];
  });
}

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.ceil(fraction * values.length) - 1];
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value) {
  return value === null ? "n/a" : Number(value.toFixed(3)).toString();
}
