import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  TestbedMissionMode,
  TestbedMissionRun,
  TestbedMissionVerdict,
} from "./monitor-testbed-missions.js";

const MAX_TESTBED_SUITES = 100;
const MAX_TESTBED_SUITE_HISTORY = 50;

export type TestbedSuiteAuthor = "predefined" | "operator" | "test-writer" | "platform";
export type TestbedSuiteMode = Extract<TestbedMissionMode, "surface_sweep" | "siwe_auth" | "gold_path">;
export type TestbedSuiteRunVerdict = TestbedMissionVerdict | "requested" | "ready" | "running" | "failed" | "unknown";
export type TestbedSuiteStatus = "requested" | "saved";

export interface TestbedSuiteHistoryEntry {
  runId: string;
  verdict: TestbedSuiteRunVerdict;
  ts: string;
}

export interface TestbedSuite {
  schemaVersion: 1;
  kind: "testbed_suite";
  id: string;
  status: TestbedSuiteStatus;
  name: string;
  target: string;
  mode: TestbedSuiteMode;
  goal?: string;
  author: TestbedSuiteAuthor;
  requesterAgent?: string;
  requestReason?: string;
  requestedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  history: TestbedSuiteHistoryEntry[];
  lastRun?: TestbedSuiteHistoryEntry;
}

export interface TestbedSuiteStoreDeps {
  path?: string;
  now?: Date;
}

export interface CreateTestbedSuiteInput {
  name?: unknown;
  target?: unknown;
  mode?: unknown;
  goal?: unknown;
  author?: unknown;
  requesterAgent?: unknown;
  reason?: unknown;
  requestReason?: unknown;
}

export interface ListTestbedSuitesOptions {
  path?: string;
  missionRuns?: TestbedMissionRun[];
}

let suites: TestbedSuite[] = [];
let suiteSeq = 0;
let loadedSuiteStorePath: string | undefined;

export function __resetTestbedSuitesForTests(): void {
  suites = [];
  suiteSeq = 0;
  loadedSuiteStorePath = undefined;
}

export function listTestbedSuites(options: ListTestbedSuitesOptions = {}) {
  ensureSuiteStoreLoaded(options.path, { force: true });
  const missionRuns = options.missionRuns ?? [];
  return {
    schemaVersion: 1,
    kind: "testbed_suite_list",
    suites: suites.map((suite) => enrichSuite(cloneSuite(suite), missionRuns)),
  };
}

export function getTestbedSuite(id: string, deps: TestbedSuiteStoreDeps = {}): TestbedSuite | undefined {
  ensureSuiteStoreLoaded(deps.path, { force: true });
  const suite = suites.find((candidate) => candidate.id === id);
  return suite ? cloneSuite(suite) : undefined;
}

export function createTestbedSuite(
  input: CreateTestbedSuiteInput,
  deps: TestbedSuiteStoreDeps = {}
): TestbedSuite {
  return createSuiteRecord(input, "saved", deps);
}

export function requestTestbedSuite(
  input: CreateTestbedSuiteInput,
  deps: TestbedSuiteStoreDeps = {}
): TestbedSuite {
  const author = parseSuiteAuthor(input.author);
  if (author !== "test-writer" && author !== "platform") {
    throw new Error("invalid_suite_request_author");
  }
  return createSuiteRecord(input, "requested", deps);
}

export function approveRequestedTestbedSuite(
  id: string,
  deps: TestbedSuiteStoreDeps & { approvedBy?: string } = {}
): { ok: true; suite: TestbedSuite } | { ok: false; error: "not_found" | "not_requested"; suite?: TestbedSuite } {
  ensureSuiteStoreLoaded(deps.path, { force: true });
  const suite = suites.find((candidate) => candidate.id === id);
  if (!suite) return { ok: false, error: "not_found" };
  if (suite.status !== "requested") return { ok: false, error: "not_requested", suite: cloneSuite(suite) };
  const now = (deps.now ?? new Date()).toISOString();
  suite.status = "saved";
  suite.approvedAt = now;
  suite.approvedBy = deps.approvedBy ?? "operator";
  suite.updatedAt = now;
  persistSuiteStore(deps.path);
  return { ok: true, suite: cloneSuite(suite) };
}

export function dismissRequestedTestbedSuite(
  id: string,
  deps: TestbedSuiteStoreDeps = {}
): { ok: true; suite: TestbedSuite } | { ok: false; error: "not_found" | "not_requested"; suite?: TestbedSuite } {
  ensureSuiteStoreLoaded(deps.path, { force: true });
  const index = suites.findIndex((candidate) => candidate.id === id);
  if (index < 0) return { ok: false, error: "not_found" };
  const suite = suites[index];
  if (suite.status !== "requested") return { ok: false, error: "not_requested", suite: cloneSuite(suite) };
  const dismissed = cloneSuite({ ...suite, updatedAt: (deps.now ?? new Date()).toISOString() });
  suites.splice(index, 1);
  persistSuiteStore(deps.path);
  return { ok: true, suite: dismissed };
}

function createSuiteRecord(
  input: CreateTestbedSuiteInput,
  status: TestbedSuiteStatus,
  deps: TestbedSuiteStoreDeps = {}
): TestbedSuite {
  ensureSuiteStoreLoaded(deps.path, { force: true });
  const now = (deps.now ?? new Date()).toISOString();
  const suite: TestbedSuite = {
    schemaVersion: 1,
    kind: "testbed_suite",
    id: nextSuiteId(input.name),
    status,
    name: parseSuiteName(input.name),
    target: parseHttpTarget(input.target),
    mode: parseSuiteMode(input.mode),
    ...(parseOptionalString(input.goal) ? { goal: parseOptionalString(input.goal) } : {}),
    author: parseSuiteAuthor(input.author),
    ...(parseOptionalString(input.requesterAgent) ? { requesterAgent: parseOptionalString(input.requesterAgent) } : {}),
    ...(parseOptionalString(input.reason) || parseOptionalString(input.requestReason) ? { requestReason: parseOptionalString(input.reason) ?? parseOptionalString(input.requestReason) } : {}),
    ...(status === "requested" ? { requestedAt: now } : {}),
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  suites.push(suite);
  while (suites.length > MAX_TESTBED_SUITES) suites.shift();
  persistSuiteStore(deps.path);
  return cloneSuite(suite);
}

export function appendTestbedSuiteRun(
  suiteId: string,
  run: TestbedMissionRun,
  deps: TestbedSuiteStoreDeps = {}
): TestbedSuite | undefined {
  ensureSuiteStoreLoaded(deps.path, { force: true });
  const suite = suites.find((candidate) => candidate.id === suiteId);
  if (!suite) return undefined;
  const entry: TestbedSuiteHistoryEntry = {
    runId: run.id,
    verdict: missionRunVerdict(run),
    ts: run.completedAt ?? run.failedAt ?? run.updatedAt,
  };
  suite.history = [
    ...suite.history.filter((candidate) => candidate.runId !== run.id),
    entry,
  ].slice(-MAX_TESTBED_SUITE_HISTORY);
  suite.updatedAt = (deps.now ?? new Date()).toISOString();
  suite.lastRun = entry;
  persistSuiteStore(deps.path);
  return cloneSuite(suite);
}

function enrichSuite(suite: TestbedSuite, missionRuns: TestbedMissionRun[]): TestbedSuite {
  if (suite.history.length === 0) return suite;
  const runsById = new Map(missionRuns.map((run) => [run.id, run]));
  const history = suite.history.map((entry) => {
    const run = runsById.get(entry.runId);
    return run
      ? { runId: run.id, verdict: missionRunVerdict(run), ts: run.completedAt ?? run.failedAt ?? run.updatedAt }
      : entry;
  });
  return {
    ...suite,
    history,
    lastRun: history[history.length - 1],
  };
}

function missionRunVerdict(run: TestbedMissionRun): TestbedSuiteRunVerdict {
  const result = isRecord(run.result) ? run.result : {};
  const nested = isRecord(result.structuredReport) ? result.structuredReport : {};
  const verdict = typeof nested.verdict === "string" ? nested.verdict : typeof result.verdict === "string" ? result.verdict : undefined;
  if (verdict === "pass" || verdict === "partial" || verdict === "fail") return verdict;
  if (run.status === "completed") return "pass";
  if (run.status === "requested" || run.status === "ready" || run.status === "running" || run.status === "failed") return run.status;
  return "unknown";
}

function ensureSuiteStoreLoaded(path?: string, options: { force?: boolean } = {}): void {
  const targetPath = suiteStorePath(path);
  if (!targetPath || (!options.force && loadedSuiteStorePath === targetPath)) return;
  try {
    const value: unknown = JSON.parse(readFileSync(targetPath, "utf8"));
    const loaded = suiteStoreSuites(value);
    suites = loaded;
    suiteSeq = suiteStoreSeq(value, loaded);
    loadedSuiteStorePath = targetPath;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    suites = [];
    suiteSeq = 0;
    loadedSuiteStorePath = targetPath;
  }
}

function persistSuiteStore(path?: string): void {
  const targetPath = suiteStorePath(path);
  if (!targetPath) return;
  const store = {
    schemaVersion: 1,
    kind: "testbed_suite_store",
    suiteSeq,
    suites: suites.slice(-MAX_TESTBED_SUITES),
  };
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(store, null, 2)}\n`);
  loadedSuiteStorePath = targetPath;
}

function suiteStoreSuites(value: unknown): TestbedSuite[] {
  const rawSuites = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.suites)
      ? value.suites
      : [];
  return rawSuites.filter(isTestbedSuite).map(normalizeSuite).slice(-MAX_TESTBED_SUITES);
}

function suiteStoreSeq(value: unknown, loadedSuites: TestbedSuite[]): number {
  if (isRecord(value) && typeof value.suiteSeq === "number" && Number.isFinite(value.suiteSeq)) {
    return Math.max(0, Math.floor(value.suiteSeq));
  }
  return loadedSuites.reduce((max, suite) => {
    const match = suite.id.match(/-(\d+)$/);
    const parsed = match ? Number(match[1]) : 0;
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
}

function nextSuiteId(name: unknown): string {
  suiteSeq += 1;
  const slug = parseOptionalString(name)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "suite";
  return `testbed-suite-${slug}-${suiteSeq}`;
}

function parseSuiteName(value: unknown): string {
  const text = parseOptionalString(value);
  if (!text) throw new Error("suite_name_required");
  return text.slice(0, 120);
}

function parseHttpTarget(value: unknown): string {
  const text = parseOptionalString(value);
  if (!text) throw new Error("suite_target_required");
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid_suite_target");
    return parsed.toString();
  } catch {
    throw new Error("invalid_suite_target");
  }
}

function parseSuiteMode(value: unknown): TestbedSuiteMode {
  const text = parseOptionalString(value);
  if (text === "surface_sweep" || text === "siwe_auth" || text === "gold_path") return text;
  throw new Error("invalid_suite_mode");
}

function parseSuiteAuthor(value: unknown): TestbedSuiteAuthor {
  const text = parseOptionalString(value);
  if (text === "predefined" || text === "operator" || text === "test-writer" || text === "platform") return text;
  return "operator";
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function suiteStorePath(path?: string): string | undefined {
  return path ?? process.env.AVERRAY_TESTBED_SUITES_PATH;
}

function isTestbedSuite(value: unknown): value is TestbedSuite {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || value.kind !== "testbed_suite") return false;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.target !== "string") return false;
  if (value.status !== undefined && value.status !== "requested" && value.status !== "saved") return false;
  if (value.mode !== "surface_sweep" && value.mode !== "siwe_auth" && value.mode !== "gold_path") return false;
  if (value.author !== "predefined" && value.author !== "operator" && value.author !== "test-writer" && value.author !== "platform") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.history)) return false;
  return true;
}

function cloneSuite(suite: TestbedSuite): TestbedSuite {
  return {
    ...normalizeSuite(suite),
    history: suite.history.map((entry) => ({ ...entry })),
    ...(suite.lastRun ? { lastRun: { ...suite.lastRun } } : {}),
  };
}

function normalizeSuite(suite: TestbedSuite): TestbedSuite {
  return {
    ...suite,
    status: suite.status ?? "saved",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
