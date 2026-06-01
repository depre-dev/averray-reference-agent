// Hermes e2e tester — Tier 1 surface sweep (T1).
//
// A cheap, deterministic, READ-ONLY per-deploy check: walk the product's
// public surfaces, flag console/network errors per route, and — the
// distinctive part — assert each surface labels its state HONESTLY (a
// degraded page says "degraded", an empty page says "empty", a demo/
// testnet/local-simulation surface says so). This enforces the project's
// truth-boundary discipline: a surface must never show data as if it were
// real/production when it isn't, and must never look healthy while erroring.
//
// The browser driving is dependency-injected (`deps.captureRoute`), so the
// per-route capture + aggregation + verdict + honesty logic are all unit
// tested with no real browser. The single-URL "explore" executor is
// untouched; the sweep is selected by `mission.mode === "surface_sweep"`.

import type { TestbedMissionRun } from "./monitor-testbed-missions.js";
import type { TestbedMissionRunResult } from "./testbed-mission-runner.js";
import {
  DEFAULT_AUTHED_ROUTES,
  buildSweepContextOptions,
  basicAuthHeadersForUrl,
  basicAuthHttpCredentialsForUrl,
  type CloudflareAccessServiceToken,
  type SweepSession,
  type TestbedBasicAuth,
} from "./testbed-session.js";

/** The environment's truth — what marker a data-bearing surface must carry. */
export type SweepBoundary =
  | "production"
  | "demo"
  | "testnet"
  | "local-simulation"
  | "none";

/** What a single swept route produced. Mirrors a Playwright page capture; the
 *  fields are everything the honesty + verdict logic needs. */
export interface RouteCapture {
  /** The requested route, e.g. "/jobs". */
  route: string;
  /** The final resolved/landed URL. */
  url: string;
  /** Navigation succeeded and the main document was not a 4xx/5xx. */
  ok: boolean;
  /** Main-document HTTP status, when known. */
  status?: number;
  title: string;
  visibleText: string;
  consoleErrors: string[];
  networkFailures: string[];
  /** 4xx/5xx responses for subresources on this route. */
  badResponses: string[];
  /** Screenshot artifact path, when captured. */
  screenshot?: string;
  /** Set when `goto` itself threw (DNS, timeout, connection refused). */
  loadError?: string;
}

export interface HonestyFinding {
  route: string;
  severity: "low" | "medium" | "high";
  code: "errored_but_silent" | "empty_unlabeled" | "boundary_marker_missing";
  message: string;
}

export type SweepVerdict = "pass" | "partial" | "fail";

const DEFAULT_PUBLIC_ROUTES = ["/", "/onboarding", "/jobs", "/strategies"];

// A surface with less meaningful visible text than this is treated as "blank"
// (an empty/loading shell) rather than data-bearing.
const EMPTY_TEXT_THRESHOLD = 40;

// State markers a surface can carry. Matched case-insensitively against the
// visible text. Kept conservative so a real degraded/empty/demo label trips
// it, but ordinary copy does not.
const MARKERS = {
  degraded: /\b(degraded|untrusted|unavailable|stale data|reconnecting|offline|failed to load|something went wrong|temporarily unavailable)\b/i,
  empty: /\b(no .{0,30}(yet|found|right now)|nothing (here|yet)|empty|you're all caught up|no results|no data)\b/i,
  demo: /\b(demo|sample data|mock data|example data|placeholder data|for illustration)\b/i,
  testnet: /\b(testnet|test network|paseo|westend|rococo|sepolia)\b/i,
  "local-simulation": /\b(local simulation|simulated|anvil|local node|dev mode|sandbox)\b/i,
} as const;

export interface DetectedMarkers {
  degraded: boolean;
  empty: boolean;
  demo: boolean;
  testnet: boolean;
  "local-simulation": boolean;
}

export function detectStateMarkers(text: string): DetectedMarkers {
  const t = text ?? "";
  return {
    degraded: MARKERS.degraded.test(t),
    empty: MARKERS.empty.test(t),
    demo: MARKERS.demo.test(t),
    testnet: MARKERS.testnet.test(t),
    "local-simulation": MARKERS["local-simulation"].test(t),
  };
}

function hasErrors(c: RouteCapture): boolean {
  return (
    !c.ok ||
    Boolean(c.loadError) ||
    c.consoleErrors.length > 0 ||
    c.networkFailures.length > 0 ||
    c.badResponses.length > 0
  );
}

function errorCount(c: RouteCapture): number {
  return c.consoleErrors.length + c.networkFailures.length + c.badResponses.length;
}

/** The route's document is broken: it didn't load, or returned a 4xx/5xx. */
export function routeBroken(c: RouteCapture): boolean {
  return !c.ok || Boolean(c.loadError) || (typeof c.status === "number" && c.status >= 400);
}

function meaningfulTextLength(text: string): number {
  return (text ?? "").replace(/\s+/g, " ").trim().length;
}

/**
 * Truth-boundary honesty check for one route. Deterministic — no env probing:
 *  - errored_but_silent (HIGH): the route hit console/network errors but the
 *    page shows no degraded/error marker — it looks healthy while broken.
 *  - empty_unlabeled (MEDIUM): the route is blank (no meaningful text) and
 *    carries no empty-state label — a silent blank surface.
 *  - boundary_marker_missing (MEDIUM): when the env is known to be non-prod
 *    (expectedBoundary demo/testnet/local-simulation), a data-bearing surface
 *    must carry that marker — else it presents non-prod data as if real.
 */
export function checkRouteHonesty(c: RouteCapture, expectedBoundary: SweepBoundary): HonestyFinding[] {
  const findings: HonestyFinding[] = [];
  const markers = detectStateMarkers(c.visibleText);
  const errored = hasErrors(c);
  const textLen = meaningfulTextLength(c.visibleText);
  const dataBearing = textLen >= EMPTY_TEXT_THRESHOLD && !markers.empty;

  if (errored && !markers.degraded && !routeBroken(c)) {
    findings.push({
      route: c.route,
      severity: "high",
      code: "errored_but_silent",
      message: `Surface rendered ${errorCount(c)} console/network error(s) but shows no degraded/error state — it looks healthy while broken.`,
    });
  }

  if (!routeBroken(c) && !errored && textLen < EMPTY_TEXT_THRESHOLD && !markers.empty) {
    findings.push({
      route: c.route,
      severity: "medium",
      code: "empty_unlabeled",
      message: "Surface is blank with no empty-state label (e.g. \"nothing here yet\").",
    });
  }

  if (
    dataBearing &&
    (expectedBoundary === "demo" || expectedBoundary === "testnet" || expectedBoundary === "local-simulation") &&
    !markers[expectedBoundary]
  ) {
    findings.push({
      route: c.route,
      severity: "medium",
      code: "boundary_marker_missing",
      message: `Surface shows data without a "${expectedBoundary}" marker — non-production data must be labeled as such.`,
    });
  }

  return findings;
}

export function sweepVerdict(captures: RouteCapture[], findings: HonestyFinding[]): SweepVerdict {
  if (captures.length === 0) return "fail";
  const anyBroken = captures.some(routeBroken);
  const anyHigh = findings.some((f) => f.severity === "high");
  if (anyBroken || anyHigh) return "fail";
  const anyErrors = captures.some(hasErrors);
  if (anyErrors || findings.length > 0) return "partial";
  return "pass";
}

/** Resolve the routes to sweep. mission.routes overrides the default; otherwise
 *  the default is the public routes, plus the AUTHED operator routes when a
 *  session is present (`includeAuthed`). Relative routes join the app base URL. */
export function resolveSweepRoutes(
  routes: string[] | undefined,
  baseUrl: string | undefined,
  opts: { includeAuthed?: boolean } = {},
): Array<{ route: string; url: string }> {
  const defaults = opts.includeAuthed
    ? [...DEFAULT_PUBLIC_ROUTES, ...DEFAULT_AUTHED_ROUTES]
    : DEFAULT_PUBLIC_ROUTES;
  const list = routes && routes.length > 0 ? routes : defaults;
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  return list.map((route) => {
    if (/^https?:\/\//i.test(route)) return { route, url: route };
    const path = route.startsWith("/") ? route : `/${route}`;
    return { route, url: base ? `${base}${path}` : path };
  });
}

export interface SweepReportInput {
  mission: TestbedMissionRun;
  captures: RouteCapture[];
  expectedBoundary: SweepBoundary;
}

/** Aggregate per-route captures into the structured report shape the mission
 *  store normalizes (verdict / completedPath / blockers / confusingMoments /
 *  recommendations / evidence / scores). Pure + deterministic. */
export function buildSweepReport(input: SweepReportInput): Record<string, unknown> {
  const { mission, captures, expectedBoundary } = input;
  const findings = captures.flatMap((c) => checkRouteHonesty(c, expectedBoundary));
  const verdict = sweepVerdict(captures, findings);

  const broken = captures.filter(routeBroken);
  const errored = captures.filter((c) => hasErrors(c) && !routeBroken(c));

  const blockers: string[] = [
    ...broken.map((c) => `${c.route} failed to load cleanly (${c.loadError ?? `status ${c.status ?? "?"}`}).`),
    ...findings.filter((f) => f.severity === "high").map((f) => `${f.route}: ${f.message}`),
  ];
  const confusingMoments: string[] = [
    ...errored.map((c) => `${c.route} loaded but logged ${errorCount(c)} console/network error(s).`),
    ...findings.filter((f) => f.severity !== "high").map((f) => `${f.route}: ${f.message}`),
  ];
  const completedPath = captures.map(
    (c) => `swept ${c.route} → ${c.url} (${c.loadError ? "load error" : `status ${c.status ?? "?"}`})`,
  );
  const recommendations: string[] = [];
  if (broken.length) recommendations.push("Fix the route(s) that failed to load before the next deploy.");
  if (findings.some((f) => f.code === "errored_but_silent")) {
    recommendations.push("Surface a visible degraded/error state on pages that hit console or network errors.");
  }
  if (findings.some((f) => f.code === "empty_unlabeled")) {
    recommendations.push("Add an explicit empty-state label to blank surfaces.");
  }
  if (findings.some((f) => f.code === "boundary_marker_missing")) {
    recommendations.push(`Label non-production surfaces with their environment ("${expectedBoundary}").`);
  }

  const evidence: Array<{ type: string; value: string }> = [
    { type: "executor", value: "surface_sweep" },
    { type: "expected_boundary", value: expectedBoundary },
    { type: "routes_swept", value: String(captures.length) },
  ];
  for (const c of captures) {
    evidence.push({
      type: "route",
      value: `${c.route} :: status=${c.status ?? "?"} title=${JSON.stringify(c.title)} errors=${errorCount(c)}${c.loadError ? ` loadError=${c.loadError}` : ""}`,
    });
    if (c.screenshot) evidence.push({ type: "screenshot", value: c.screenshot });
  }
  for (const f of findings) {
    evidence.push({ type: "honesty_finding", value: `${f.severity} ${f.code} @ ${f.route}` });
  }

  const cleanRoutes = captures.filter((c) => !hasErrors(c)).length;
  const score = (n: number) => Math.max(0, Math.min(5, n));
  const loadHealth = captures.length ? score(Math.round((cleanRoutes / captures.length) * 5)) : 0;
  const boundaryHonesty = findings.length === 0 ? 5 : findings.some((f) => f.severity === "high") ? 1 : 3;

  return {
    missionId: mission.id,
    verdict,
    confidence: verdict === "pass" ? 0.9 : verdict === "fail" ? 0.85 : 0.6,
    executor: "surface_sweep",
    runnerMode: "surface_sweep",
    mode: "surface_sweep",
    goal: mission.goal,
    stoppedBeforeMutation: true,
    mutationMode: "read_only",
    mutationsAttempted: [],
    mutationBoundaryNotes: ["Surface sweep is read-only: it navigates and reads each route; it never clicks a mutating control."],
    completedPath,
    blockers,
    confusingMoments,
    recommendations,
    evidence,
    scores: {
      loadHealth,
      boundaryHonesty,
      coverage: captures.length >= DEFAULT_PUBLIC_ROUTES.length ? 5 : 3,
    },
    routes: captures.map((c) => ({
      route: c.route,
      url: c.url,
      ok: c.ok && !routeBroken(c),
      status: c.status ?? null,
      consoleErrors: c.consoleErrors.length,
      networkFailures: c.networkFailures.length,
      badResponses: c.badResponses.length,
    })),
    honestyFindings: findings,
    summary: `surface_sweep ${verdict}: ${cleanRoutes}/${captures.length} routes clean, ${findings.length} honesty finding(s)`,
  };
}

export interface SurfaceSweepDeps {
  /** Inject per-route capture (tests). Defaults to a real Chromium capture. */
  captureRoute?: (url: string, route: string) => Promise<RouteCapture>;
}

/** Resolve the environment boundary the surfaces must honestly label. */
export function resolveExpectedBoundary(value: string | undefined): SweepBoundary {
  switch ((value ?? "").trim().toLowerCase()) {
    case "demo":
      return "demo";
    case "testnet":
      return "testnet";
    case "local-simulation":
    case "local_simulation":
    case "local":
      return "local-simulation";
    case "production":
    case "prod":
      return "production";
    default:
      return "none";
  }
}

/**
 * Run a surface sweep for `mission`. Read-only: each route is navigated and
 * read; nothing is clicked or mutated. Returns the same TestbedMissionRunResult
 * shape the other executors return (a structured JSON report the runner
 * ingests). The browser is injected via `deps.captureRoute` so this is fully
 * unit-tested without a real browser.
 */
export async function executeSurfaceSweep(
  mission: TestbedMissionRun,
  config: {
    appBaseUrl?: string;
    expectedBoundary?: string;
    browserExecutablePath?: string;
    timeoutMs?: number;
    artifactsDir?: string;
    session?: SweepSession;
    cloudflareAccess?: CloudflareAccessServiceToken;
    basicAuth?: TestbedBasicAuth;
  },
  deps: SurfaceSweepDeps = {},
): Promise<TestbedMissionRunResult> {
  // Caddy Basic Auth gate: scope the credential to the gated origin so the
  // browser answers the host's 401 and loads the pages (no creds elsewhere).
  const httpCredentials = basicAuthHttpCredentialsForUrl(mission.targetUrl, config.basicAuth);
  const expectedBoundary = resolveExpectedBoundary(config.expectedBoundary);
  // With a session, the default route set extends to the authed operator pages;
  // without one, the sweep stays public-only (graceful fallback — never fails
  // just because a session is absent).
  const resolved = resolveSweepRoutes(
    mission.routes,
    config.appBaseUrl ?? originOf(mission.targetUrl),
    { includeAuthed: Boolean(config.session) },
  );
  const capture = deps.captureRoute ?? makeBrowserCapture({ ...config, httpCredentials });

  const captures: RouteCapture[] = [];
  for (const { route, url } of resolved) {
    try {
      captures.push(await capture(url, route));
    } catch (error) {
      captures.push({
        route,
        url,
        ok: false,
        title: "",
        visibleText: "",
        consoleErrors: [],
        networkFailures: [],
        badResponses: [],
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = buildSweepReport({ mission, captures, expectedBoundary });
  return {
    exitCode: 0,
    stdout: `Surface sweep completed for ${mission.id}: ${report.summary}\n`,
    stderr: "",
    reportText: `${JSON.stringify(report, null, 2)}\n`,
    summary: String(report.summary),
  };
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Default real-browser per-route capture (only used when not injected). Kept
 *  self-contained so the sweep module has no hard dependency on the explore
 *  executor's private helpers. */
function makeBrowserCapture(config: {
  browserExecutablePath?: string;
  timeoutMs?: number;
  session?: SweepSession;
  cloudflareAccess?: CloudflareAccessServiceToken;
  basicAuth?: TestbedBasicAuth;
  httpCredentials?: { username: string; password: string; origin?: string };
}): (url: string, route: string) => Promise<RouteCapture> {
  return async (url, route) => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      headless: true,
      ...(config.browserExecutablePath ? { executablePath: config.browserExecutablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const consoleErrors: string[] = [];
    const networkFailures: string[] = [];
    const badResponses: string[] = [];
    try {
      // Pre-seeded session (T2): storageState rehydrates the authed browser; a
      // Bearer (if any) authes the page's same-origin API calls. Read-only.
      const context = await browser.newContext(buildSweepContextOptions(config.session, config.cloudflareAccess, config.httpCredentials));
      const page = await context.newPage();
      if (config.basicAuth) {
        await page.route("**/*", (route) => {
          const headers = basicAuthHeadersForUrl(route.request().url(), config.basicAuth, route.request().headers());
          return headers ? route.continue({ headers }) : route.continue();
        });
      }
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => consoleErrors.push(e.message));
      page.on("requestfailed", (r) =>
        networkFailures.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText ?? "request failed"}`),
      );
      page.on("response", (r) => {
        if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      });
      const navTimeout = Math.min(config.timeoutMs ?? 45_000, 45_000);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      const status = resp?.status();
      const title = await page.title().catch(() => "");
      const visibleText = await page
        .evaluate(() => (document.body?.innerText ?? "").slice(0, 4000))
        .catch(() => "");
      return {
        route,
        url: page.url(),
        ok: typeof status === "number" ? status < 400 : true,
        ...(typeof status === "number" ? { status } : {}),
        title,
        visibleText,
        consoleErrors,
        networkFailures,
        badResponses,
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  };
}
