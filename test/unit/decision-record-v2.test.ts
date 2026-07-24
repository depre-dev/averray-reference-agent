import { describe, expect, it } from "vitest";

import {
  listHermesDecisions,
  recordHermesDecision,
  type HermesDecisionStoreQuery,
} from "../../packages/averray-mcp/src/decision-record-store.js";
import {
  buildHermesDecisionRecordV2,
  createHermesDecisionRecord,
  type BuildHermesDecisionRecordV2Input,
} from "../../packages/averray-mcp/src/decision-records.js";
import {
  hermesDecisionRecordV2Schema,
  type HermesDecisionRecordV2,
} from "../../packages/schemas/src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;

describe("INT-2e HermesDecisionRecord V2 audit layer", () => {
  it("builds, validates, stores, and lists a deterministic V2 record", async () => {
    const db = new MemoryDecisionDatabase();
    const input = decisionInput();
    const first = buildHermesDecisionRecordV2(input);
    const second = buildHermesDecisionRecordV2(input);

    expect(second.decisionId).toBe(first.decisionId);
    expect(hermesDecisionRecordV2Schema.parse(first)).toEqual(first);
    await expect(recordHermesDecision(first, { query: db.query }))
      .resolves.toEqual(first);
    await expect(
      listHermesDecisions(
        { correlationId: first.correlationId, workItemId: first.workItemId },
        { query: db.query },
      ),
    ).resolves.toEqual([first]);
  });

  it("redacts secret-looking free text and input references before validation", () => {
    const input = decisionInput({
      proposal: {
        what: "Refuse Bearer abc.def.ghi before dispatch.",
        why: ["password=supersecret must never reach the audit record."],
        whyNow: "An sk-abcdefghijklmnop credential appeared.",
        evidenceRefs: [],
      },
      inputs: [{
        name: "task-input",
        ref: {
          uri: "artifact://input/password=hidden-value",
          sha256: HASH,
        },
        hash: HASH,
        observedAt: "2026-07-24T12:00:00.000Z",
      }],
    });

    const record = buildHermesDecisionRecordV2(input);
    const serialized = JSON.stringify(record);
    for (const secret of [
      "abc.def.ghi",
      "supersecret",
      "abcdefghijklmnop",
      "hidden-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[redacted]");
  });

  it("inserts duplicate decision ids once and never updates the original row", async () => {
    const db = new MemoryDecisionDatabase();
    const original = buildHermesDecisionRecordV2(decisionInput());
    const conflictingReplay = hermesDecisionRecordV2Schema.parse({
      ...original,
      proposal: {
        ...original.proposal,
        what: "A changed replay must not update the append-only row.",
      },
    });

    await recordHermesDecision(original, { query: db.query });
    await recordHermesDecision(original, { query: db.query });
    await recordHermesDecision(conflictingReplay, { query: db.query });

    expect(db.size).toBe(1);
    await expect(listHermesDecisions({}, { query: db.query }))
      .resolves.toEqual([original]);
  });

  it("leaves the V1 builder behavior intact", () => {
    const record = createHermesDecisionRecord({
      kind: "routing",
      subject: { type: "task", id: "task-one" },
      decision: "route to the approved executor",
      reasons: ["The scorecard selected it."],
      inputs: { privateKey: "must-redact" },
      outcome: { summary: "Routing recorded." },
      safety: { readOnly: true, mutates: false },
      generatedAt: "2026-07-24T12:00:00.000Z",
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      recordType: "hermes_decision_record",
      kind: "routing",
    });
    expect(record.inputs.privateKey).toBe("[redacted]");
  });
});

interface MemoryDecisionRow {
  decision_id: string;
  correlation_id: string;
  work_item_id: string | null;
  decision_type: string;
  generated_at: string;
  record: HermesDecisionRecordV2;
}

class MemoryDecisionDatabase {
  private readonly rows = new Map<string, MemoryDecisionRow>();

  get size(): number {
    return this.rows.size;
  }

  readonly query: HermesDecisionStoreQuery = async <T>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (/insert into hermes_decision_records/i.test(text)) {
      const decisionId = String(values[0]);
      if (this.rows.has(decisionId)) return [];
      const row: MemoryDecisionRow = {
        decision_id: decisionId,
        correlation_id: String(values[1]),
        work_item_id: values[2] === null ? null : String(values[2]),
        decision_type: String(values[3]),
        generated_at: String(values[4]),
        record: JSON.parse(String(values[5])) as HermesDecisionRecordV2,
      };
      this.rows.set(decisionId, row);
      return [structuredClone(row) as T];
    }
    if (/from hermes_decision_records/i.test(text)) {
      let rows = [...this.rows.values()];
      const correlationMatch = /correlation_id = \$(\d+)/i.exec(text);
      if (correlationMatch) {
        rows = rows.filter((row) =>
          row.correlation_id === values[Number(correlationMatch[1]) - 1]);
      }
      const workItemMatch = /work_item_id = \$(\d+)/i.exec(text);
      if (workItemMatch) {
        rows = rows.filter((row) =>
          row.work_item_id === values[Number(workItemMatch[1]) - 1]);
      }
      rows.sort((left, right) =>
        Date.parse(right.generated_at) - Date.parse(left.generated_at));
      const limitMatch = /limit \$(\d+)/i.exec(text);
      const limit = limitMatch
        ? Number(values[Number(limitMatch[1]) - 1])
        : rows.length;
      return rows.slice(0, limit).map((row) => structuredClone(row) as T);
    }
    throw new Error(`Unexpected decision-record test query: ${text}`);
  };
}

function decisionInput(
  overrides: Partial<BuildHermesDecisionRecordV2Input> = {},
): BuildHermesDecisionRecordV2Input {
  return {
    correlationId: "correlation-one",
    workItemId: "work-one",
    decisionType: "dispatch_refusal",
    proposal: {
      what: "Refuse dispatch until the invariant is restored.",
      why: ["The immutable claim did not match."],
      whyNow: "The mismatch was observed before submission.",
      evidenceRefs: [],
    },
    inputs: [{
      name: "approved-task",
      hash: HASH,
      observedAt: "2026-07-24T12:00:00.000Z",
    }],
    routing: {
      executor: "harness",
      reason: "The approved task selected the isolated Harness executor.",
    },
    risk: {
      tier: "medium",
      reasons: ["A conflicting dispatch identity must fail closed."],
      irreversible: false,
    },
    approval: {
      required: "operator",
      decision: "approved",
      actor: { type: "operator", id: "operator-one" },
      policyVersion: "policy-v1",
      policyHash: HASH,
      decidedAt: "2026-07-24T11:59:00.000Z",
    },
    effects: {
      mutates: false,
      mutations: [],
      authorityChanged: false,
      budgetChanged: false,
    },
    next: {
      action: "Operator resolves the conflicting immutable claim.",
      owner: "operator",
    },
    generatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  };
}
