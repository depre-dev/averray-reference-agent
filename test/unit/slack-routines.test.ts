import { describe, expect, it } from "vitest";

import {
  parseSlackRoutineConfig,
  safeWorkResultSignature,
  shouldPostSafeWorkResult,
  shouldRunDailyBrief,
} from "../../services/slack-operator/src/routines.js";

describe("slack operator routines", () => {
  it("parses opt-in routine configuration with safe defaults", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_DAILY_BRIEF_ENABLED: "1",
      SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC: "06:30",
      SLACK_OPERATOR_SAFE_WORK_SCAN_INTERVAL_MINUTES: "15",
    }, new Set(["C1"]));

    expect(config.channelId).toBe("C1");
    expect(config.dailyBrief.enabled).toBe(true);
    expect(config.dailyBrief.timeUtc).toEqual({ hour: 6, minute: 30 });
    expect(config.safeWorkScan.enabled).toBe(true);
    expect(config.safeWorkScan.intervalMs).toBe(15 * 60_000);
    expect(config.safeWorkScan.notifyOnlyOnAvailable).toBe(true);
  });

  it("lets an explicit routine channel override the allowed-channel fallback", () => {
    const config = parseSlackRoutineConfig({
      SLACK_OPERATOR_ROUTINE_CHANNEL_ID: "C-routine",
      SLACK_OPERATOR_CHANNEL_ID: "C-primary",
    }, new Set(["C-allowed"]));

    expect(config.channelId).toBe("C-routine");
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
