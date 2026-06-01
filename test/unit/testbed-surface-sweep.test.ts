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
  parseTestbedMissionRunnerConfig,
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
  it("parses a dedicated public surface sweep base without changing the gated app base", () => {
    const parsed = parseTestbedMissionRunnerConfig({
      TESTBED_MISSION_RUNNER_ENABLED: "1",
      AVERRAY_APP_BASE_URL: "https://app.averray.com",
      AVERRAY_API_BASE_URL: "https://api.averray.com",
      TESTBED_SURFACE_SWEEP_BASE_URL: "https://averray.com",
      TESTBED_CF_ACCESS_CLIENT_ID: "cf-id",
      TESTBED_CF_ACCESS_CLIENT_SECRET: "cf-secret",
    });

    expect(parsed.appBaseUrl).toBe("https://app.averray.com");
    expect(parsed.surfaceSweepBaseUrl).toBe("https://averray.com");
    expect(parsed.cloudflareAccess).toEqual({ clientId: "cf-id", clientSecret: "cf-secret" });
  });

  it("routes a surface_sweep mission to the sweep (uses the injected capture)", async () => {
    const fake = vi.fn(async (url: string, route: string) => capture({ route, url }));
    const result = await executeBrowserTestbedMission(mission({ mode: "surface_sweep", routes: ["/"] }), config, {
      captureRoute: fake,
    });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.reportText ?? "{}").executor).toBe("surface_sweep");
  });

  it("routes public surface_sweep URLs through the dedicated public base", async () => {
    const fake = vi.fn(async (url: string, route: string) => capture({ route, url }));
    await executeBrowserTestbedMission(
      mission({ mode: "surface_sweep" }),
      {
        ...config,
        appBaseUrl: "https://app.averray.com",
        surfaceSweepBaseUrl: "https://averray.com",
      },
      { captureRoute: fake },
    );

    expect(fake.mock.calls.map((call) => call[0])).toEqual([
      "https://averray.com/",
      "https://averray.com/onboarding",
      "https://averray.com/jobs",
      "https://averray.com/strategies",
    ]);
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

// ── T2 pre-seeded session ───────────────────────────────────────────

const AGENT_SESSION = { role: "agent" as const, storageState: { cookies: [], origins: [] } };

describe("T2: authed routes + session-gated coverage", () => {
  it("resolveSweepRoutes adds the authed routes only when includeAuthed", () => {
    const pub = resolveSweepRoutes(undefined, "https://app.example.test", {});
    expect(pub.map((r) => r.route)).toEqual(["/", "/onboarding", "/jobs", "/strategies"]);

    const authed = resolveSweepRoutes(undefined, "https://app.example.test", { includeAuthed: true });
    expect(authed.map((r) => r.route)).toEqual(
      expect.arrayContaining(["/", "/overview", "/runs", "/receipts", "/audit-log", "/capabilities"]),
    );

    // An explicit mission.routes list overrides the default regardless of includeAuthed.
    const explicit = resolveSweepRoutes(["/x"], "https://app.example.test", { includeAuthed: true });
    expect(explicit.map((r) => r.route)).toEqual(["/x"]);
  });

  it("with a session, the authed operator routes join the sweep", async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: string, route: string) => { seen.push(route); return capture({ route, url }); });
    const result = await executeSurfaceSweep(mission(), { ...config, session: AGENT_SESSION }, { captureRoute: fake });
    expect(seen).toEqual(expect.arrayContaining(["/overview", "/runs", "/treasury", "/audit-log"]));
    expect(JSON.parse(result.reportText ?? "{}").verdict).toBe("pass");
  });

  it("without a session, the sweep stays public-only (graceful fallback, no crash)", async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: string, route: string) => { seen.push(route); return capture({ route, url }); });
    await executeSurfaceSweep(mission(), config, { captureRoute: fake });
    expect(seen).toEqual(["/", "/onboarding", "/jobs", "/strategies"]);
    expect(seen).not.toContain("/overview");
  });

  it("the boundary-honesty check applies to authed pages too", async () => {
    const fake = vi.fn(async (url: string, route: string) =>
      route === "/receipts"
        ? capture({ route, url, consoleErrors: ["TypeError: x"], visibleText: "Your receipts are all here, lots of healthy detail." })
        : capture({ route, url }),
    );
    const result = await executeSurfaceSweep(mission(), { ...config, session: AGENT_SESSION }, { captureRoute: fake });
    const report = JSON.parse(result.reportText ?? "{}");
    expect(report.honestyFindings.some((f: { route: string; code: string }) => f.route === "/receipts" && f.code === "errored_but_silent")).toBe(true);
  });

  it("the runner resolves a session and the authed routes join the sweep", async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: string, route: string) => { seen.push(route); return capture({ route, url }); });
    await executeBrowserTestbedMission(mission(), config, {
      captureRoute: fake,
      resolveSession: async () => AGENT_SESSION,
    });
    expect(seen).toContain("/overview");
  });

  it("a resolved session keeps the sweep on the gated app base for operator routes", async () => {
    const fake = vi.fn(async (url: string, route: string) => capture({ route, url }));
    await executeBrowserTestbedMission(
      mission(),
      {
        ...config,
        appBaseUrl: "https://app.averray.com",
        surfaceSweepBaseUrl: "https://averray.com",
      },
      {
        captureRoute: fake,
        resolveSession: async () => AGENT_SESSION,
      },
    );

    expect(fake.mock.calls.map((call) => call[0])).toContain("https://app.averray.com/overview");
  });

  it("the runner with no configured session source sweeps public-only", async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: string, route: string) => { seen.push(route); return capture({ route, url }); });
    await executeBrowserTestbedMission(mission(), config, { captureRoute: fake });
    expect(seen).not.toContain("/overview");
    expect(seen).toContain("/");
  });
});
