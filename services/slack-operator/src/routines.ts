export interface SlackRoutineConfig {
  channelId?: string;
  dailyBrief: {
    enabled: boolean;
    timeUtc: { hour: number; minute: number };
    includeGithub: boolean;
  };
  dailyGithubBrief: {
    enabled: boolean;
    timeUtc: { hour: number; minute: number };
  };
  opsHealth: {
    enabled: boolean;
    timeUtc: { hour: number; minute: number };
  };
  safeWorkScan: {
    enabled: boolean;
    intervalMs: number;
    notifyOnlyOnAvailable: boolean;
  };
  stalePrAlerts: {
    enabled: boolean;
    intervalMs: number;
    staleAfterMinutes: number;
  };
  /** D4 — off-device operator alert bridge (board action-needed 0→≥1). */
  alertBridge: {
    enabled: boolean;
    intervalMs: number;
    cooldownMs: number;
    quietHours?: { startMinute: number; endMinute: number };
    quietHoursTzOffsetMin: number;
  };
  /** D3 — tiered anomaly auto-pause (soft suspend → hard HALT). Off by default. */
  anomalyPause: {
    enabled: boolean;
    intervalMs: number;
  };
  /** O5 — task health self-management: bounded retries + stale escalation. */
  taskHealth: {
    enabled: boolean;
    intervalMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    approvedStaleMs: number;
    runningStaleMs: number;
    restartRecoveryMs: number;
  };
  /** B2 — self-healing: propose routed fixes / escalate on failure. Off by default. */
  selfHealing: {
    enabled: boolean;
    intervalMs: number;
    cooldownMs: number;
    /** Concurrent open-fix cap — stops a batch of failures swarming the queue. */
    maxOpenFixTasks: number;
    /** Per-tick cap — stops one scan from proposing a burst. */
    maxProposalsPerTick: number;
    /** Failed testbed missions older than this are treated as stale B2 inputs. */
    testbedFailureMaxAgeHours: number;
  };
}

export function parseSlackRoutineConfig(
  env: Record<string, string | undefined>,
  allowedChannelIds: Set<string>
): SlackRoutineConfig {
  const channelId = env.SLACK_OPERATOR_ROUTINE_CHANNEL_ID
    || firstSetValue(allowedChannelIds)
    || env.SLACK_OPERATOR_CHANNEL_ID;
  const safeWorkMinutes = positiveNumber(env.SLACK_OPERATOR_SAFE_WORK_SCAN_INTERVAL_MINUTES);
  const stalePrMinutes = positiveNumber(env.SLACK_OPERATOR_STALE_PR_ALERT_INTERVAL_MINUTES);
  return {
    channelId,
    dailyBrief: {
      enabled: env.SLACK_OPERATOR_DAILY_BRIEF_ENABLED === "1",
      timeUtc: parseUtcTime(env.SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC ?? "08:00"),
      includeGithub: env.SLACK_OPERATOR_DAILY_BRIEF_INCLUDE_GITHUB === "1",
    },
    dailyGithubBrief: {
      enabled: env.SLACK_OPERATOR_DAILY_GITHUB_BRIEF_ENABLED === "1",
      timeUtc: parseUtcTime(
        env.SLACK_OPERATOR_DAILY_GITHUB_BRIEF_TIME_UTC
        ?? env.SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC
        ?? "08:05"
      ),
    },
    opsHealth: {
      enabled: env.SLACK_OPERATOR_OPS_HEALTH_ENABLED === "1",
      timeUtc: parseUtcTime(env.SLACK_OPERATOR_OPS_HEALTH_TIME_UTC ?? "08:05"),
    },
    safeWorkScan: {
      enabled: safeWorkMinutes > 0,
      intervalMs: Math.max(60_000, safeWorkMinutes * 60_000),
      notifyOnlyOnAvailable: env.SLACK_OPERATOR_SAFE_WORK_NOTIFY_ONLY_ON_AVAILABLE !== "0",
    },
    stalePrAlerts: {
      enabled: stalePrMinutes > 0,
      intervalMs: Math.max(60_000, stalePrMinutes * 60_000),
      staleAfterMinutes: positiveNumber(env.SLACK_OPERATOR_STALE_PR_ALERT_AFTER_MINUTES) || 120,
    },
    alertBridge: {
      // Off by default: needs an explicit flag AND a webhook to send anywhere.
      enabled: env.D4_ALERT_BRIDGE_ENABLED === "1" && Boolean(env.SLACK_WEBHOOK_URL),
      intervalMs: Math.max(30_000, (positiveNumber(env.D4_ALERT_BRIDGE_INTERVAL_MINUTES) || 1) * 60_000),
      cooldownMs: Math.max(0, (positiveNumber(env.D4_ALERT_BRIDGE_COOLDOWN_MINUTES) || 30) * 60_000),
      ...(parseQuietHoursRange(env.D4_ALERT_QUIET_HOURS) ? { quietHours: parseQuietHoursRange(env.D4_ALERT_QUIET_HOURS) } : {}),
      quietHoursTzOffsetMin: Number.isFinite(Number(env.D4_ALERT_QUIET_TZ_OFFSET_MIN)) ? Number(env.D4_ALERT_QUIET_TZ_OFFSET_MIN) : 0,
    },
    anomalyPause: {
      // Off by default — the operator enables D3 before turning on autopilot.
      enabled: env.D3_ANOMALY_PAUSE_ENABLED === "1",
      intervalMs: Math.max(30_000, (positiveNumber(env.D3_ANOMALY_PAUSE_INTERVAL_MINUTES) || 1) * 60_000),
    },
    taskHealth: {
      enabled: env.O5_TASK_HEALTH_ENABLED !== "0",
      intervalMs: Math.max(60_000, (positiveNumber(env.O5_TASK_HEALTH_INTERVAL_MINUTES) || 5) * 60_000),
      maxRetries: env.O5_TASK_HEALTH_MAX_RETRIES === "0" ? 0 : Math.max(0, positiveNumber(env.O5_TASK_HEALTH_MAX_RETRIES) || 1),
      retryBackoffMs: Math.max(60_000, (positiveNumber(env.O5_TASK_HEALTH_RETRY_BACKOFF_MINUTES) || 15) * 60_000),
      approvedStaleMs: Math.max(60_000, (positiveNumber(env.O5_TASK_HEALTH_APPROVED_STALE_MINUTES) || 30) * 60_000),
      runningStaleMs: Math.max(60_000, (positiveNumber(env.O5_TASK_HEALTH_RUNNING_STALE_MINUTES) || 20) * 60_000),
      restartRecoveryMs: Math.max(60_000, (positiveNumber(env.O5_TASK_HEALTH_RESTART_RECOVERY_MINUTES) || 10) * 60_000),
    },
    selfHealing: {
      // Off by default — proposes fixes / escalates only once the operator turns it on.
      enabled: env.B2_SELF_HEALING_ENABLED === "1",
      intervalMs: Math.max(60_000, (positiveNumber(env.B2_SELF_HEALING_INTERVAL_MINUTES) || 5) * 60_000),
      cooldownMs: Math.max(60_000, (positiveNumber(env.B2_SELF_HEALING_COOLDOWN_MINUTES) || 30) * 60_000),
      maxOpenFixTasks: Math.max(1, positiveNumber(env.B2_SELF_HEALING_MAX_OPEN_FIXES) || 3),
      maxProposalsPerTick: Math.max(1, positiveNumber(env.B2_SELF_HEALING_MAX_PROPOSALS_PER_TICK) || 1),
      testbedFailureMaxAgeHours: Math.max(1, positiveNumber(env.B2_SELF_HEALING_TESTBED_FAILURE_MAX_AGE_HOURS) || 72),
    },
  };
}

/** Parse "HH:MM-HH:MM" into a minute-of-day window, or undefined. */
export function parseQuietHoursRange(
  value: string | undefined
): { startMinute: number; endMinute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!match) return undefined;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start < 0 || start >= 1440 || end < 0 || end >= 1440 || start === end) return undefined;
  return { startMinute: start, endMinute: end };
}

export function shouldRunDailyBrief(
  now: Date,
  config: SlackRoutineConfig,
  lastPostedDateKey: string | undefined
): { shouldRun: boolean; dateKey: string } {
  return shouldRunDailySchedule(now, config.channelId, config.dailyBrief, lastPostedDateKey);
}

export function shouldRunDailyGithubBrief(
  now: Date,
  config: SlackRoutineConfig,
  lastPostedDateKey: string | undefined
): { shouldRun: boolean; dateKey: string } {
  const includedInDailyBrief = config.dailyBrief.enabled && config.dailyBrief.includeGithub;
  return shouldRunDailySchedule(
    now,
    config.channelId,
    { ...config.dailyGithubBrief, enabled: config.dailyGithubBrief.enabled && !includedInDailyBrief },
    lastPostedDateKey
  );
}

export function shouldRunOpsHealth(
  now: Date,
  config: SlackRoutineConfig,
  lastPostedDateKey: string | undefined
): { shouldRun: boolean; dateKey: string } {
  return shouldRunDailySchedule(now, config.channelId, config.opsHealth, lastPostedDateKey);
}

export function safeWorkResultSignature(result: unknown): string | undefined {
  const root = toRecord(result);
  const safeWork = toRecord(root.safeWork);
  if (safeWork.available !== true) return undefined;
  const items = Array.isArray(safeWork.safeWorkItems) ? safeWork.safeWorkItems : [];
  const jobIds = items
    .map((item) => stringField(toRecord(item).job, "jobId"))
    .filter((jobId): jobId is string => Boolean(jobId));
  return jobIds.length > 0 ? jobIds.join("|") : "available";
}

export function shouldPostSafeWorkResult(
  result: unknown,
  previousSignature: string | undefined,
  notifyOnlyOnAvailable: boolean
): { shouldPost: boolean; signature?: string } {
  const signature = safeWorkResultSignature(result);
  if (!signature) return { shouldPost: !notifyOnlyOnAvailable };
  return { shouldPost: signature !== previousSignature, signature };
}

function parseUtcTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return { hour: 8, minute: 0 };
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 8, minute: 0 };
  }
  return { hour, minute };
}

function positiveNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function shouldRunDailySchedule(
  now: Date,
  channelId: string | undefined,
  schedule: { enabled: boolean; timeUtc: { hour: number; minute: number } },
  lastPostedDateKey: string | undefined
): { shouldRun: boolean; dateKey: string } {
  const dateKey = utcDateKey(now);
  if (!schedule.enabled || !channelId) return { shouldRun: false, dateKey };
  if (lastPostedDateKey === dateKey) return { shouldRun: false, dateKey };
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minutesTarget = schedule.timeUtc.hour * 60 + schedule.timeUtc.minute;
  return { shouldRun: minutesNow >= minutesTarget, dateKey };
}

function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function firstSetValue(values: Set<string>): string | undefined {
  for (const value of values) return value;
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
