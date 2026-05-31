import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateAnomalies,
  decideAnomalyAction,
  summarizeTrips,
  buildAnomalyAlert,
  runAnomalyPauseOnce,
  touchHaltFile,
  isHaltFilePresent,
  type AnomalyConfig,
  type AnomalySignals,
  type AnomalyPauseDeps,
} from "../../services/slack-operator/src/anomaly-pause.js";
import {
  readAutopilotSuspendState,
  isAutopilotSuspended,
  setAutopilotSuspended,
  clearAutopilotSuspended,
} from "../../services/slack-operator/src/autopilot-state.js";
import type { AlertPayload } from "../../services/slack-operator/src/alert-bridge.js";

const CONFIG: AnomalyConfig = {
  taskRetrySoft: 3,
  taskRunawayHard: 6,
  failingTasksHard: 3,
  budgetSpikeRatio: 0.8,
  budgetBlowoutRatio: 1.0,
  heartbeatGapSec: 600,
};

// Normal, healthy load — should never trip.
const QUIET: AnomalySignals = {
  maxTaskAttemptCount: 1,
  failingTaskCount: 0,
  hermesTasksToday: 2,
  perDayCap: 10,
  runnerHeartbeatAgeSec: 30,
};

describe("evaluateAnomalies — each signal trips at its threshold, not below", () => {
  it("no false positives under normal load", () => {
    expect(evaluateAnomalies(QUIET, CONFIG).tier).toBe("none");
  });

  it("task retry loop: soft at the soft threshold, not one below", () => {
    expect(evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 2 }, CONFIG).tier).toBe("none");
    const e = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 3 }, CONFIG);
    expect(e.tier).toBe("soft");
    expect(e.trips.map((t) => t.signal)).toContain("task_retry_loop");
  });

  it("single-task runaway: hard at the hard threshold (and never double-counts as soft)", () => {
    const e = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 6 }, CONFIG);
    expect(e.tier).toBe("hard");
    const signals = e.trips.map((t) => t.signal);
    expect(signals).toContain("task_runaway");
    expect(signals).not.toContain("task_retry_loop");
  });

  it("multi-task runaway: hard when enough tasks are failing", () => {
    expect(evaluateAnomalies({ ...QUIET, failingTaskCount: 2 }, CONFIG).tier).toBe("none");
    const e = evaluateAnomalies({ ...QUIET, failingTaskCount: 3 }, CONFIG);
    expect(e.tier).toBe("hard");
    expect(e.trips.map((t) => t.signal)).toContain("multi_task_runaway");
  });

  it("budget spike: soft at ≥80% of cap; blowout: hard at ≥100%", () => {
    expect(evaluateAnomalies({ ...QUIET, hermesTasksToday: 7 }, CONFIG).tier).toBe("none"); // 70%
    const spike = evaluateAnomalies({ ...QUIET, hermesTasksToday: 8 }, CONFIG); // 80%
    expect(spike.tier).toBe("soft");
    expect(spike.trips.map((t) => t.signal)).toContain("budget_spike");
    const blowout = evaluateAnomalies({ ...QUIET, hermesTasksToday: 10 }, CONFIG); // 100%
    expect(blowout.tier).toBe("hard");
    expect(blowout.trips.map((t) => t.signal)).toContain("budget_blowout");
  });

  it("budget signals are inert when the cap is unknown (0)", () => {
    expect(evaluateAnomalies({ ...QUIET, perDayCap: 0, hermesTasksToday: 99 }, CONFIG).tier).toBe("none");
  });

  it("runner heartbeat gap: soft when stale, ignored when the age is unknown", () => {
    expect(evaluateAnomalies({ ...QUIET, runnerHeartbeatAgeSec: 599 }, CONFIG).tier).toBe("none");
    const e = evaluateAnomalies({ ...QUIET, runnerHeartbeatAgeSec: 600 }, CONFIG);
    expect(e.tier).toBe("soft");
    expect(e.trips.map((t) => t.signal)).toContain("runner_heartbeat_gap");
    const { runnerHeartbeatAgeSec, ...noHeartbeat } = QUIET;
    expect(evaluateAnomalies(noHeartbeat, CONFIG).tier).toBe("none");
  });

  it("hard wins over a co-occurring soft", () => {
    const e = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 3, failingTaskCount: 3 }, CONFIG);
    expect(e.tier).toBe("hard");
  });
});

describe("decideAnomalyAction — de-dup", () => {
  const soft = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 3 }, CONFIG);
  const hard = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 6 }, CONFIG);
  const none = evaluateAnomalies(QUIET, CONFIG);

  it("a soft trip acts once, then is suppressed while already suspended", () => {
    expect(decideAnomalyAction(soft, false)).toBe("soft");
    expect(decideAnomalyAction(soft, true)).toBe("none");
  });

  it("a hard trip always acts (the caller skips when HALT is already present)", () => {
    expect(decideAnomalyAction(hard, false)).toBe("hard");
    expect(decideAnomalyAction(hard, true)).toBe("hard");
  });

  it("none stays none", () => {
    expect(decideAnomalyAction(none, false)).toBe("none");
  });
});

describe("buildAnomalyAlert", () => {
  it("hard alert names the HALT; soft alert names the suspension; both link the board", () => {
    const hard = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 6 }, CONFIG);
    const hardAlert = buildAnomalyAlert(hard, "hard", "https://board.example/monitor");
    expect(hardAlert.text).toMatch(/HALT_FILE/);
    expect(hardAlert.text).toContain("https://board.example/monitor");

    const soft = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 3 }, CONFIG);
    const softAlert = buildAnomalyAlert(soft, "soft", "https://board.example/monitor");
    expect(softAlert.text).toMatch(/suspend/i);
  });
});

// ── orchestrator with injected effects (no fs/network) ───────────────

interface Harness {
  deps: AnomalyPauseDeps;
  alerts: AlertPayload[];
  audits: Array<{ tier: string; action: string; signals: string; reason: string }>;
  suspended: { current: boolean; info?: { reason: string; signal: string; tier: "soft" | "hard"; setAt: string } };
  halt: { touched: boolean; reason?: string };
}

function harness(signals: AnomalySignals, over: Partial<AnomalyPauseDeps> = {}): Harness {
  const alerts: Harness["alerts"] = [];
  const audits: Harness["audits"] = [];
  const suspended: Harness["suspended"] = { current: false };
  const halt: Harness["halt"] = { touched: false };
  const deps: AnomalyPauseDeps = {
    config: CONFIG,
    getSignals: () => signals,
    isHaltPresent: () => halt.touched,
    isSuspended: () => suspended.current,
    setSuspended: (info) => {
      suspended.current = true;
      suspended.info = info;
    },
    touchHalt: (reason) => {
      halt.touched = true;
      halt.reason = reason;
    },
    alert: async (payload) => {
      alerts.push(payload);
      return true;
    },
    audit: (record) => {
      audits.push(record);
    },
    boardUrl: "https://board.example/monitor",
    now: () => new Date("2026-05-31T12:00:00.000Z"),
    ...over,
  };
  return { deps, alerts, audits, suspended, halt };
}

describe("runAnomalyPauseOnce — tiered action", () => {
  it("a soft trip suspends autopilot + alerts + audits, but does NOT touch HALT", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 3 });
    const r = await runAnomalyPauseOnce(h.deps);
    expect(r.action).toBe("soft");
    expect(h.suspended.current).toBe(true);
    expect(h.suspended.info?.tier).toBe("soft");
    expect(h.suspended.info?.setAt).toBe("2026-05-31T12:00:00.000Z");
    expect(h.halt.touched).toBe(false);
    expect(h.alerts).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("a hard trip touches HALT_FILE AND suspends + alerts + audits", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 6 });
    const r = await runAnomalyPauseOnce(h.deps);
    expect(r.action).toBe("hard");
    expect(h.halt.touched).toBe(true);
    expect(h.halt.reason).toMatch(/D3 hard anomaly trip/);
    expect(h.suspended.current).toBe(true);
    expect(h.suspended.info?.tier).toBe("hard");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toMatch(/HALT_FILE/);
  });

  it("does nothing under normal load", async () => {
    const h = harness(QUIET);
    const r = await runAnomalyPauseOnce(h.deps);
    expect(r.action).toBe("none");
    expect(h.suspended.current).toBe(false);
    expect(h.halt.touched).toBe(false);
    expect(h.alerts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("de-dup: a soft trip does not re-fire while already suspended", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 3 });
    h.suspended.current = true; // pretend a prior soft trip set it
    const r = await runAnomalyPauseOnce(h.deps);
    expect(r.action).toBe("none");
    expect(h.alerts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("respects HALT_FILE: if already halted, it short-circuits with no new effects", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 6 });
    h.halt.touched = true; // HALT already present
    const r = await runAnomalyPauseOnce(h.deps);
    expect(r.action).toBe("halted");
    expect(h.alerts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.suspended.current).toBe(false);
  });

  it("audit record carries the signal, tier, and threshold detail", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 6 });
    await runAnomalyPauseOnce(h.deps);
    const rec = h.audits[0]!;
    expect(rec).toMatchObject({ tier: "hard", action: "hard" });
    expect(rec.signals).toMatch(/hard:task_runaway/);
    expect(rec.reason).toMatch(/attempt #6/);
  });

  it("re-evaluates after an operator resume: a still-present soft condition trips again", async () => {
    const h = harness({ ...QUIET, maxTaskAttemptCount: 3 });
    await runAnomalyPauseOnce(h.deps); // first soft trip
    expect(h.alerts).toHaveLength(1);
    h.suspended.current = false; // operator resumed
    await runAnomalyPauseOnce(h.deps); // condition persists → trips again
    expect(h.alerts).toHaveLength(2);
  });

  it("summarizeTrips renders signal + threshold without secrets", () => {
    const e = evaluateAnomalies({ ...QUIET, maxTaskAttemptCount: 6 }, CONFIG);
    const { reason, signals } = summarizeTrips(e);
    expect(reason).toContain("task_runaway");
    expect(signals).toContain("hard:task_runaway");
  });
});

// ── file-backed state (real temp dir, no /data, no network) ──────────

describe("autopilot-suspended flag — set by D3, cleared by the operator, survives a read", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-d3-state-"));
    statePath = join(dir, "autopilot-suspended.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to not-suspended when no file exists", () => {
    expect(isAutopilotSuspended(statePath)).toBe(false);
    expect(readAutopilotSuspendState(statePath)).toEqual({ suspended: false });
  });

  it("set then read round-trips the trip metadata", () => {
    setAutopilotSuspended(
      { reason: "task_runaway: a task reached attempt #6", signal: "hard:task_runaway", tier: "hard", setAt: "2026-05-31T12:00:00.000Z" },
      statePath,
    );
    expect(isAutopilotSuspended(statePath)).toBe(true);
    const state = readAutopilotSuspendState(statePath);
    expect(state).toMatchObject({ suspended: true, tier: "hard", signal: "hard:task_runaway" });
  });

  it("operator-resume clears the flag", () => {
    setAutopilotSuspended({ reason: "r", signal: "soft:budget_spike", tier: "soft", setAt: "2026-05-31T12:00:00.000Z" }, statePath);
    expect(isAutopilotSuspended(statePath)).toBe(true);
    clearAutopilotSuspended(statePath);
    expect(isAutopilotSuspended(statePath)).toBe(false);
  });

  it("clearing an already-absent flag is a no-op (idempotent)", () => {
    expect(() => clearAutopilotSuspended(statePath)).not.toThrow();
    expect(isAutopilotSuspended(statePath)).toBe(false);
  });

  it("an unreadable/corrupt state reads as not-suspended (never throws)", async () => {
    await rm(statePath, { force: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, "{ not json");
    expect(isAutopilotSuspended(statePath)).toBe(false);
  });
});

describe("HALT_FILE helpers — same path the kill switch reads", () => {
  let dir: string;
  let haltPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-d3-halt-"));
    haltPath = join(dir, "nested", "HALT");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("touch creates the file (and parent dirs); presence check sees it", async () => {
    expect(isHaltFilePresent(haltPath)).toBe(false);
    touchHaltFile("D3 hard anomaly trip: test", haltPath);
    expect(existsSync(haltPath)).toBe(true);
    expect(isHaltFilePresent(haltPath)).toBe(true);
    expect(await readFile(haltPath, "utf8")).toMatch(/D3 hard anomaly trip/);
  });
});
