import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendIncidents,
  incidentLogPath,
  readIncidents,
  reconcileIncidents,
} from "../../services/slack-operator/src/product-health-incidents.js";
import type { ProductHealthIncident } from "../../services/slack-operator/src/product-health.js";

function incident(over: Partial<ProductHealthIncident> = {}): ProductHealthIncident {
  return {
    id: "api_latency-1000",
    probe: "api_latency",
    severity: "red",
    startedAt: 1000,
    endedAt: null,
    note: "/health 10212ms (> 10000ms)",
    ...over,
  };
}

async function tmpLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-incidents-"));
  return join(dir, "incidents.jsonl");
}

describe("reconcileIncidents (pure)", () => {
  it("writes a newly opened incident", () => {
    const r = reconcileIncidents({ persisted: [], derived: [incident()], limit: 50 });
    expect(r.writes).toHaveLength(1);
    expect(r.merged).toHaveLength(1);
  });

  it("writes again when an open incident closes (last-write-wins on the id)", () => {
    const open = incident();
    const closed = incident({ endedAt: 2000 });
    const r = reconcileIncidents({ persisted: [open], derived: [closed], limit: 50 });
    expect(r.writes).toEqual([closed]);
    expect(r.merged[0]!.endedAt).toBe(2000); // the close supersedes the open
  });

  it("writes NOTHING in a steady state — no churn on an unchanged incident", () => {
    const same = incident();
    expect(reconcileIncidents({ persisted: [same], derived: [same], limit: 50 }).writes).toHaveLength(0);
  });

  it("KEEPS an incident the sample ring has already forgotten — the whole point", () => {
    // The 2026-07-28 latency spike: aged out of the 60-slot buffer, so it is no
    // longer derived. It must survive anyway, or it can never be investigated.
    const old = incident({ id: "api_latency-1", startedAt: 1, endedAt: 2 });
    const r = reconcileIncidents({ persisted: [old], derived: [], limit: 50 });
    expect(r.merged).toEqual([old]);
    expect(r.writes).toHaveLength(0); // retained without rewriting
  });

  it("orders newest first and caps at the limit", () => {
    const persisted = Array.from({ length: 5 }, (_, i) => incident({ id: `i${i}`, startedAt: i * 100 }));
    const r = reconcileIncidents({ persisted, derived: [], limit: 3 });
    expect(r.merged.map((i) => i.startedAt)).toEqual([400, 300, 200]);
  });

  it("a sharpened note counts as a change worth persisting", () => {
    const r = reconcileIncidents({
      persisted: [incident({ note: "slow" })],
      derived: [incident({ note: "/health 10212ms (> 10000ms)" })],
      limit: 50,
    });
    expect(r.writes).toHaveLength(1);
  });
});

describe("incident log I/O", () => {
  it("round-trips, and a later record for an id supersedes the earlier one", async () => {
    const path = await tmpLog();
    await appendIncidents([incident()], { path });
    await appendIncidents([incident({ endedAt: 2000 })], { path });
    const read = await readIncidents(path);
    expect(read).toHaveLength(1); // collapsed by id
    expect(read[0]!.endedAt).toBe(2000); // the close won
  });

  it("survives a restart — that's why this is on disk and not in memory", async () => {
    const path = await tmpLog();
    await appendIncidents([incident({ id: "a", startedAt: 10 }), incident({ id: "b", startedAt: 20 })], { path });
    // A fresh process reads the same file; the slack-operator restarts on every deploy.
    expect((await readIncidents(path)).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("a missing log is an empty history, not an error", async () => {
    expect(await readIncidents(join(tmpdir(), "hermes-does-not-exist", "nope.jsonl"))).toEqual([]);
  });

  it("skips malformed lines instead of blinding the whole log", async () => {
    const path = await tmpLog();
    await writeFile(path, `not json\n${JSON.stringify(incident({ id: "good" }))}\n{"id":"partial"}\n`, "utf8");
    const read = await readIncidents(path);
    expect(read.map((i) => i.id)).toEqual(["good"]);
  });

  it("appending nothing writes nothing (no empty-file churn)", async () => {
    const path = await tmpLog();
    await appendIncidents([], { path });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("path comes from env, with a /data default that outlives the container", () => {
    expect(incidentLogPath({} as NodeJS.ProcessEnv)).toBe("/data/product-health-incidents.jsonl");
    expect(incidentLogPath({ PRODUCT_HEALTH_INCIDENT_LOG_PATH: "/x/y.jsonl" } as NodeJS.ProcessEnv)).toBe("/x/y.jsonl");
  });
});
