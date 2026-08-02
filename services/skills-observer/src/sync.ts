import { logger, optionalEnv } from "@avg/mcp-common";

import { describeDrift } from "./skills-tree.js";
import { syncSkills } from "./skills-sync.js";

/**
 * One-shot: copy `hermes/skills/**` from the git checkout into the skills
 * volume, so the repo genuinely is the source of truth for what the running
 * agent loads.
 *
 * Runs before Hermes starts (the `skills-sync` service in ops/compose.yml gates
 * it) and again on every deploy (ops/deploy-monitor.sh). Until this existed the
 * volume copy was placed by hand: merging a SKILL.md change did nothing, and
 * one skill sat unreachable for weeks with no error and no signal, which
 * produced a wrong production answer.
 *
 * The copying rules — never delete, verify afterwards — live in skills-sync.ts.
 * This file is the environment, the log lines and the exit code.
 */

const repoDir = optionalEnv("REPO_SKILLS_DIR", "/repo-skills");
const volumeDir = optionalEnv("HERMES_SKILLS_DIR", "/opt/data/skills");

const UID_REMEDIATION =
  "Hermes owns the skills volume as UID 10000 and secures it to mode 0700, so the writer must " +
  'run as user "10000:10000" (see the skills-sync service in ops/compose.yml).';

logger.info({ repoDir, volumeDir }, "skills_sync_starting");

const result = await syncSkills({ repoDir, volumeDir });

switch (result.status) {
  case "repo-unreadable":
    logger.error(
      { err: result.error, repoDir },
      "skills_sync_repo_unreadable: cannot read the repo skill tree. It is bind-mounted from the " +
        "git checkout (../hermes/skills); check that mount before trusting the volume copy."
    );
    process.exitCode = 1;
    break;

  case "volume-unreadable":
    logger.error(
      { err: result.error, volumeDir, synced: result.synced },
      "skills_sync_volume_unreadable: could not read the skills volume, so whether it matches " +
        `the repo is unknown — this run cannot claim a sync. ${UID_REMEDIATION}`
    );
    process.exitCode = 1;
    break;

  case "repo-empty":
    logger.error(
      { repoDir },
      "skills_sync_repo_empty: the repo skill tree has no files. Refusing to report a sync that " +
        "copied nothing — check the ../hermes/skills bind mount."
    );
    process.exitCode = 1;
    break;

  case "current":
    logger.info({ volumeDir }, "skills_sync_already_current");
    break;

  case "synced":
    // Failures are still worth naming even though the volume verified clean:
    // they are how a permissions problem shows up before it starts mattering.
    logger.info(
      { synced: result.synced, failures: result.failures },
      "skills_sync_complete"
    );
    break;

  case "incomplete":
    logger.error(
      { failures: result.failures, missing: result.drift.missing, modified: result.drift.modified },
      `skills_sync_incomplete: ${describeDrift(result.drift)}. ${UID_REMEDIATION} Hermes is gated ` +
        "on this step so it cannot boot onto a stale skill tree; to start it anyway use " +
        "`docker compose -p avg up -d --no-deps hermes`."
    );
    process.exitCode = 1;
    break;
}
