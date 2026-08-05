import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = path.join(root, "scripts/ceremony/compose.int4a-watchdog-drill.yml");
const mutation = argument("--mutation");
const baselineHermes = process.argv.includes("--baseline-hermes-unavailable");
const project = `codex-int4a-${process.pid}-${Date.now()}`.toLowerCase();
if (!/^codex-int4a-[a-z0-9-]+$/u.test(project)) {
  throw new Error("INT4A_REFUSE unsafe Compose project name");
}

const composeEnvironment = {
  ...process.env,
  ...(mutation === "threshold-infinity"
    ? { INT4A_DRILL_DISPATCHER_STALE_MS: String(Number.MAX_SAFE_INTEGER) }
    : {}),
  ...(mutation === "slack-blackhole"
    ? { INT4A_DRILL_SLACK_URL: "http://127.0.0.1:9/hook" }
    : {}),
};

try {
  up();
  await waitFor(() => logs("fake-slack").includes("INT4A_FAKE_SLACK_READY"), 30_000,
    "fake Slack listener ready");
  await waitFor(() => readRuntime("dispatcher-heartbeat.json", "dispatcher") !== "", 30_000,
    "dispatcher heartbeat present");
  assertDatabaseLive("reference-db", "reference");
  assertDatabaseLive("harness-db", "harness");

  if (baselineHermes) {
    stop("hermes", "slack-operator");
    stop("dispatcher", "harness-db");
    await delay(2_000);
    const deliveries = readDeliveries();
    if (deliveries.length !== 0) fail(
      "hermes-unavailable-baseline",
      `expected no delivery without watchdog, observed=${deliveries.length}`,
    );
    fail("hermes-unavailable-baseline",
      "external_delivery_missing watchdog_absent hermes=stopped slack_operator=stopped");
  }

  const firstHeartbeat = await heartbeatUpdatedAt();
  await waitFor(async () => (await heartbeatUpdatedAt()) !== firstHeartbeat, 12_000,
    "dispatcher heartbeat advancing");
  const secondHeartbeat = await heartbeatUpdatedAt();
  console.info(
    `INT4A_DISPATCHER_LIVE heartbeat_one=${firstHeartbeat} heartbeat_two=${secondHeartbeat}`,
  );

  console.info("INT4A_DRILL_START dispatcher-killed");
  stop("dispatcher");
  await requireDelivery(
    "dispatcher-killed",
    "watchdog_dispatcher_heartbeat_stale",
    5_000,
  );
  console.info(
    "INT4A_DRILL_GREEN dispatcher-killed file=present slack=delivered watchdog=running",
  );

  start("dispatcher");
  await waitFor(() => serviceRunning("dispatcher"), 15_000, "dispatcher restarted");
  await waitFor(() => !statusIssues().includes("watchdog_dispatcher_heartbeat_stale"),
    10_000, "dispatcher staleness recovered");

  console.info("INT4A_DRILL_START harness-db-down");
  stop("harness-db");
  await requireDelivery(
    "harness-db-down",
    "watchdog_harness_database_unreachable",
    5_000,
  );
  if (!serviceRunning("watchdog")) fail("harness-db-down", "watchdog_stopped");
  console.info(
    "INT4A_DRILL_GREEN harness-db-down file=present slack=delivered watchdog=running",
  );

  start("harness-db");
  await waitFor(() => postgresReady("harness-db", "harness"), 20_000,
    "Harness database restarted");
  await waitFor(() => !statusIssues().includes("watchdog_harness_database_unreachable"),
    10_000, "Harness database issue recovered");

  console.info("INT4A_DRILL_START hermes-unavailable");
  stop("hermes", "slack-operator");
  if (serviceRunning("hermes") || serviceRunning("slack-operator")) {
    fail("hermes-unavailable", "local coordinator container still running");
  }
  stop("dispatcher");
  await requireDeliveryCount(
    "hermes-unavailable",
    "watchdog_dispatcher_heartbeat_stale",
    2,
    5_000,
  );
  start("dispatcher");
  await waitFor(() => serviceRunning("dispatcher"), 15_000, "dispatcher restarted under Hermes outage");
  await waitFor(() => !statusIssues().includes("watchdog_dispatcher_heartbeat_stale"),
    10_000, "dispatcher recovered under Hermes outage");
  stop("harness-db");
  await requireDeliveryCount(
    "hermes-unavailable",
    "watchdog_harness_database_unreachable",
    2,
    5_000,
  );
  console.info(
    "INT4A_DRILL_GREEN hermes-unavailable hermes=stopped slack_operator=stopped dispatcher_alert=delivered harness_db_alert=delivered",
  );
  console.info(`INT4A_STATUS_JSON=${readRuntime("watchdog-status.json").trim()}`);
  console.info("INT4A_DRILLS_RESULT=green 3/3");
} finally {
  down();
}

function up() {
  const services = [
    "reference-db",
    "harness-db",
    "reference-migrate",
    "harness-migrate",
    "fake-slack",
    "hermes",
    "slack-operator",
    "dispatcher",
    ...(baselineHermes ? [] : ["watchdog"]),
  ];
  compose(["up", "-d", ...services]);
  console.info(`INT4A_LOCAL_COMPOSE_PROJECT=${project}`);
}

function down() {
  compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
}

function start(...services) {
  compose(["start", ...services]);
}

function stop(...services) {
  compose(["stop", ...services]);
}

function compose(args, options = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "-f", composeFile, ...args],
    {
      cwd: root,
      env: composeEnvironment,
      encoding: "utf8",
      stdio: options.capture ? "pipe" : "inherit",
    },
  );
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`INT4A_COMPOSE_FAILED status=${result.status}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function logs(service) {
  return compose(["logs", "--no-color", service], { capture: true, allowFailure: true });
}

function serviceRunning(service) {
  return compose(["ps", "--status", "running", "--services", service], {
    capture: true,
    allowFailure: true,
  }).trim() === service;
}

function assertDatabaseLive(service, database) {
  if (!postgresReady(service, database)) {
    throw new Error(`INT4A_DATABASE_NOT_LIVE service=${service}`);
  }
  console.info(`INT4A_DATABASE_LIVE service=${service} authenticated_select=1`);
}

function postgresReady(service, database) {
  const result = spawnSync(
    "docker",
    [
      "compose", "-p", project, "-f", composeFile,
      "exec", "-T", service,
      "psql", "-U", "int4a", "-d", database, "-Atqc", "select 1",
    ],
    { cwd: root, env: composeEnvironment, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "1";
}

function readRuntime(name, service = "watchdog") {
  return execIn(service, ["cat", `/data/${name}`]);
}

function readDeliveries() {
  const text = execIn(
    "fake-slack",
    ["cat", "/evidence/slack-deliveries.jsonl"],
    true,
  );
  return text.trim() ? text.trim().split("\n") : [];
}

function execIn(service, command, allowFailure = false) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "-f", composeFile, "exec", "-T", service, ...command],
    { cwd: root, env: composeEnvironment, encoding: "utf8" },
  );
  if (!allowFailure && result.status !== 0) return "";
  return result.status === 0 ? result.stdout : "";
}

async function heartbeatUpdatedAt() {
  const raw = readRuntime("dispatcher-heartbeat.json");
  if (!raw) return "";
  return String(JSON.parse(raw).updatedAt ?? "");
}

function statusIssues() {
  const raw = readRuntime("watchdog-status.json");
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.activeIssues) ? parsed.activeIssues : [];
}

async function requireDelivery(drill, code, timeoutMs) {
  return requireDeliveryCount(drill, code, 1, timeoutMs);
}

async function requireDeliveryCount(drill, code, count, timeoutMs) {
  const emitted = await waitFor(
    () => readRuntime("dispatch-alerts.jsonl").includes(code),
    timeoutMs,
    `${drill} file emission ${code}`,
    false,
  );
  const delivered = await waitFor(
    () => readDeliveries().filter((line) => line.includes(code)).length >= count,
    timeoutMs,
    `${drill} Slack delivery ${code}`,
    false,
  );
  if (!emitted || !delivered) {
    fail(
      drill,
      `delivery_missing code=${code} file_emission=${emitted} slack_delivery=${delivered} mutation=${mutation ?? "none"}`,
    );
  }
}

async function waitFor(predicate, timeoutMs, label, throwOnTimeout = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(100);
  }
  if (throwOnTimeout) throw new Error(`INT4A_WAIT_TIMEOUT ${label}`);
  return false;
}

function fail(drill, reason) {
  console.error(`INT4A_DRILL_RED ${drill} ${reason}`);
  process.exitCode = 1;
  throw new Error(`INT4A_DRILL_ASSERTION_FAILED ${drill}: ${reason}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
