import { describe, expect, it } from "vitest";

import {
  parseSlackRoutineConfig,
  safeWorkResultSignature,
  shouldPostSafeWorkResult,
  shouldRunDailyBrief,
  shouldRunDailyGithubBrief,
  shouldRunOpsHealth,
} from "../../services/slack-operator/src/routines.js";

describe("slack operator routines", () => {
  it("parses opt-in routine configuration with safe defaults", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_DAILY_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC: "06:30",
      SLACK_OPERATOR_DAILY_BRIEF_INCLUDE_GITHUB: "1",
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_TIME_UTC: "06:45",
      SLACK_OPERATOR_OPS_HEALTH_ENABLED: "1",
      SLACK_OPERATOR_OPS_HEALTH_TIME_UTC: "06:35",
      SLACK_OPERATOR_SAFE_WORK_SCAN_INTERVAL_MINUTES: "15",
      SLACK_OPERATOR_STALE_PR_ALERT_INTERVAL_MINUTES: "20",
      SLACK_OPERATOR_STALE_PR_ALERT_AFTER_MINUTES: "180",
      B2_SELF_HEALING_ENABLED: "1",
      B2_SELF_HEALING_MAX_PROPOSALS_PER_TICK: "3",
    }, new Set(["C1"]));

    expect(config.channelId).toBe("C1");
    expect(config.dailyBrief.enabled).toBe(true);
    expect(config.dailyBrief.timeUtc).toEqual({ hour: 6, minute: 30 });
    expect(config.dailyBrief.includeGithub).toBe(true);
    expect(config.dailyGithubBrief.enabled).toBe(true);
    expect(config.dailyGithubBrief.timeUtc).toEqual({ hour: 6, minute: 45 });
    expect(config.opsHealth.enabled).toBe(true);
    expect(config.opsHealth.timeUtc).toEqual({ hour: 6, minute: 35 });
    expect(config.safeWorkScan.enabled).toBe(true);
    expect(config.safeWorkScan.intervalMs).toBe(15 * 60_000);
    expect(config.safeWorkScan.notifyOnlyOnAvailable).toBe(true);
    expect(config.stalePrAlerts.enabled).toBe(true);
    expect(config.stalePrAlerts.intervalMs).toBe(20 * 60_000);
    expect(config.stalePrAlerts.staleAfterMinutes).toBe(180);
    expect(config.taskHealth).toMatchObject({
      enabled: true,
      intervalMs: 5 * 60_000,
      maxRetries: 1,
      retryBackoffMs: 15 * 60_000,
      approvedStaleMs: 30 * 60_000,
      runningStaleMs: 20 * 60_000,
      restartRecoveryMs: 10 * 60_000,
    });
    expect(config.selfHealing.enabled).toBe(true);
    expect(config.selfHealing.maxProposalsPerTick).toBe(3);
  });

  it("lets an explicit routine channel override the allowed-channel fallback", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_ROUTINE_CHANNEL_ID: "C-routine",
      SLACK_OPERATOR_CHANNEL_ID: "C-primary",
    }, new Set(["C-allowed"]));

    expect(config.channelId).toBe("C-routine");
  });

  it("parses B2 self-healing storm-control caps", () => {
    const config = parseSlackRoutineConfig({
      B2_SELF_HEALING_ENABLED: "1",
      B2_SELF_HEALING_INTERVAL_MINUTES: "2",
      B2_SELF_HEALING_COOLDOWN_MINUTES: "45",
      B2_SELF_HEALING_MAX_PROPOSALS_PER_TICK: "2",
      B2_SELF_HEALING_MAX_OPEN_FIXES: "4",
      B2_SELF_HEALING_TESTBED_FAILURE_MAX_AGE_HOURS: "12",
    }, new Set(["C1"]));

    expect(config.selfHealing.enabled).toBe(true);
    expect(config.selfHealing.intervalMs).toBe(2 * 60_000);
    expect(config.selfHealing.cooldownMs).toBe(45 * 60_000);
    expect(config.selfHealing.maxProposalsPerTick).toBe(2);
    expect(config.selfHealing.maxOpenFixTasks).toBe(4);
    expect(config.selfHealing.testbedFailureMaxAgeHours).toBe(12);
  });

  it("parses O5 task health retry and stale thresholds", () => {
    const config = parseSlackRoutineConfig({
      O5_TASK_HEALTH_ENABLED: "0",
      O5_TASK_HEALTH_INTERVAL_MINUTES: "2",
      O5_TASK_HEALTH_MAX_RETRIES: "3",
      O5_TASK_HEALTH_RETRY_BACKOFF_MINUTES: "4",
      O5_TASK_HEALTH_APPROVED_STALE_MINUTES: "12",
      O5_TASK_HEALTH_RUNNING_STALE_MINUTES: "8",
      O5_TASK_HEALTH_RESTART_RECOVERY_MINUTES: "6",
    }, new Set(["C1"]));

    expect(config.taskHealth).toMatchObject({
      enabled: false,
      intervalMs: 2 * 60_000,
      maxRetries: 3,
      retryBackoffMs: 4 * 60_000,
      approvedStaleMs: 12 * 60_000,
      runningStaleMs: 8 * 60_000,
      restartRecoveryMs: 6 * 60_000,
    });
  });

  it("runs the daily brief once per UTC date after the target time", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_DAILY_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC: "08:00",
    }, new Set(["C1"]));

    expect(shouldRunDailyBrief(new Date("2026-05-05T07:59:00.000Z"), config, undefined)).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
    expect(shouldRunDailyBrief(new Date("2026-05-05T08:00:00.000Z"), config, undefined)).toEqual({
      shouldRun: true,
      dateKey: "2026-05-05",
    });
    expect(shouldRunDailyBrief(new Date("2026-05-05T09:00:00.000Z"), config, "2026-05-05")).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
  });

  it("runs the standalone daily GitHub brief after its target time", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_TIME_UTC: "08:05",
    }, new Set(["C1"]));

    expect(shouldRunDailyGithubBrief(new Date("2026-05-05T08:04:00.000Z"), config, undefined)).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
    expect(shouldRunDailyGithubBrief(new Date("2026-05-05T08:05:00.000Z"), config, undefined)).toEqual({
      shouldRun: true,
      dateKey: "2026-05-05",
    });
    expect(shouldRunDailyGithubBrief(new Date("2026-05-05T09:00:00.000Z"), config, "2026-05-05")).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
  });

  it("does not run a duplicate standalone GitHub brief when included in the daily operator brief", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_DAILY_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_BRIEF_INCLUDE_GITHUB: "1",
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_GITHUB_BRIEF_TIME_UTC: "08:05",
    }, new Set(["C1"]));

    expect(shouldRunDailyGithubBrief(new Date("2026-05-05T09:00:00.000Z"), config, undefined)).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
  });

  it("runs the ops health routine once per UTC date after the target time", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_OPS_HEALTH_ENABLED: "1",
      SLACK_OPERATOR_OPS_HEALTH_TIME_UTC: "08:05",
    }, new Set(["C1"]));

    expect(shouldRunOpsHealth(new Date("2026-05-05T08:04:00.000Z"), config, undefined)).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
    expect(shouldRunOpsHealth(new Date("2026-05-05T08:05:00.000Z"), config, undefined)).toEqual({
      shouldRun: true,
      dateKey: "2026-05-05",
    });
    expect(shouldRunOpsHealth(new Date("2026-05-05T09:00:00.000Z"), config, "2026-05-05")).toEqual({
      shouldRun: false,
      dateKey: "2026-05-05",
    });
  });

  it("builds stable safe-work signatures from available job ids", () => {
    expect(safeWorkResultSignature({
      safeWork: {
        available: true,
        safeWorkItems: [
          { job: { jobId: "wiki-en-1" } },
          { job: { jobId: "wiki-en-2" } },
        ],
      },
    })).toBe("wiki-en-1|wiki-en-2");

    expect(safeWorkResultSignature({ safeWork: { available: false } })).toBeUndefined();
  });

  it("posts safe-work results only when useful work changes by default", () => {
    const result = {
      safeWork: {
        available: true,
        safeWorkItems: [{ job: { jobId: "wiki-en-1" } }],
      },
    };

    expect(shouldPostSafeWorkResult(result, undefined, true)).toEqual({
      shouldPost: true,
      signature: "wiki-en-1",
    });
    expect(shouldPostSafeWorkResult(result, "wiki-en-1", true)).toEqual({
      shouldPost: false,
      signature: "wiki-en-1",
    });
    expect(shouldPostSafeWorkResult({ safeWork: { available: false } }, undefined, true)).toEqual({
      shouldPost: false,
    });
  });
});
