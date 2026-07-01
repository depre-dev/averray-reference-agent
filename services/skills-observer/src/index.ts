import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { logger, optionalEnv, query, sha256Text } from "@avg/mcp-common";
import { describeWatchError } from "./watch-error.js";

const skillsDir = optionalEnv("HERMES_SKILLS_DIR", "/opt/data/skills");
const slackWebhookUrl = optionalEnv("SLACK_WEBHOOK_URL");
const watchRetryMs = Number(optionalEnv("SKILLS_OBSERVER_WATCH_RETRY_MS", "30000"));

logger.info({ skillsDir }, "skills_observer_starting");

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

  watcher.on("add", ingest);
  watcher.on("change", ingest);
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
  logger.info({ filePath: relativePath, sha256 }, "skill_observed");
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

