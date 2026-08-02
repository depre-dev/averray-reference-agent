import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { logger, optionalEnv, query, sha256Text } from "@avg/mcp-common";
import { describeWatchError } from "./watch-error.js";
import { decideDriftAlert, initialDriftAlertState } from "./drift-alert.js";
import {
  compareBundle,
  describeBundleObservation,
  readMcpProcessRegistry,
  readPublishedBundleId,
  type BundleObservation,
  type RegistryReading
} from "./bundle-drift.js";
import { errorCode } from "./skills-sync.js";
import {
  describeDrift,
  diffSkillTrees,
  driftSignature,
  hashBytes,
  isInSync,
  readSkillTree,
  type SkillDrift
} from "./skills-tree.js";

const skillsDir = optionalEnv("HERMES_SKILLS_DIR", "/opt/data/skills");
const repoSkillsDir = optionalEnv("REPO_SKILLS_DIR", "/repo-skills");
const bundleDir = optionalEnv("MCP_BUNDLE_DIR", "/bundle");
const bundleRegistryDir = optionalEnv("MCP_BUNDLE_REGISTRY_DIR", "/data/mcp-bundle-registry");
const slackWebhookUrl = optionalEnv("SLACK_WEBHOOK_URL");
const watchRetryMs = Number(optionalEnv("SKILLS_OBSERVER_WATCH_RETRY_MS", "30000"));
const driftCheckMs = Number(optionalEnv("SKILLS_DRIFT_CHECK_MS", "900000"));
// Gap before the second check only — the first runs while skills-sync may still
// be copying, so it observes without announcing.
const driftSettleMs = Number(optionalEnv("SKILLS_DRIFT_SETTLE_MS", "60000"));

logger.info({ skillsDir, repoSkillsDir }, "skills_observer_starting");

let retryTimer: NodeJS.Timeout | undefined;

function scheduleRetry(): void {
  // A pending timer keeps the event loop alive, so an unwatchable skills dir
  // degrades to periodic retries instead of the process exiting and Docker
  // restart-looping. It also self-heals once the directory becomes readable.
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    logger.info({ skillsDir }, "skills_observer_watch_retry");
    startWatcher();
  }, watchRetryMs);
}

function startWatcher(): void {
  // chokidar v4 removed glob support: a "**/*.md" pattern is treated as a literal
  // (nonexistent) path, so the watcher established no persistent handle and the
  // process exited immediately -> restart loop. Watch the skills dir and filter to
  // .md via `ignored` (stats is undefined on the directory-scan pass, so folders
  // pass through and recursion still works). cwd keeps emitted paths relative, so
  // ingest's path.join(skillsDir, relativePath) is unchanged.
  const watcher = chokidar.watch(".", {
    cwd: skillsDir,
    ignoreInitial: false,
    ignored: (testPath, stats) => Boolean(stats?.isFile()) && !testPath.endsWith(".md"),
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  // `ingest` is async, so an unhandled rejection from it takes the whole
  // process down — a Postgres blip during the initial scan is enough. That now
  // costs more than a lost ingest: the drift check shares this process, and a
  // restart resets its state machine, whose first pass deliberately only
  // observes. A fast enough crash loop would therefore never reach a pass that
  // announces, and drift would go unreported while looking merely flaky.
  watcher.on("add", (relativePath) => void ingestSafely(relativePath));
  watcher.on("change", (relativePath) => void ingestSafely(relativePath));
  watcher.on("error", (error) => {
    const disposition = describeWatchError(error);
    if (!disposition.retryable) {
      logger.error({ err: error }, disposition.logKey);
      return;
    }
    // Access errors (unreadable or absent skills volume) are operational, not
    // fatal: tear the watcher down, surface the one-line fix, and retry.
    logger.error(
      { err: error, skillsDir, retryMs: watchRetryMs },
      `${disposition.logKey}: ${disposition.remediation}`
    );
    void watcher.close().catch(() => undefined);
    scheduleRetry();
  });
}

startWatcher();

/**
 * Who wrote the file that just landed in the volume.
 *
 * Before skills-sync existed, everything appearing here came from Hermes, so
 * the watcher could announce it as such. Now the sync writes into the same
 * directory, and announcing its copies as "Hermes wrote a skill" would report
 * agent behaviour that never happened. Classify by comparing against the repo
 * copy instead of assuming.
 *
 * `repo`  — byte-identical to what the repo ships: our own sync landing.
 * `edited-over-repo` — a repo-managed path the agent has since changed. This is
 *   drift; the periodic check owns that message so it is not said twice.
 * `agent` — no repo counterpart, so the agent genuinely authored it.
 * `unknown` — the repo tree could not be consulted. Nothing is claimed either
 *   way; notably NOT folded into `agent`, or a broken repo mount would report
 *   every file the sync just copied as the agent having written it.
 */
type SkillOrigin = "repo" | "edited-over-repo" | "agent" | "unknown";

async function classifyOrigin(relativePath: string, content: string): Promise<SkillOrigin> {
  let repoBytes: Buffer;
  try {
    repoBytes = await fs.readFile(path.join(repoSkillsDir, relativePath));
  } catch (error) {
    // Only "the repo does not ship this path" means the agent wrote it. Any
    // other error means we could not look.
    return errorCode(error) === "ENOENT" ? "agent" : "unknown";
  }
  // The watcher only ever ingests .md, so re-encoding the text it already read
  // reproduces the bytes on disk exactly.
  return hashBytes(repoBytes) === hashBytes(Buffer.from(content, "utf8"))
    ? "repo"
    : "edited-over-repo";
}

async function ingestSafely(relativePath: string): Promise<void> {
  try {
    await ingest(relativePath);
  } catch (error) {
    // Chokidar re-emits on the next change, and a restart re-scans, so a failed
    // ingest is recoverable. Losing the process is not worth it.
    logger.error({ err: error, filePath: relativePath }, "skill_ingest_failed");
  }
}

async function ingest(relativePath: string) {
  const filePath = path.join(skillsDir, relativePath);
  const content = await fs.readFile(filePath, "utf8");
  const stat = await fs.stat(filePath);
  const sha256 = sha256Text(content);
  const rows = await query<{ id: string }>(
    `insert into skills_observed(file_path, sha256, content, written_at)
     values ($1, $2, $3, $4)
     on conflict(file_path, sha256) do nothing
     returning id`,
    [relativePath, sha256, content, stat.mtime.toISOString()]
  );
  if (!rows[0]) return;
  const origin = await classifyOrigin(relativePath, content);
  logger.info({ filePath: relativePath, sha256, origin }, "skill_observed");
  // Every version is recorded above regardless of origin — that audit trail is
  // the point. Only a skill the agent demonstrably authored is news worth a
  // notification, and `unknown` is not a demonstration.
  if (origin !== "agent") return;
  await postSlack({
    text: `Hermes wrote or updated a skill: ${relativePath}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Hermes wrote or updated a skill*\n\`${relativePath}\`\nsha256: \`${sha256.slice(0, 12)}\`\n\n${content.slice(0, 500)}`
        }
      }
    ]
  });
}

/**
 * Report when the volume copy stops matching the repo.
 *
 * skills-sync makes the copy correct at boot and on deploy; this makes a later
 * divergence visible. Both failure modes it catches used to be silent: a sync
 * that could not write (Hermes re-secures the volume to 0700 as it works), and
 * the agent editing a skill the repo owns.
 *
 * Detection lives here rather than in skills-sync because it is a standing
 * condition, not a boot step, and this service is already the long-running
 * reader of that volume — it holds the right UID, the Slack route, and a
 * read-only mount of both trees. It writes to neither.
 */
let driftAlertState = initialDriftAlertState;

async function checkDrift(): Promise<void> {
  let signature: string;
  let drift: SkillDrift;
  try {
    const [repoTree, volumeTree] = await Promise.all([
      readSkillTree(repoSkillsDir),
      readSkillTree(skillsDir)
    ]);
    drift = diffSkillTrees(repoTree, volumeTree);
    signature = driftSignature(drift);
  } catch (error) {
    // Unreadable is NOT in sync. Say only what was established — that the check
    // could not run — and announce that, because a drift check that has quietly
    // stopped working is the same silence this mechanism exists to end.
    const decision = decideDriftAlert(driftAlertState, { kind: "unavailable" });
    driftAlertState = decision.state;
    logger.warn(
      { err: error, skillsDir, repoSkillsDir },
      "skills_drift_check_unavailable: could not compare the volume against the repo, so " +
        "whether they match is currently unknown."
    );
    if (decision.announce === "unavailable") {
      await postSlack({
        text:
          "Cannot check the skills volume against the repo, so whether the agent is loading " +
          "current skills is unknown. Check the /repo-skills and skills volume mounts on " +
          "skills-observer."
      });
    }
    return;
  }

  const decision = decideDriftAlert(
    driftAlertState,
    isInSync(drift) ? { kind: "in-sync" } : { kind: "drifted", signature }
  );
  driftAlertState = decision.state;

  if (isInSync(drift)) {
    logger.info({ skillsDir }, "skills_drift_none");
    if (decision.announce === "recovery") {
      await postSlack({ text: "Skills volume is back in sync with the repo." });
    }
    return;
  }

  // Logged on every check regardless of whether it is announced, so the
  // condition is always recoverable from the logs.
  logger.error(
    { missing: drift.missing, modified: drift.modified },
    `skills_drift_detected: ${describeDrift(drift)}. The running agent is not loading what the ` +
      "repo says it is. Re-run ops/deploy-monitor.sh (it syncs first), or " +
      "`docker compose -p avg run --rm --no-deps skills-sync`."
  );
  if (decision.announce !== "drift") return;
  await postSlack({
    text: `Skills volume has drifted from the repo: ${describeDrift(drift)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Skills volume has drifted from the repo*\n${describeDrift(drift)}\n\n` +
            "The running agent is not loading what `hermes/skills/**` says it is. " +
            "Re-run `ops/deploy-monitor.sh`, which syncs before it deploys."
        }
      }
    ]
  });
}

/**
 * Report when a running consumer's MCP tool registry is older than the bundle.
 *
 * Second, unrelated volume; same shape of bug, and the same reason it lives
 * here. `avg-app` is rewritten on every deploy, but an MCP client registers its
 * tool list once at process startup, so a consumer that is not restarted keeps
 * answering from the previous tool list with nothing erroring — which is how
 * hermes-gateway came to answer a health question from the wrong tool on
 * 2026-08-02. ops/deploy-monitor.sh restarts the consumers; this catches every
 * path that is not that script.
 *
 * The name of this service predates the second check. It is still the right
 * home: long-running, already holds the Slack route and the alert state
 * machine, and mounts both sides read-only. It repairs neither.
 */
let bundleAlertState = initialDriftAlertState;

/**
 * Never throws. Anything that stops the comparison from being made comes back
 * as `unknown` rather than as an exception, because an exception here would
 * reject driftLoop's promise and take the process down — and a crash loop
 * resets both state machines, whose first pass deliberately only observes. A
 * fast enough loop would then never reach a pass that announces, and drift
 * would go unreported while looking merely flaky.
 */
async function observeBundle(): Promise<{
  observation: BundleObservation;
  publishedBundleId: string | undefined;
}> {
  let publishedBundleId: string | undefined;
  try {
    publishedBundleId = await readPublishedBundleId(bundleDir);
    let reading: RegistryReading = { live: [], unreadable: [] };
    try {
      reading = await readMcpProcessRegistry(bundleRegistryDir, Date.now());
    } catch (error) {
      // An absent registry directory is not a failure to look — it is nobody
      // having recorded anything yet, which compareBundle already words
      // honestly. Anything else means the check itself could not run.
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return { observation: compareBundle(publishedBundleId, reading), publishedBundleId };
  } catch (error) {
    logger.warn({ err: error, bundleDir, bundleRegistryDir }, "mcp_bundle_check_failed");
    return {
      observation: {
        kind: "unknown",
        reason:
          "the MCP process registry could not be read, so which bundle the consumers loaded is unknown"
      },
      publishedBundleId
    };
  }
}

async function checkBundleDrift(): Promise<void> {
  const { observation, publishedBundleId } = await observeBundle();
  const live = observation.kind === "unknown" ? [] : observation.live;
  const description = describeBundleObservation(observation, publishedBundleId);

  const decision = decideDriftAlert(
    bundleAlertState,
    observation.kind === "current"
      ? { kind: "in-sync" }
      : observation.kind === "stale"
        ? { kind: "drifted", signature: observation.signature }
        : { kind: "unavailable" }
  );
  bundleAlertState = decision.state;

  if (observation.kind === "current") {
    logger.info({ bundleId: publishedBundleId, live: live.length }, "mcp_bundle_current");
    if (decision.announce === "recovery") {
      await postSlack({ text: `MCP tool registries are back in sync with the bundle: ${description}.` });
    }
    return;
  }

  if (observation.kind === "unknown") {
    logger.warn({ bundleDir, bundleRegistryDir }, `mcp_bundle_check_unavailable: ${description}`);
    if (decision.announce === "unavailable") {
      await postSlack({
        text:
          `Cannot tell whether the running agent's MCP tool list matches the deployed bundle — ${description}. ` +
          "Until this reads again, a tool shipped by a deploy may be invisible to the agent with nothing erroring."
      });
    }
    return;
  }

  // Logged on every check whether or not it is announced, so the condition is
  // always recoverable from the logs.
  logger.error(
    { stale: observation.stale.map((entry) => ({ host: entry.host, entry: entry.entry, bundleId: entry.bundleId })) },
    `mcp_bundle_stale: ${description}. Those processes registered their tool list at startup and ` +
      "have not restarted since, so tools shipped by later deploys are invisible to them. Restart " +
      "the consumers: `ops/deploy-monitor.sh` does it, or `docker restart <container>`."
  );
  if (decision.announce !== "drift") return;
  await postSlack({
    text: `MCP tool registry is stale: ${description}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*MCP tool registry is stale*\n${description}\n\n` +
            "An MCP client registers its tool list once, at startup. Those processes are serving " +
            "the list from an older bundle, so a tool shipped since then does not exist as far as " +
            "the agent is concerned — and it will answer from whatever tool it *does* have.\n" +
            "Restart the consumers: `ops/deploy-monitor.sh` does this, or `docker restart <container>`."
        }
      }
    ]
  });
}

async function driftLoop(): Promise<void> {
  const settling = !driftAlertState.settled;
  await checkDrift();
  await checkBundleDrift();
  // The first pass only observes (skills-sync may still be copying), so follow
  // it up quickly rather than a full interval later — otherwise a divergence
  // that is real goes unannounced for the whole period.
  // Not unref'd, for the same reason as the watch-retry timer above: a pending
  // timer keeps the process alive, so an unreadable volume degrades to periodic
  // re-checks instead of the process exiting into a Docker restart loop.
  setTimeout(() => void driftLoop(), settling ? driftSettleMs : driftCheckMs);
}

void driftLoop();

async function postSlack(payload: unknown) {
  if (!slackWebhookUrl) return;
  try {
    const response = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) logger.warn({ status: response.status }, "slack_post_failed");
  } catch (error) {
    logger.warn({ err: error }, "slack_post_failed");
  }
}

