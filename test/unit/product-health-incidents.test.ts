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

// An episode orphaned by a restart: persisted and open, but the in-memory ring
// that would close it was emptied, so it is no longer derived from anything.
describe("reconcileIncidents — orphans left open by a restart", () => {
  const orphan = incident({ id: "money_path-500", probe: "money_path", startedAt: 500 });

  // SEEN ON MAINNET: the board read "money_path degraded for 1h 33m" next to a
  // green money_path probe, and the counter would have kept climbing forever.
  it("closes an open episode whose probe is now ok", () => {
    const r = reconcileIncidents({
      persisted: [orphan],
      derived: [],
      limit: 50,
      currentProbeStatus: new Map([["money_path", "ok"]]),
      nowMs: 9_000,
    });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.endedAt).toBe(9_000);
    // …and admits the recovery time is a stamp, not an observation.
    expect(r.writes[0]!.note).toContain("exact recovery time unknown");
  });

  it("leaves it open while the probe is still failing", () => {
    for (const status of ["red", "degraded"] as const) {
      const r = reconcileIncidents({
        persisted: [orphan],
        derived: [],
        limit: 50,
        currentProbeStatus: new Map([["money_path", status]]),
        nowMs: 9_000,
      });
      expect(r.writes).toEqual([]);
      expect(r.merged[0]!.endedAt).toBeNull();
    }
  });

  // Closing on a probe we have no reading for would be closing on ABSENCE of
  // evidence — the same mistake as a fake green, pointed the other way.
  it("leaves it open when the probe is missing from the snapshot entirely", () => {
    const r = reconcileIncidents({
      persisted: [orphan],
      derived: [],
      limit: 50,
      currentProbeStatus: new Map([["api_latency", "ok"]]),
      nowMs: 9_000,
    });
    expect(r.writes).toEqual([]);
  });

  it("does not touch an episode this buffer still derives", () => {
    const r = reconcileIncidents({
      persisted: [orphan],
      derived: [orphan],
      limit: 50,
      currentProbeStatus: new Map([["money_path", "ok"]]),
      nowMs: 9_000,
    });
    expect(r.writes).toEqual([]);
  });

  it("never re-closes an already-closed record", () => {
    const closed = incident({ id: "money_path-500", probe: "money_path", endedAt: 700 });
    const r = reconcileIncidents({
      persisted: [closed],
      derived: [],
      limit: 50,
      currentProbeStatus: new Map([["money_path", "ok"]]),
      nowMs: 9_000,
    });
    expect(r.writes).toEqual([]);
  });

  // Without the status map nothing may close — the old behaviour exactly, so a
  // caller that cannot supply present evidence changes nothing.
  it("closes nothing when no current status is supplied", () => {
    const r = reconcileIncidents({ persisted: [orphan], derived: [], limit: 50 });
    expect(r.writes).toEqual([]);
  });
});

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
