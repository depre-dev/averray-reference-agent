import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  createSlackForwarder,
  type AlertForwarder,
  type WatchdogFetch,
} from "../../services/harness-watchdog/src/forwarders.js";
import {
  bindingIntegrityDetections,
  createWatchdogProcess,
  detectOrphans,
  parseWatchdogConfig,
  type HarnessSourceState,
  type WatchdogConfig,
  type WatchdogDeps,
} from "../../services/harness-watchdog/src/watchdog.js";

const TOKEN_SENTINEL = "INT4A_TOKEN_SENTINEL_DO_NOT_LEAK";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("the standalone Harness watchdog", () => {
  it("defaults to the ordered INT-4a thresholds and paths", () => {
    const config = parseWatchdogConfig({});
    expect(config).toMatchObject({
      pollIntervalMs: 15_000,
      dispatcherStaleMs: 90_000,
      harnessSourceStaleMs: 900_000,
      databaseTimeoutMs: 5_000,
      orphanAgeMs: 600_000,
      dispatcherHeartbeatPath: "/data/harness-dispatcher-heartbeat.json",
      alertsPath: "/data/harness-dispatch-alerts.jsonl",
      heartbeatPath: "/data/harness-watchdog-heartbeat.json",
      statusPath: "/data/harness-watchdog-status.json",
    });
  });

  it("states plainly that Slack is disabled when its env is absent", async () => {
    const harness = await createHarness({
      forwarders: [createSlackForwarder({})],
    });
    const status = await harness.process.tick();
    expect(status.sinks).toEqual([{ name: "slack", state: "disabled" }]);
    const writtenStatus = JSON.parse(
      await readFile(harness.config.statusPath, "utf8"),
    );
    if (process.env.INT4A_PRINT_STATUS === "1") {
      console.info(`INT4A_STATUS_JSON=${JSON.stringify(writtenStatus)}`);
    }
    expect(writtenStatus).toMatchObject({
        kind: "harness_watchdog_status",
        sinks: [{ name: "slack", state: "disabled" }],
      });
  });

  it("writes a stale-dispatcher alert to the file before forwarding it", async () => {
    const seen: string[] = [];
    let now = new Date("2026-08-05T10:00:00.000Z");
    const harness = await createHarness({
      now: () => now,
      dispatcherStaleMs: 1_000,
      forwarders: [{
        name: "slack",
        state: "configured",
        async forward(alert): Promise<void> {
          const file = await readFile(harness.config.alertsPath, "utf8");
          expect(file).toContain(String(alert.code));
          seen.push(String(alert.code));
        },
      }],
    });
    await harness.process.tick();
    now = new Date(now.getTime() + 1_001);
    const status = await harness.process.tick();
    expect(seen).toEqual(["watchdog_dispatcher_heartbeat_stale"]);
    expect(status.activeIssues).toContain("watchdog_dispatcher_heartbeat_stale");
    expect(status.lastAlertForwarded?.sinks).toEqual(["slack"]);
  });

  it("forwards new dispatcher alerts without rewriting the source record", async () => {
    const forwarded: Array<Readonly<Record<string, unknown>>> = [];
    const harness = await createHarness({
      forwarders: [capturingForwarder(forwarded)],
    });
    await harness.process.tick();
    const source = {
      severity: "warn",
      code: "dispatcher_source_alert",
      message: "source record",
      at: "2026-08-05T10:00:01.000Z",
    };
    await writeFile(harness.config.alertsPath, `${JSON.stringify(source)}\n`, "utf8");
    await harness.process.tick();
    expect(forwarded).toEqual([source]);
    expect((await readFile(harness.config.alertsPath, "utf8")).trim())
      .toBe(JSON.stringify(source));
  });

  it("alerts on either unreachable Postgres boundary without stopping itself", async () => {
    const harness = await createHarness({
      probeReferenceDatabase: vi.fn().mockRejectedValue(new Error("dsn secret")),
      probeHarnessDatabase: vi.fn().mockRejectedValue(new Error("dsn secret")),
    });
    const first = await harness.process.tick();
    const second = await harness.process.tick();
    expect(first.activeIssues).toEqual([
      "watchdog_harness_database_unreachable",
      "watchdog_reference_database_unreachable",
    ]);
    expect(second.activeIssues).toEqual(first.activeIssues);
    const records = await alertRecords(harness.config.alertsPath);
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("dsn secret");
  });

  it("checks source age only while a Harness run is live", async () => {
    let source: HarnessSourceState = {
      liveRun: false,
      newestEventAt: new Date("2026-08-05T09:00:00.000Z"),
    };
    const harness = await createHarness({
      harnessSourceStaleMs: 1_000,
      probeHarnessDatabase: async () => source,
    });
    expect((await harness.process.tick()).activeIssues)
      .not.toContain("watchdog_harness_source_stale");
    source = { ...source, liveRun: true };
    expect((await harness.process.tick()).activeIssues)
      .toContain("watchdog_harness_source_stale");
  });

  it("detects binding divergence and both age-gated orphan classes", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const old = "2026-08-06T10:00:00.000Z";
    const fresh = "2026-08-06T11:59:30.000Z";
    const hash = `sha256:${"a".repeat(64)}`;
    const bindings = [
      {
        workItemId: "wrong-binding",
        taskVersion: 1,
        approvedTaskHash: hash,
        harnessRunId: "00000000-0000-5000-8000-000000000099",
        lifecycle: "running",
        boundAt: old,
        taskUpdatedAt: old,
      },
      {
        workItemId: "missing-run",
        taskVersion: 1,
        approvedTaskHash: null,
        harnessRunId: "11111111-1111-5111-8111-111111111111",
        lifecycle: "running",
        boundAt: old,
        taskUpdatedAt: old,
      },
      {
        workItemId: "terminal-task",
        taskVersion: 1,
        approvedTaskHash: null,
        harnessRunId: "22222222-2222-5222-8222-222222222222",
        lifecycle: "failed",
        boundAt: old,
        taskUpdatedAt: old,
      },
      {
        workItemId: "fresh-missing",
        taskVersion: 1,
        approvedTaskHash: null,
        harnessRunId: "33333333-3333-5333-8333-333333333333",
        lifecycle: "running",
        boundAt: fresh,
        taskUpdatedAt: fresh,
      },
    ];

    const integrity = bindingIntegrityDetections(bindings);
    expect(integrity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "critical",
        code: "watchdog_binding_integrity_violation",
      }),
    ]));
    expect(JSON.stringify(integrity)).toContain(bindings[0]!.harnessRunId);

    const orphans = detectOrphans(bindings, [{
      runId: bindings[2]!.harnessRunId,
      terminal: false,
      updatedAt: old,
    }], now, 60_000);
    expect(orphans.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "watchdog_task_run_orphan",
      "watchdog_harness_run_orphan",
    ]));
    expect(JSON.stringify(orphans)).not.toContain("fresh-missing");
  });

  it("keeps later forwarders live when one sink fails", async () => {
    const delivered: string[] = [];
    const harness = await createHarness({
      dispatcherStaleMs: 1,
      now: sequenceClock([
        "2026-08-05T10:00:00.000Z",
        "2026-08-05T10:00:00.002Z",
      ]),
      forwarders: [
        {
          name: "failed",
          state: "configured",
          async forward(): Promise<void> {
            throw new Error("sink down");
          },
        },
        {
          name: "slack",
          state: "configured",
          async forward(): Promise<void> {
            delivered.push("slack");
          },
        },
      ],
    });
    await harness.process.tick();
    expect(delivered).toEqual(["slack"]);
  });
});

describe("the direct Slack forwarder", () => {
  it("scrubs secret-bearing fields and authorization text before delivery", async () => {
    let body = "";
    const fetchImpl: WatchdogFetch = async (_input, init) => {
      body = String(init.body);
      return { ok: true, status: 200 };
    };
    const scrub = process.env.INT4A_MUTATE_REDACTION === "1"
      ? (value: Readonly<Record<string, unknown>>) => {
          console.info("INT4A_MUTATION_APPLIED=redaction_identity_scrub");
          return { ...value };
        }
      : undefined;
    const forwarder = createSlackForwarder({
      webhookUrl: "http://127.0.0.1.invalid/slack",
      fetchImpl,
      ...(scrub ? { scrub } : {}),
    });
    await forwarder.forward({
      severity: "critical",
      code: "sentinel_probe",
      message: `Authorization: Bearer ${TOKEN_SENTINEL}`,
      api_token: TOKEN_SENTINEL,
    });
    expect(body).not.toContain(TOKEN_SENTINEL);
    expect(body).toContain("[REDACTED]");
  });
});

describe("the watchdog import surface", () => {
  it("has no slack-operator or Hermes-facing import", async () => {
    const root = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../services/harness-watchdog/src",
    );
    const sources = await sourceFiles(root);
    const forbidden: string[] = [];
    for (const source of sources) {
      const text = await readFile(source, "utf8");
      for (const specifier of importSpecifiers(text)) {
        if (/slack-operator|hermes/iu.test(specifier)) {
          forbidden.push(`${path.basename(source)} -> ${specifier}`);
        }
      }
    }
    expect(forbidden, "forbidden watchdog imports").toEqual([]);
  });

  it("runs as a standalone restartable Compose service with Slack only", async () => {
    const composePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../ops/compose.yml",
    );
    const compose = parseYaml(await readFile(composePath, "utf8")) as {
      services: Record<string, {
        restart?: string;
        profiles?: string[];
        command?: string[];
        environment?: Record<string, unknown>;
      }>;
    };
    const service = compose.services["harness-watchdog"];
    expect(service).toMatchObject({
      restart: "unless-stopped",
      command: ["node", "services/harness-watchdog/dist/index.js"],
    });
    expect(service?.profiles).toBeUndefined();
    expect(service?.environment).toHaveProperty("WATCHDOG_SLACK_WEBHOOK_URL");
    expect(Object.keys(service?.environment ?? {}))
      .not.toContain("WATCHDOG_BUZZ_TOKEN");
  });
});

async function createHarness(options: {
  now?: () => Date;
  dispatcherStaleMs?: number;
  harnessSourceStaleMs?: number;
  forwarders?: AlertForwarder[];
  probeReferenceDatabase?: WatchdogDeps["probeReferenceDatabase"];
  probeHarnessDatabase?: WatchdogDeps["probeHarnessDatabase"];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "int4a-watchdog-unit-"));
  roots.push(root);
  const config: WatchdogConfig = {
    pollIntervalMs: 10,
    dispatcherStaleMs: options.dispatcherStaleMs ?? 90_000,
    harnessSourceStaleMs: options.harnessSourceStaleMs ?? 900_000,
    databaseTimeoutMs: 5_000,
    orphanAgeMs: 600_000,
    alertsPath: path.join(root, "alerts.jsonl"),
    dispatcherHeartbeatPath: path.join(root, "dispatcher-heartbeat.json"),
    heartbeatPath: path.join(root, "watchdog-heartbeat.json"),
    statusPath: path.join(root, "watchdog-status.json"),
  };
  const now = options.now ?? (() => new Date("2026-08-05T10:00:00.000Z"));
  await writeFile(config.dispatcherHeartbeatPath, JSON.stringify({
    updatedAt: now().toISOString(),
  }), "utf8");
  const process = createWatchdogProcess(config, {
    now,
    forwarders: options.forwarders ?? [createSlackForwarder({})],
    probeReferenceDatabase: options.probeReferenceDatabase ?? (async () => {}),
    probeHarnessDatabase: options.probeHarnessDatabase ?? (async () => ({
      liveRun: false,
      newestEventAt: null,
    })),
    readReferenceBindings: async () => [],
    readHarnessRuns: async () => [],
    logger: { info: vi.fn(), warn: vi.fn() },
    scheduler: {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  return { root, config, process };
}

function capturingForwarder(
  target: Array<Readonly<Record<string, unknown>>>,
): AlertForwarder {
  return {
    name: "slack",
    state: "configured",
    async forward(alert): Promise<void> {
      target.push(alert);
    },
  };
}

async function alertRecords(target: string): Promise<unknown[]> {
  return (await readFile(target, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sequenceClock(values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
}

function importSpecifiers(source: string): string[] {
  const results: string[] = [];
  const pattern = /(?:from\s+|import\s*(?:\(\s*)?)(["'])([^"']+)\1/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) results.push(match[2]);
  }
  return results;
}
