export interface SlackRoutineConfig {
  channelId?: string;
  dailyBrief: {
    enabled: boolean;
    timeUtc: { hour: number; minute: number };
  };
  safeWorkScan: {
    enabled: boolean;
    intervalMs: number;
    notifyOnlyOnAvailable: boolean;
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
  return {
    channelId,
    dailyBrief: {
      enabled: env.SLACK_OPERATOR_DAILY_BRIEF_ENABLED === "1",
      timeUtc: parseUtcTime(env.SLACK_OPERATOR_DAILY_BRIEF_TIME_UTC ?? "08:00"),
    },
    safeWorkScan: {
      enabled: safeWorkMinutes > 0,
      intervalMs: Math.max(60_000, safeWorkMinutes * 60_000),
      notifyOnlyOnAvailable: env.SLACK_OPERATOR_SAFE_WORK_NOTIFY_ONLY_ON_AVAILABLE !== "0",
    },
  };
}

export function shouldRunDailyBrief(
  now: Date,
  config: SlackRoutineConfig,
  lastPostedDateKey: string | undefined
): { shouldRun: boolean; dateKey: string } {
  const dateKey = utcDateKey(now);
  if (!config.dailyBrief.enabled || !config.channelId) return { shouldRun: false, dateKey };
  if (lastPostedDateKey === dateKey) return { shouldRun: false, dateKey };
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minutesTarget = config.dailyBrief.timeUtc.hour * 60 + config.dailyBrief.timeUtc.minute;
  return { shouldRun: minutesNow >= minutesTarget, dateKey };
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
