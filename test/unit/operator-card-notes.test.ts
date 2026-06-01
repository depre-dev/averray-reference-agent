import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readOperatorCardNotes,
  writeOperatorCardNotes,
  defaultOperatorCardNotes,
} from "../../services/slack-operator/src/operator-card-notes.js";
import { buildV2BoardSnapshot } from "../../services/slack-operator/src/monitor-v2.js";

describe("operator-card-notes — per-card persistence", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-operator-notes-"));
    path = join(dir, "operator-card-notes.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the default checklist + empty note when nothing is saved", () => {
    const notes = readOperatorCardNotes("agent #548", path);
    expect(notes.note).toBe("");
    expect(notes.checklist.length).toBeGreaterThan(0);
    expect(notes.checklist.every((i) => i.done === false)).toBe(true);
    expect(notes).toEqual(expect.objectContaining(defaultOperatorCardNotes()));
  });

  it("round-trips a checklist toggle + note per card", () => {
    const checklist = defaultOperatorCardNotes().checklist.map((i, idx) => ({ ...i, done: idx === 0 }));
    writeOperatorCardNotes("agent #548", { checklist, note: "double-check the migration rollback" }, () => new Date("2026-06-01T00:00:00Z"), path);

    const read = readOperatorCardNotes("agent #548", path);
    expect(read.note).toBe("double-check the migration rollback");
    expect(read.checklist[0]!.done).toBe(true);
    expect(read.updatedAt).toBe("2026-06-01T00:00:00.000Z");

    // Scoped per card — a different card is unaffected.
    expect(readOperatorCardNotes("agent #999", path).note).toBe("");
  });

  it("PRIVACY: the operator note NEVER appears in the agent-facing board snapshot", () => {
    const SECRET = "OPERATOR-ONLY-SENTINEL-do-not-leak-7f3a";
    // The operator saves a private note on the card.
    writeOperatorCardNotes(
      "depre-dev/agent#548",
      { checklist: [], note: SECRET },
      () => new Date("2026-06-01T00:00:00Z"),
      path,
    );

    // Build the SAME board snapshot an agent / Hermes consumes for that card.
    const raw = {
      active: [
        {
          title: "Allow operator override of agent claim-stake floor",
          status: "needs_review",
          intent: "operator_review",
          summary: { pullRequest: { repo: "depre-dev/agent", number: 548, state: "open" }, finalVerdict: "operator_review" },
          ageLabel: "4m",
        },
      ],
      recent: [],
    };
    const snapshot = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });

    // The note is stored (operator can read it back)…
    expect(readOperatorCardNotes("depre-dev/agent#548", path).note).toBe(SECRET);
    // …but it is structurally absent from the agent-facing payload — the store
    // is never merged into the board snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });
});
