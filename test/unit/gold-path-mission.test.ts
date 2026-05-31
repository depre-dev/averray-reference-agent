import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOLD_PATH_STEPS,
  pickGoldPathModel,
  judgeGoldPath,
  runGoldPathMissionOnce,
  createScriptedGoldPathDriver,
  createUnavailableGoldPathDriver,
  type GoldPathObservation,
  type GoldPathStepResult,
} from "../../services/slack-operator/src/gold-path-mission.js";
import { runGoldPathMissionEntry } from "../../services/slack-operator/src/gold-path-mission-entry.js";
import { resolveTestbedMutationBinding, type TestbedMutationBinding } from "../../services/slack-operator/src/testbed-mutation-binding.js";

function obs(steps: GoldPathStepResult[], over: Partial<GoldPathObservation> = {}): GoldPathObservation {
  return { steps, notes: [], mutationsAttempted: [], stoppedBeforeMutation: true, ...over };
}

// ── A4 model policy ─────────────────────────────────────────────────

describe("pickGoldPathModel — Sonnet routine / Opus deep (A4)", () => {
  it("defaults to sonnet", () => {
    expect(pickGoldPathModel()).toBe("sonnet");
    expect(pickGoldPathModel({ riskTier: "low" })).toBe("sonnet");
  });
  it("deep or high-risk → opus", () => {
    expect(pickGoldPathModel({ deep: true })).toBe("opus");
    expect(pickGoldPathModel({ riskTier: "high" })).toBe("opus");
  });
  it("operator override wins either way", () => {
    expect(pickGoldPathModel({ deep: true, override: "sonnet" })).toBe("sonnet");
    expect(pickGoldPathModel({ override: "opus" })).toBe("opus");
    expect(pickGoldPathModel({ override: "nonsense" })).toBe("sonnet");
  });
});

// ── honest judge ────────────────────────────────────────────────────

describe("judgeGoldPath — never fakes a pass", () => {
  const all = (status: GoldPathStepResult["status"]) =>
    GOLD_PATH_STEPS.map((step) => ({ step, status, detail: `${step} ${status}` }));

  it("all clean → pass", () => {
    expect(judgeGoldPath(obs(all("ok")), { allowMutations: true }).verdict).toBe("pass");
  });
  it("a blocked required step → fail (cannot pass with a blocker)", () => {
    const steps = all("ok");
    steps[2] = { step: "claim", status: "blocked", detail: "claim button 500s" };
    const j = judgeGoldPath(obs(steps), { allowMutations: true });
    expect(j.verdict).toBe("fail");
    expect(j.blockers.join(" ")).toMatch(/claim/);
  });
  it("a degraded surface → partial (honest, but not clean)", () => {
    const steps = all("ok");
    steps[1] = { step: "discover", status: "degraded", detail: "jobs list shows stale data banner" };
    expect(judgeGoldPath(obs(steps), { allowMutations: true }).verdict).toBe("partial");
  });
  it("an empty surface → partial", () => {
    const steps = all("ok");
    steps[1] = { step: "discover", status: "empty", detail: "no jobs and no empty-state label" };
    expect(judgeGoldPath(obs(steps), { allowMutations: true }).verdict).toBe("partial");
  });
  it("read-only run: skipping mutating steps is EXPECTED → still pass", () => {
    const steps = GOLD_PATH_STEPS.map((step) =>
      (step === "claim" || step === "submit" || step === "payout_sbt")
        ? { step, status: "skipped" as const, detail: "read-only" }
        : { step, status: "ok" as const, detail: "ok" },
    );
    expect(judgeGoldPath(obs(steps), { allowMutations: false }).verdict).toBe("pass");
  });
  it("crossing a mutation boundary while read-only → fail (hard fault)", () => {
    const j = judgeGoldPath(obs(all("ok"), { stoppedBeforeMutation: false }), { allowMutations: false });
    expect(j.verdict).toBe("fail");
    expect(j.blockers.join(" ")).toMatch(/mutation while the mission was read-only/i);
  });
});

// ── orchestrator + structural mainnet read-only ─────────────────────

const TESTNET: TestbedMutationBinding = resolveTestbedMutationBinding({
  mode: "gold_path",
  configuredEnvironment: "testnet",
  requestedAllowTestMutations: true,
});
const MAINNET: TestbedMutationBinding = resolveTestbedMutationBinding({
  mode: "gold_path",
  configuredEnvironment: "mainnet",
  requestedAllowTestMutations: true,
});

describe("runGoldPathMissionOnce", () => {
  const mission = { id: "gp-1", targetUrl: "https://app.testnet.example", goal: "gold path", freshMemory: true };

  it("testnet + requested mutations → mutating steps run, report carries the shape", async () => {
    const result = await runGoldPathMissionOnce({
      mission,
      binding: TESTNET,
      driver: createScriptedGoldPathDriver(),
      model: "sonnet",
    });
    expect(result.verdict).toBe("pass");
    const r = result.report;
    expect(r.executor).toBe("gold_path");
    expect(r.mode).toBe("gold_path");
    expect(r.mutationMode).toBe("testbed_mutation_allowed");
    expect(r.environment).toBe("testnet");
    expect(Array.isArray(r.mutationsAttempted) && (r.mutationsAttempted as unknown[]).length).toBeGreaterThan(0);
    expect(r.stoppedBeforeMutation).toBe(true);
    expect(typeof r.summary).toBe("string");
    expect(Array.isArray(r.completedPath)).toBe(true);
    expect(r.scores).toBeTruthy();
  });

  it("MAINNET + requested mutations → STRUCTURALLY read-only (no mutation attempted)", async () => {
    expect(MAINNET.mutationMode).toBe("read_only");
    expect(MAINNET.allowTestMutations).toBe(false);
    // Even with an all-"ok" scripted driver, the binding forbids mutation, so
    // the mutating steps are skipped and nothing is mutated.
    const result = await runGoldPathMissionOnce({
      mission: { ...mission, targetUrl: "https://app.averray.com" },
      binding: MAINNET,
      driver: createScriptedGoldPathDriver(),
      model: "sonnet",
    });
    const r = result.report;
    expect(r.mutationMode).toBe("read_only");
    expect(r.stoppedBeforeMutation).toBe(true);
    expect((r.mutationsAttempted as unknown[]).length).toBe(0);
    // The mutating steps are recorded as skipped (read-only), not failed.
    const steps = r.steps as GoldPathStepResult[];
    expect(steps.find((s) => s.step === "claim")?.status).toBe("skipped");
    expect(result.verdict).toBe("pass"); // read-only journey was clean + honest
  });

  it("a blocked step from the driver → fail verdict in the report", async () => {
    const result = await runGoldPathMissionOnce({
      mission,
      binding: TESTNET,
      driver: createScriptedGoldPathDriver([{ step: "verify", status: "blocked", detail: "verify endpoint 500" }]),
      model: "opus",
    });
    expect(result.verdict).toBe("fail");
    expect((result.report.blockers as string[]).join(" ")).toMatch(/verif/i);
  });

  it("unavailable driver (no live LLM wired) → honest FAIL, never a fake pass", async () => {
    const result = await runGoldPathMissionOnce({
      mission,
      binding: TESTNET,
      driver: createUnavailableGoldPathDriver("live driver not wired"),
      model: "sonnet",
    });
    expect(result.verdict).toBe("fail");
    expect((result.report.summary as string)).toMatch(/gold_path fail/);
  });
});

// ── entry: env → binding → orchestrator (mainnet stays read-only) ───

describe("runGoldPathMissionEntry — env wiring keeps mainnet read-only", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "averray-goldpath-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("mainnet env + requested mutations + all-ok driver → no mutation, read-only report", async () => {
    const result = await runGoldPathMissionEntry(
      {
        TESTBED_MISSION_ID: "gp-entry-1",
        TESTBED_TARGET_URL: "https://app.averray.com",
        TESTBED_MISSION_GOAL: "gold path",
        TESTBED_MISSION_ENVIRONMENT: "mainnet",
        TESTBED_REQUESTED_TEST_MUTATIONS: "true",
        TESTBED_MISSION_REPORT_PATH: join(dir, "report.json"),
      } as NodeJS.ProcessEnv,
      { driver: createScriptedGoldPathDriver() },
    );
    expect(result.report.environment).toBe("mainnet");
    expect(result.report.mutationMode).toBe("read_only");
    expect((result.report.mutationsAttempted as unknown[]).length).toBe(0);
    expect(result.report.stoppedBeforeMutation).toBe(true);
  });
});
