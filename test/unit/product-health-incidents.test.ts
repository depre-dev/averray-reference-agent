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
    const persisted = Array.from({ length: 5 }, (_, i) =>
      incident({ id: `i${i}`, probe: `probe_${i}`, startedAt: i * 100, endedAt: i * 100 + 1 }),
    );
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

describe("one open incident per check", () => {
  const now = 10_000;

  it("opens one episode when a check first degrades", () => {
    const opened = incident({ id: "capabilities-1000", probe: "capabilities", startedAt: 1000, endedAt: null });
    const r = reconcileIncidents({
      persisted: [],
      derived: [opened],
      limit: 50,
      nowMs: now,
      currentProbeStatus: new Map([["capabilities", "degraded"]]),
    });
    expect(r.merged.filter((i) => i.endedAt == null)).toEqual([opened]);
  });

  it("a repeat probe does not open a second episode", () => {
    const original = incident({
      id: "capabilities-1000",
      probe: "capabilities",
      startedAt: 1000,
      endedAt: null,
      note: "first",
    });
    // The ring slid: same check, still degraded, new derived id and later start.
    const repeat = incident({
      id: "capabilities-4000",
      probe: "capabilities",
      startedAt: 4000,
      endedAt: null,
      note: "still degraded",
    });
    const r = reconcileIncidents({
      persisted: [original],
      derived: [repeat],
      limit: 50,
      nowMs: now,
      currentProbeStatus: new Map([["capabilities", "degraded"]]),
    });
    const ongoing = r.merged.filter((i) => i.endedAt == null);
    expect(ongoing).toHaveLength(1);
    expect(ongoing[0]).toMatchObject({ id: "capabilities-1000", startedAt: 1000, note: "still degraded" });
  });

  it("recovery closes the open episode", () => {
    const original = incident({ id: "money_path-1000", probe: "money_path", startedAt: 1000, endedAt: null });
    const recovered = incident({
      id: "money_path-4000",
      probe: "money_path",
      startedAt: 4000,
      endedAt: 8000,
      note: "recovered",
    });
    const r = reconcileIncidents({
      persisted: [original],
      derived: [recovered],
      limit: 50,
      nowMs: now,
      currentProbeStatus: new Map([["money_path", "ok"]]),
    });
    expect(r.merged.filter((i) => i.endedAt == null)).toHaveLength(0);
    expect(r.merged[0]).toMatchObject({ id: "money_path-1000", startedAt: 1000, endedAt: 8000 });
  });

  it("ongoing count equals the number of distinct degraded checks", () => {
    const persisted = [
      incident({ id: "capabilities-1", probe: "capabilities", startedAt: 1 }),
      incident({ id: "capabilities-2", probe: "capabilities", startedAt: 2 }),
      incident({ id: "money_path-1", probe: "money_path", startedAt: 1 }),
      incident({ id: "money_path-9", probe: "money_path", startedAt: 9 }),
    ];
    const r = reconcileIncidents({
      persisted,
      derived: [
        incident({ id: "capabilities-50", probe: "capabilities", startedAt: 50, note: "capabilities still down" }),
        incident({ id: "money_path-50", probe: "money_path", startedAt: 50, note: "money path still down" }),
      ],
      limit: 50,
      nowMs: now,
      currentProbeStatus: new Map([
        ["capabilities", "degraded"],
        ["money_path", "degraded"],
      ]),
    });
    const ongoing = r.merged.filter((i) => i.endedAt == null);
    expect(ongoing.map((i) => i.probe).sort()).toEqual(["capabilities", "money_path"]);
    expect(ongoing).toHaveLength(2);
  });

  it("one closed episode whose start slides from tick 5 through 40 stays one row", () => {
    // The ring forgets the original start, so each later tick derived a new id
    // with the same recovery instant. That minted 35 closed rows for one episode.
    let persisted = [
      incident({
        id: "money_path-5",
        probe: "money_path",
        severity: "degraded",
        startedAt: 5,
        endedAt: 40,
        note: "recovered",
      }),
    ];
    for (let start = 6; start <= 40; start += 1) {
      const derived = incident({
        id: `money_path-${start}`,
        probe: "money_path",
        severity: "degraded",
        startedAt: start,
        endedAt: 40,
        note: "recovered",
      });
      const r = reconcileIncidents({ persisted, derived: [derived], limit: 200, nowMs: 100 });
      persisted = r.merged;
      expect(r.writes.filter((row) => row.id !== "money_path-5")).toEqual([]);
    }
    expect(persisted.filter((row) => row.probe === "money_path")).toEqual([
      expect.objectContaining({ id: "money_path-5", startedAt: 5, endedAt: 40 }),
    ]);
  });

  it("drops duplicate opens instead of closing them at now", () => {
    const persisted = [
      incident({ id: "capabilities-1", probe: "capabilities", startedAt: 1, note: "first" }),
      incident({ id: "capabilities-2", probe: "capabilities", startedAt: 2, note: "dup" }),
      incident({ id: "capabilities-3", probe: "capabilities", startedAt: 3, note: "dup" }),
    ];
    const r = reconcileIncidents({
      persisted,
      derived: [incident({ id: "capabilities-50", probe: "capabilities", startedAt: 50, note: "still" })],
      limit: 50,
      nowMs: 10_000,
      currentProbeStatus: new Map([["capabilities", "degraded"]]),
    });
    expect(r.merged.map((row) => row.id)).toEqual(["capabilities-1"]);
    expect(r.merged.some((row) => row.endedAt === 10_000)).toBe(false);
    const dropped = r.writes.filter((row) => row.suppressed);
    expect(dropped.map((row) => row.id).sort()).toEqual(["capabilities-2", "capabilities-3"]);
    expect(dropped.every((row) => row.endedAt == null)).toBe(true);
  });

  it("keeps a red peak after the ring has only the current amber reading", () => {
    const persisted = [
      incident({
        id: "money_path-5",
        probe: "money_path",
        severity: "red",
        peakSeverity: "red",
        startedAt: 5,
        endedAt: null,
      }),
    ];
    const r = reconcileIncidents({
      persisted,
      derived: [
        incident({
          id: "money_path-80",
          probe: "money_path",
          severity: "degraded",
          peakSeverity: "degraded",
          startedAt: 80,
          endedAt: null,
          note: "eased",
        }),
      ],
      limit: 50,
      nowMs: 100,
      currentProbeStatus: new Map([["money_path", "degraded"]]),
    });
    expect(r.merged).toHaveLength(1);
    expect(r.merged[0]).toMatchObject({
      id: "money_path-5",
      startedAt: 5,
      severity: "degraded",
      peakSeverity: "red",
      note: "eased",
    });
  });

  it("keeps the open episode when closed history would fill the cap", () => {
    const open = incident({ id: "capabilities-1", probe: "capabilities", startedAt: 1, endedAt: null });
    const closed = Array.from({ length: 4 }, (_, i) =>
      incident({ id: `old-${i}`, probe: `old_${i}`, startedAt: 1000 + i, endedAt: 2000 + i }),
    );
    const r = reconcileIncidents({ persisted: [open, ...closed], derived: [], limit: 2, nowMs: now });
    expect(r.merged[0]).toMatchObject({ id: "capabilities-1", endedAt: null });
    expect(r.merged).toHaveLength(2);
  });
});

describe("incident log I/O", () => {
  it("round-trips a peak and a suppressed duplicate", async () => {
    const path = await tmpLog();
    await appendIncidents(
      [
        incident({ id: "kept", peakSeverity: "red", severity: "degraded" }),
        incident({ id: "dup", suppressed: true, note: "dropped duplicate of the open api_latency episode" }),
      ],
      { path },
    );
    const read = await readIncidents(path);
    expect(read.find((row) => row.id === "kept")).toMatchObject({ peakSeverity: "red", severity: "degraded" });
    expect(read.find((row) => row.id === "dup")?.suppressed).toBe(true);
  });

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
