import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readCardFailureAnalysis,
  readFreshCardFailureAnalysis,
  writeCardFailureAnalysis,
} from "../../services/slack-operator/src/operator-card-failure-analysis.js";

describe("operator-card-failure-analysis — per-card cache keyed by failure hash", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-failure-analysis-"));
    path = join(dir, "card-failure-analysis.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when nothing is stored", () => {
    expect(readCardFailureAnalysis("deploy-abc", path)).toBeUndefined();
    expect(readFreshCardFailureAnalysis("deploy-abc", "hash1", path)).toBeUndefined();
  });

  it("round-trips a stored analysis with its model + failure hash + timestamp", () => {
    writeCardFailureAnalysis(
      "deploy-abc",
      { text: "unit tests failed; roll back and re-run.", model: "hermes-4", failureHash: "hash1" },
      () => new Date("2026-07-01T00:00:00Z"),
      path,
    );
    const read = readCardFailureAnalysis("deploy-abc", path);
    expect(read).toEqual({
      text: "unit tests failed; roll back and re-run.",
      model: "hermes-4",
      failureHash: "hash1",
      at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("readFresh returns the entry only when the failure hash still matches", () => {
    writeCardFailureAnalysis("deploy-abc", { text: "grounded", failureHash: "hash1" }, () => new Date(), path);
    // Fresh for the same failure...
    expect(readFreshCardFailureAnalysis("deploy-abc", "hash1", path)?.text).toBe("grounded");
    // ...stale once the failure context (hash) changed.
    expect(readFreshCardFailureAnalysis("deploy-abc", "hash2", path)).toBeUndefined();
  });

  it("is scoped per card — a different card is unaffected", () => {
    writeCardFailureAnalysis("card-1", { text: "a", failureHash: "h" }, () => new Date(), path);
    expect(readCardFailureAnalysis("card-2", path)).toBeUndefined();
  });

  it("ignores a malformed entry (missing text or hash)", () => {
    // A well-formed write, then confirm normalization drops junk shapes by
    // writing a second card and reading the first back cleanly.
    writeCardFailureAnalysis("ok", { text: "fine", failureHash: "h" }, () => new Date(), path);
    expect(readCardFailureAnalysis("ok", path)?.text).toBe("fine");
    // An empty-text write yields no usable entry on read-back.
    writeCardFailureAnalysis("blank", { text: "   ", failureHash: "h" }, () => new Date(), path);
    expect(readCardFailureAnalysis("blank", path)).toBeUndefined();
  });
});
