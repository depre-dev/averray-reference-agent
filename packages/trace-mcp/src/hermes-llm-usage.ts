import {
  appendLlmUsageEvent,
  llmUsageEventFromResult,
  type LlmUsageEvent,
} from "@avg/averray-mcp/llm-usage";
import { logger } from "@avg/mcp-common";

let llmUsageDebugLogged = false;

export async function recordHermesLlmUsageFromTraceEvent(
  event: unknown,
  options: { path?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<LlmUsageEvent | undefined> {
  if (stringField(event, "kind") !== "post_llm_call") return undefined;
  maybeLogHermesTraceUsageShape(event, options.env ?? process.env);

  const ts = dateField(event, "timestamp");
  const model = firstString(
    deepString(event, ["payload", "model"]),
    deepString(event, ["payload", "model_id"]),
    deepString(event, ["payload", "modelId"]),
    deepString(event, ["payload", "request", "model"]),
    deepString(event, ["payload", "request", "model_id"]),
    deepString(event, ["payload", "request", "modelId"]),
    deepString(event, ["payload", "response", "model"]),
    deepString(event, ["payload", "result", "model"]),
    deepString(event, ["payload", "output", "model"]),
    stringField(event, "model")
  );
  const runId = firstString(
    deepString(event, ["payload", "run_id"]),
    deepString(event, ["payload", "runId"]),
    deepString(event, ["payload", "hermes_run_id"]),
    deepString(event, ["payload", "hermesRunId"]),
    stringField(event, "run_id"),
    stringField(event, "runId")
  );
  const taskId = firstString(
    deepString(event, ["payload", "task_id"]),
    deepString(event, ["payload", "taskId"]),
    deepString(event, ["payload", "mission_id"]),
    deepString(event, ["payload", "missionId"])
  );

  for (const candidate of hermesUsageCandidates(event)) {
    const usageEvent = llmUsageEventFromResult({
      agent: "hermes",
      ...(model ? { model } : {}),
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(ts ? { ts } : {}),
      result: candidate,
    });
    if (!usageEvent) continue;
    await appendLlmUsageEvent(usageEvent, options.path ? { path: options.path } : {});
    return usageEvent;
  }

  return undefined;
}

export function summarizeHermesTraceUsageDebugShape(event: unknown): Record<string, unknown> {
  const root = asRecord(event);
  const payload = asRecord(root?.payload);
  return {
    topLevelKeys: root ? Object.keys(root).sort() : [],
    payloadKeys: payload ? Object.keys(payload).sort() : [],
    candidateCount: hermesUsageCandidates(event).length,
    present: {
      ...debugPath(payload, "usage", "payload.usage"),
      ...debugPath(payload, "prompt_eval_count", "payload.prompt_eval_count"),
      ...debugPath(payload, "eval_count", "payload.eval_count"),
      ...debugPath(asRecord(payload?.response), "usage", "payload.response.usage"),
      ...debugPath(asRecord(payload?.result), "usage", "payload.result.usage"),
      ...debugPath(asRecord(payload?.output), "usage", "payload.output.usage"),
      ...debugPath(asRecord(asRecord(payload?.response)?.message), "usage", "payload.response.message.usage"),
      ...debugPath(asRecord(firstArrayItem(asRecord(payload?.response)?.choices)), "usage", "payload.response.choices[0].usage"),
      ...debugPath(
        asRecord(asRecord(firstArrayItem(asRecord(payload?.response)?.choices))?.message),
        "usage",
        "payload.response.choices[0].message.usage"
      ),
    },
  };
}

function maybeLogHermesTraceUsageShape(event: unknown, env: NodeJS.ProcessEnv): void {
  if (llmUsageDebugLogged || env.LLM_USAGE_DEBUG !== "1") return;
  llmUsageDebugLogged = true;
  logger.info(summarizeHermesTraceUsageDebugShape(event), "llm_usage_debug_shape");
}

function hermesUsageCandidates(event: unknown): unknown[] {
  const payload = asRecord(event)?.payload;
  const records = [
    event,
    payload,
    nested(payload, "response"),
    nested(payload, "result"),
    nested(payload, "output"),
    nested(payload, "completion"),
    nested(payload, "message"),
    nested(payload, "data"),
    nested(payload, "raw_response"),
    nested(payload, "rawResponse"),
    nested(payload, "llm_response"),
    nested(payload, "llmResponse"),
    nested(nested(payload, "response"), "raw"),
    nested(nested(payload, "result"), "raw"),
    nested(nested(payload, "output"), "raw"),
  ];
  const seen = new Set<unknown>();
  return records.filter((record) => {
    if (!record || seen.has(record)) return false;
    seen.add(record);
    return true;
  });
}

function nested(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function debugPath(record: Record<string, unknown> | undefined, key: string, label = key): Record<string, unknown> {
  if (!record || !(key in record)) return {};
  return { [label]: redactUsageDebugValue(record[key]) };
}

function redactUsageDebugValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const allowedKeys = [
    "model",
    "inputTokens",
    "input_tokens",
    "inputTokenCount",
    "outputTokens",
    "output_tokens",
    "outputTokenCount",
    "promptTokens",
    "prompt_tokens",
    "promptTokenCount",
    "completionTokens",
    "completion_tokens",
    "completionTokenCount",
    "prompt_eval_count",
    "promptEvalCount",
    "eval_count",
    "evalCount",
    "cacheTokens",
    "cache_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "prompt_tokens_details",
    "input_tokens_details",
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((allowedKey) => allowedKey in record)
      .map((allowedKey) => [
        allowedKey,
        asRecord(record[allowedKey]) ? redactUsageDebugValue(record[allowedKey]) : record[allowedKey],
      ])
  );
}

function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function deepString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)?.[key];
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function dateField(value: unknown, key: string): Date | undefined {
  const field = stringField(value, key);
  if (!field) return undefined;
  const date = new Date(field);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
