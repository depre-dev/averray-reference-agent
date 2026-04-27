import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { logger, optionalEnv, query, sha256Text } from "@avg/mcp-common";

const skillsDir = optionalEnv("HERMES_SKILLS_DIR", "/opt/data/skills");
const slackWebhookUrl = optionalEnv("SLACK_WEBHOOK_URL");

logger.info({ skillsDir }, "skills_observer_starting");

const watcher = chokidar.watch("**/*.md", {
  cwd: skillsDir,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100
  }
});

watcher.on("add", ingest);
watcher.on("change", ingest);
watcher.on("error", (error) => logger.error({ err: error }, "skills_observer_error"));

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

