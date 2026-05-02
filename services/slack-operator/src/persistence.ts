export interface OperatorCommandEventInput {
  source: string;
  commandText: string;
  teamId?: string;
  userId?: string;
  channelId?: string;
  slackPermalink?: string;
  replyPermalink?: string;
  result: unknown;
}

export async function recordOperatorCommandEvent(
  input: OperatorCommandEventInput,
  query: QueryFn
) {
  const extracted = extractResultFields(input.result);
  await query(
    `insert into operator_command_events(
       source,
       command_text,
       normalized_text,
       team_id,
       user_id,
       channel_id,
       slack_permalink,
       reply_permalink,
       run_id,
       job_id,
       session_id,
       draft_id,
       status,
       result
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
     )`,
    [
      input.source,
      input.commandText,
      normalizeText(input.commandText),
      input.teamId ?? null,
      input.userId ?? null,
      input.channelId ?? null,
      input.slackPermalink ?? null,
      input.replyPermalink ?? null,
      extracted.runId ?? null,
      extracted.jobId ?? null,
      extracted.sessionId ?? null,
      extracted.draftId ?? null,
      extracted.status ?? null,
      JSON.stringify(input.result ?? {}),
    ]
  );
}

type QueryFn = <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;

function extractResultFields(result: unknown) {
  const root = toRecord(result) ?? {};
  const payload = toRecord(root.result) ?? root;
  return {
    runId: stringField(payload, "runId") ?? stringField(root, "runId"),
    jobId: stringField(payload, "jobId") ?? stringField(root, "jobId"),
    sessionId: stringField(payload, "sessionId") ?? stringField(root, "sessionId"),
    draftId: stringField(payload, "draftId") ?? stringField(root, "draftId"),
    status: stringField(payload, "status") ?? stringField(root, "status"),
  };
}

function normalizeText(text: string) {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
