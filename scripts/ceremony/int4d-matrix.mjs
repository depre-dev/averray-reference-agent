import { readFile } from "node:fs/promises";
import path from "node:path";

const SOURCES = new Set(["executed", "cited-ci", "deferred"]);

export class Int4dMatrixError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Int4dMatrixError";
  }
}

export async function loadInt4dMatrix(root, target = "scripts/ceremony/int4d-matrix.json") {
  return JSON.parse(await readFile(path.join(root, target), "utf8"));
}

export async function validateInt4dMatrix(records, root) {
  if (!Array.isArray(records) || records.length !== 22) {
    throw new Int4dMatrixError(`INT4D_MATRIX_COUNT expected=22 actual=${Array.isArray(records) ? records.length : "non-array"}`);
  }
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Int4dMatrixError(`INT4D_MATRIX_ROW_INVALID index=${index}`);
    }
    for (const field of ["id", "title", "detection", "containment", "recovery", "owner"]) {
      if (typeof record[field] !== "string" || !record[field].trim()) {
        throw new Int4dMatrixError(`INT4D_MATRIX_FIELD_MISSING row=${record.id ?? index} field=${field}`);
      }
    }
    if (ids.has(record.id)) throw new Int4dMatrixError(`INT4D_MATRIX_DUPLICATE_ID row=${record.id}`);
    ids.add(record.id);
    if (!SOURCES.has(record.source)) {
      throw new Int4dMatrixError(`INT4D_MATRIX_SOURCE_INVALID row=${record.id}`);
    }
    if (!Array.isArray(record.auditRefs)) {
      throw new Int4dMatrixError(`INT4D_MATRIX_FIELD_MISSING row=${record.id} field=auditRefs`);
    }
    if (record.source === "deferred") {
      for (const field of ["reason", "prerequisite", "date"]) {
        if (typeof record.deferred?.[field] !== "string" || !record.deferred[field].trim()) {
          throw new Int4dMatrixError(`INT4D_DEFERRED_FIELD_MISSING row=${record.id} field=${field}`);
        }
      }
    } else if (record.auditRefs.length === 0) {
      throw new Int4dMatrixError(`INT4D_EVIDENCE_MISSING row=${record.id} source=${record.source}`);
    }
    for (const reference of record.auditRefs) {
      if (typeof reference?.path !== "string" || !reference.path.trim()) {
        throw new Int4dMatrixError(`INT4D_EVIDENCE_REF_INVALID row=${record.id}`);
      }
      let source;
      try {
        source = await readFile(path.join(root, reference.path), "utf8");
      } catch {
        throw new Int4dMatrixError(`INT4D_CITATION_FILE_MISSING row=${record.id} path=${reference.path}`);
      }
      if (reference.caseName && !source.includes(`it("${reference.caseName}"`)) {
        throw new Int4dMatrixError(`INT4D_CITATION_DRIFT row=${record.id} case=${reference.caseName}`);
      }
    }
  }
  const counts = Object.fromEntries([...SOURCES].map((source) => [
    source,
    records.filter((record) => record.source === source).length,
  ]));
  if (counts.executed !== 5 || counts["cited-ci"] !== 13 || counts.deferred !== 4) {
    throw new Int4dMatrixError(`INT4D_MATRIX_ARITHMETIC executed=${counts.executed} cited_ci=${counts["cited-ci"]} deferred=${counts.deferred}`);
  }
  return counts;
}

export function renderInt4dLedger(records) {
  const lines = [
    "# INT-4 failure-drill ledger",
    "",
    "Rendered from `scripts/ceremony/int4d-matrix.json`. `cited-ci` means the named case runs continuously; `executed` means the INT-4d disposable drill ran; `deferred` names the prerequisite rather than inventing an unwired seam.",
    "",
    "| §11 drill | Source | Detection | Containment | Recovery | Audit refs | Owner |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of records) {
    const refs = row.auditRefs.map((reference) => reference.caseName
      ? `\`${reference.caseName}\` ([source](${reference.path}))`
      : `[source](${reference.path})`).join("<br>") || "None — unwired seam";
    const deferred = row.source === "deferred"
      ? `<br>Deferred ${row.deferred.date}: ${row.deferred.reason} Prerequisite: **${row.deferred.prerequisite}**.`
      : "";
    lines.push(`| ${row.title} | \`${row.source}\` | ${row.detection}${deferred} | ${row.containment} | ${row.recovery} | ${refs} | ${row.owner} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderInt4Exit(records) {
  const executed = records.filter((row) => row.source === "executed");
  const cited = records.filter((row) => row.source === "cited-ci");
  const deferred = records.filter((row) => row.source === "deferred");
  return `# INT-4 exit summary

> every drill has deterministic detection, containment, recovery, audit evidence, and an owner; no recovery silently expands authority or duplicates execution.

## Verdict by clause

- Detection: ${executed.length} disposable INT-4d drills and ${cited.length} continuously cited CI cases name what fires and when.
- Containment: all 22 rows name the authority-preserving boundary; the four unwired seams are deferred rather than simulated.
- Recovery: all 22 rows name the operator or durable convergence path.
- Audit evidence: ${executed.length + cited.length} rows are proven-or-executed; ${deferred.length} rows carry dated reasons and prerequisite packets.
- Ownership: every row has an assigned operational owner, pending operator confirmation below.
- No authority expansion or duplicate execution: the worker effect count, board zero-write fingerprint, dispatcher idempotency, and explicit deferrals make this clause mechanically visible.

Arithmetic: **${executed.length + cited.length} proven-or-executed + ${deferred.length} deferred = ${records.length} total §11 rows**.

## Newly executed drills

${executed.map((row) => `- ${row.title}: detection time is recorded in the INT-4d drill evidence produced by the runner.`).join("\n")}

## Deferred prerequisites

${deferred.map((row) => `- ${row.title} — ${row.deferred.prerequisite} (${row.deferred.date}): ${row.deferred.reason}`).join("\n")}

## Operator sign-off

- Owner assignments confirmed by: ____________________
- Evidence reviewed by: ____________________
- INT-4 accepted at: ____________________
`;
}
