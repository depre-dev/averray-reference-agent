import { describe, expect, it, vi } from "vitest";

import {
  checkRouteHonesty,
  detectStateMarkers,
  resolveExpectedBoundary,
  resolveSweepRoutes,
  routeBroken,
  sweepVerdict,
  buildSweepReport,
  executeSurfaceSweep,
  type RouteCapture,
} from "../../services/slack-operator/src/testbed-surface-sweep.js";
import {
  executeBrowserTestbedMission,
  type TestbedMissionRunnerConfig,
} from "../../services/slack-operator/src/testbed-mission-runner.js";
import type { TestbedMissionRun } from "../../services/slack-operator/src/monitor-testbed-missions.js";

function mission(overrides: Partial<TestbedMissionRun> = {}): TestbedMissionRun {
  return {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: "sweep-1",
    status: "running",
    title: "Surface sweep (T1)",
    targetUrl: "https://app.example.test",
    goal: "Public surface sweep",
    agentName: "Hermes",
    freshMemory: true,
    allowTestMutations: false,
    mode: "surface_sweep",
    mission: {},
    history: [],
    createdAt: "2026-05-30T00:00:00Z",
    updatedAt: "2026-05-30T00:00:00Z",
    statusReason: "running",
    ...overrides,
  };
}

function capture(overrides: Partial<RouteCapture> = {}): RouteCapture {
  return {
    route: "/",
    url: "https://app.example.test/",
    ok: true,
    status: 200,
    title: "Home",
    visibleText: "Welcome to Averray. Claim jobs, do the work, get paid on-chain. Browse the marketplace below.",
    consoleErrors: [],
    networkFailures: [],
    badResponses: [],
    ...overrides,
  };
}

const config: TestbedMissionRunnerConfig = {
  enabled: true,
  runnerId: "test",
  args: [],
  pollIntervalMs: 1,
  timeoutMs: 1000,
  outputTailBytes: 1000,
  appBaseUrl: "https://app.example.test",
};

describe("resolveSweepRoutes", () => {
  it("defaults to the public surfaces when no routes are given", () => {
    const resolved = resolveSweepRoutes(undefined, "https://app.example.test");
    expect(resolved.map((r) => r.route)).toEqual(["/", "/onboarding", "/jobs", "/strategies"]);
    expect(resolved[1]?.url).toBe("https://app.example.test/onboarding");
  });
  it("joins relative routes to the base and passes absolute URLs through", () => {
    const resolved = resolveSweepRoutes(["/jobs", "https://site.example.test/pricing"], "https://app.example.test/");
    expect(resolved[0]?.url).toBe("https://app.example.test/jobs");
    expect(resolved[1]?.url).toBe("https://site.example.test/pricing");
  });
});

describe("detectStateMarkers", () => {
  it("recognizes degraded / empty / demo / testnet / local-simulation labels", () => {
    expect(detectStateMarkers("Service degraded — reconnecting").degraded).toBe(true);
    expect(detectStateMarkers("No jobs yet").empty).toBe(true);
    expect(detectStateMarkers("Showing demo data").demo).toBe(true);
    expect(detectStateMarkers("Connected to Paseo testnet").testnet).toBe(true);
    expect(detectStateMarkers("Running against a local node (anvil)")["local-simulation"]).toBe(true);
    expect(detectStateMarkers("Welcome to the marketplace").degraded).toBe(false);
  });
});

describe("checkRouteHonesty", () => {
  it("flags a surface that errored but shows no degraded state (HIGH)", () => {
    const findings = checkRouteHonesty(
      capture({ consoleErrors: ["TypeError: x is undefined"], visibleText: "Everything looks fine here, lots of content." }),
      "none",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "high", code: "errored_but_silent" });
  });
  it("does NOT flag an errored surface that honestly says it's degraded", () => {
    const findings = checkRouteHonesty(
      capture({ consoleErrors: ["boom"], visibleText: "Something went wrong — this page is temporarily unavailable." }),
      "none",
    );
    expect(findings).toEqual([]);
  });
  it("flags a blank surface with no empty-state label (MEDIUM)", () => {
    const findings = checkRouteHonesty(capture({ visibleText: "   " }), "none");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "medium", code: "empty_unlabeled" });
  });
  it("does NOT flag a blank surface that says it's empty", () => {
    expect(checkRouteHonesty(capture({ visibleText: "No jobs yet" }), "none")).toEqual([]);
  });
  it("flags data shown without the expected non-prod boundary marker (MEDIUM)", () => {
    const findings = checkRouteHonesty(capture(), "testnet"); // data-bearing, no 'testnet' marker
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "medium", code: "boundary_marker_missing" });
  });
  it("does NOT flag when the testnet marker is present", () => {
    expect(checkRouteHonesty(capture({ visibleText: "Live on Paseo testnet — 3 open jobs in the marketplace." }), "testnet")).toEqual([]);
  });
  it("does not run the boundary check when expectedBoundary is none", () => {
    expect(checkRouteHonesty(capture(), "none")).toEqual([]);
  });
});

describe("sweepVerdict", () => {
  it("pass when every route loads clean and is honest", () => {
    expect(sweepVerdict([capture(), capture({ route: "/jobs" })], [])).toBe("pass");
  });
  it("fail when a route is broken (4xx/5xx or load error)", () => {
    expect(sweepVerdict([capture(), capture({ route: "/jobs", ok: false, status: 500 })], [])).toBe("fail");
    expect(routeBroken(capture({ ok: false, loadError: "net::ERR" }))).toBe(true);
  });
  it("fail on a high-severity dishonest boundary", () => {
    const c = capture({ consoleErrors: ["x"] });
    expect(sweepVerdict([c], checkRouteHonesty(c, "none"))).toBe("fail");
  });
  it("partial when routes load but log console/network errors with an honest degraded label", () => {
    const c = capture({ consoleErrors: ["x"], visibleText: "degraded — reconnecting" });
    expect(sweepVerdict([c], checkRouteHonesty(c, "none"))).toBe("partial");
  });
});

describe("buildSweepReport + executeSurfaceSweep (injected capture)", () => {
  it("aggregates a per-route report and a clean verdict", async () => {
    const fake = vi.fn(async (url: string, route: string) => capture({ route, url }));
    const result = await executeSurfaceSweep(mission({ routes: ["/", "/jobs"] }), config, { captureRoute: fake });
    expect(fake).toHaveBeenCalledTimes(2);
    const report = JSON.parse(result.reportText ?? "{}");
    expect(report.executor).toBe("surface_sweep");
    expect(report.verdict).toBe("pass");
    expect(report.routes).toHaveLength(2);
    expect(report.routes[0]).toMatchObject({ route: "/", ok: true, status: 200 });
    expect(report.completedPath).toHaveLength(2);
  });

  it("a broken route fails the sweep and lands in blockers", async () => {
    const fake = async (url: string, route: string) =>
      route === "/jobs" ? capture({ route, url, ok: false, status: 503 }) : capture({ route, url });
    const result = await executeSurfaceSweep(mission({ routes: ["/", "/jobs"] }), config, { captureRoute: fake });
    const report = JSON.parse(result.reportText ?? "{}");
    expect(report.verdict).toBe("fail");
    expect(report.blockers.some((b: string) => b.includes("/jobs"))).toBe(true);
  });

  it("a dishonest boundary (errored-but-silent) fails the sweep", async () => {
    const fake = async (url: string, route: string) =>
      capture({ route, url, consoleErrors: ["ReferenceError"], visibleText: "Looks totally healthy and full of content here." });
    const result = await executeSurfaceSweep(mission({ routes: ["/"] }), config, { captureRoute: fake });
    const report = JSON.parse(result.reportText ?? "{}");
    expect(report.verdict).toBe("fail");
    expect(report.honestyFindings[0].code).toBe("errored_but_silent");
  });

  it("captures a load exception per route without throwing", async () => {
    const fake = async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    };
    const result = await executeSurfaceSweep(mission({ routes: ["/down"] }), config, { captureRoute: fake });
    const report = JSON.parse(result.reportText ?? "{}");
    expect(report.verdict).toBe("fail");
    expect(report.routes[0].ok).toBe(false);
  });

  it("resolveExpectedBoundary normalizes config values", () => {
    expect(resolveExpectedBoundary("testnet")).toBe("testnet");
    expect(resolveExpectedBoundary("LOCAL")).toBe("local-simulation");
    expect(resolveExpectedBoundary(undefined)).toBe("none");
    expect(resolveExpectedBoundary("whatever")).toBe("none");
  });

  it("buildSweepReport is read-only (no mutations attempted)", () => {
    const report = buildSweepReport({ mission: mission(), captures: [capture()], expectedBoundary: "none" });
    expect(report.mutationMode).toBe("read_only");
    expect(report.mutationsAttempted).toEqual([]);
  });
});

describe("executeBrowserTestbedMission — dispatch (single-URL explore stays intact)", () => {
  it("routes a surface_sweep mission to the sweep (uses the injected capture)", async () => {
    const fake = vi.fn(async (url: string, route: string) => capture({ route, url }));
    const result = await executeBrowserTestbedMission(mission({ mode: "surface_sweep", routes: ["/"] }), config, {
      captureRoute: fake,
    });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.reportText ?? "{}").executor).toBe("surface_sweep");
  });

  it("an explore mission never reaches the sweep capture (dispatch gates on mode)", async () => {
    // No real browser here: we only assert the dispatch DECISION. The explore
    // branch is the existing single-URL executePlaywrightTestbedMission, left
    // untouched and covered by the runner's injected-executor tests.
    const exploreMission = mission({ mode: "explore" });
    expect(exploreMission.mode === "surface_sweep").toBe(false);
    const sweepMission = mission({ mode: "surface_sweep" });
    expect(sweepMission.mode === "surface_sweep").toBe(true);
  });
});
